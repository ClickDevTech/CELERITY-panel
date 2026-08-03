/**
 * ClickHouse access layer for the access-logs pipeline.
 *
 * The panel is a thin gateway: it forwards raw Xray access-log lines to an
 * EXTERNAL ClickHouse (configured by credentials, like an S3 backend) and lets
 * ClickHouse do the heavy lifting (parsing via a materialized view, storage,
 * retention via native TTL, and analytical queries). Nothing analytical runs in
 * the panel process anymore, which keeps it light on weak hardware.
 *
 * Connection settings live in settings.accessLogs.clickhouse; the password is
 * stored AES-encrypted and decrypted here via cryptoService. The HTTP client is
 * a pure-JS package (no native binding), so there is no compile step and no
 * per-query child process.
 *
 * Schema (created idempotently with IF NOT EXISTS):
 *   access_ingest         ENGINE = Null      raw insert point (stores nothing)
 *   access_events         MergeTree + TTL    parsed, queryable events
 *   access_events_mv_vN   MATERIALIZED VIEW  parses raw -> access_events
 *                                            (versioned; see MV_VERSION below)
 */

const logger = require('../../utils/logger');
const cryptoService = require('../cryptoService');

// Lazy handle to the client package so a missing dependency degrades gracefully
// instead of crashing the app at require time.
let createClient = null;
try {
    ({ createClient } = require('@clickhouse/client'));
} catch (e) {
    logger.warn(`[AccessLogs] @clickhouse/client not installed: ${e.message}`);
}

// Cached client keyed by a fingerprint of the connection config, so we rebuild
// only when the admin changes credentials.
let _client = null;
let _clientKey = '';

// Regex that parses a raw Xray access-log line inside ClickHouse (RE2 engine):
// no named groups, explicit capture order:
//   1 ts, 2 src, 3 action, 4 network, 5 dest, 6 route(optional), 7 email(optional)
// The source (group 2) may carry a leading "tcp:"/"udp:" protocol prefix; the
// MV strips it (see src_noproto) so it never leaks into source_ip.
// Example line:
//   2023/11/22 17:01:32 1.2.3.4:1122 accepted tcp:example.com:443 [in -> direct] email: 42
const CH_LINE_RE =
    '^(\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?)\\s+' +
    '(?:from\\s+)?' +
    '(\\S+?)\\s+' +
    '(accepted|rejected|blocked)\\s+' +
    '(tcp|udp)\\s*:\\s*(\\S+?)' +
    '(?:\\s+\\[([^\\]]*)\\])?' +
    '(?:\\s+email:\\s*(\\S+))?' +
    '\\s*$';

// Fallback for connection-level error lines that are NOT access records, e.g.:
//   2026/07/10 17:41:28 from 95.24.24.226:9048 rejected proxy/vless/encoding: invalid request user id: <uuid>
// These carry a timestamp, source and action but no "tcp:/udp:" destination
// (an attacker/scanner hitting an inbound with a bad UUID). Captures:
//   1 ts, 2 src, 3 action. The tail (error text) stays in `raw`.
const CH_ERR_RE =
    '^(\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?)\\s+' +
    '(?:from\\s+)?' +
    '(\\S+?)\\s+' +
    '(accepted|rejected|blocked)(?:\\s|$)';

// Escape a JS string for use inside a single-quoted ClickHouse SQL literal.
// ClickHouse collapses unknown escapes ('\d' -> 'd'), so every backslash must
// be doubled or the inlined regex silently loses all its character classes.
function sqlString(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// The parsing logic lives in the materialized view, so changing the regex or
// the SELECT requires recreating the MV (CREATE ... IF NOT EXISTS would keep
// the stale one). The version is part of the MV name; ensureSchema drops any
// older names listed here. Bump MV_VERSION whenever the MV definition changes
// and append the previous name to LEGACY_MV_NAMES.
const MV_VERSION = 4;
const MV_NAME = `access_events_mv_v${MV_VERSION}`;
const LEGACY_MV_NAMES = ['access_events_mv', 'access_events_mv_v2', 'access_events_mv_v3'];

// ── Config ────────────────────────────────────────────────────────────────

// Settings live in Mongo; cache the resolved connection config briefly so the
// many small dashboard queries do not each hit the settings collection.
let _cfgCache = { cfg: null, at: 0 };
const CFG_TTL_MS = 10 * 1000;

// Read the ClickHouse block from settings and return normalized connection
// fields with the password decrypted. Returns null when not configured.
async function readConfig() {
    const now = Date.now();
    if (now - _cfgCache.at < CFG_TTL_MS) return _cfgCache.cfg;
    const Settings = require('../../models/settingsModel');
    const s = await Settings.get();
    const ch = s?.accessLogs?.clickhouse;
    const cfg = (!ch || !ch.host) ? null : {
        host: String(ch.host).trim(),
        port: Number(ch.port) || (ch.secure ? 8443 : 8123),
        database: String(ch.database || 'default').trim(),
        username: String(ch.username || 'default').trim(),
        password: ch.passwordEncrypted ? cryptoService.decryptSafe(ch.passwordEncrypted) : '',
        secure: !!ch.secure,
    };
    _cfgCache = { cfg, at: now };
    return cfg;
}

function configKey(cfg) {
    return [cfg.host, cfg.port, cfg.database, cfg.username, cfg.secure ? 's' : 'p', cfg.password ? 'pw' : ''].join('|');
}

// Build (or reuse) a client for the current settings. Returns null when the
// feature is not configured or the client package is missing.
async function getClient() {
    if (!createClient) return null;
    const cfg = await readConfig();
    if (!cfg) return null;
    const key = configKey(cfg);
    if (_client && _clientKey === key) return _client;
    // Credentials changed: dispose the old client before building a new one.
    if (_client) {
        try { await _client.close(); } catch (_) { /* ignore */ }
        _client = null;
    }
    const proto = cfg.secure ? 'https' : 'http';
    _client = createClient({
        url: `${proto}://${cfg.host}:${cfg.port}`,
        username: cfg.username,
        password: cfg.password,
        database: cfg.database,
        // Keep the panel light: cap concurrency, disable client-side keep-alive
        // pooling surprises, and let ClickHouse compress responses.
        clickhouse_settings: {},
        compression: { response: true },
        request_timeout: 30000,
    });
    _clientKey = key;
    return _client;
}

// Drop the cached client and config (used after credentials change / for tests).
function reset() {
    if (_client) {
        try { _client.close(); } catch (_) { /* ignore */ }
    }
    _client = null;
    _clientKey = '';
    _cfgCache = { cfg: null, at: 0 };
}

// ── Status ──────────────────────────────────────────────────────────────────

// Is the feature configured with ClickHouse credentials? A settings-read error
// (e.g. DB not reachable) is treated as "not configured" so the processor backs
// off gracefully instead of throwing.
async function isConfigured() {
    try {
        const cfg = await readConfig();
        return !!cfg;
    } catch (_) {
        return false;
    }
}

/**
 * Test an arbitrary connection config WITHOUT touching the cached client or the
 * stored settings, so the admin can verify credentials before saving. When the
 * password is omitted (blank field on an existing config) the caller may pass
 * the already-stored encrypted password via `passwordEncrypted`.
 *
 * @param {{host,port,database,username,password?,passwordEncrypted?,secure}} cfg
 * @returns {Promise<{ok:boolean, error?:string, version?:string}>}
 */
async function testConnection(cfg) {
    if (!createClient) return { ok: false, error: 'client_not_installed' };
    if (!cfg || !cfg.host) return { ok: false, error: 'not_configured' };
    let password = cfg.password || '';
    if (!password && cfg.passwordEncrypted) {
        password = cryptoService.decryptSafe(cfg.passwordEncrypted);
    }
    const secure = !!cfg.secure;
    const port = Number(cfg.port) || (secure ? 8443 : 8123);
    const proto = secure ? 'https' : 'http';
    const client = createClient({
        url: `${proto}://${String(cfg.host).trim()}:${port}`,
        username: String(cfg.username || 'default').trim(),
        password,
        database: String(cfg.database || 'default').trim(),
        request_timeout: 10000,
    });
    try {
        const rs = await client.query({ query: 'SELECT version() AS v', format: 'JSONEachRow' });
        const rows = await rs.json();
        return { ok: true, version: rows && rows[0] && rows[0].v };
    } catch (e) {
        return { ok: false, error: String(e && e.message || e).slice(0, 300) };
    } finally {
        try { await client.close(); } catch (_) { /* ignore */ }
    }
}

// Lightweight connectivity check. Returns { ok, error? }.
async function ping() {
    const client = await getClient();
    if (!client) return { ok: false, error: 'not_configured' };
    try {
        const rs = await client.query({ query: 'SELECT 1 AS ok', format: 'JSONEachRow' });
        await rs.json();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e && e.message || e).slice(0, 300) };
    }
}

// Config + connectivity in one call, used by the read side.
async function isAvailable() {
    if (!(await isConfigured())) return false;
    const p = await ping();
    return p.ok;
}

// ── Schema ────────────────────────────────────────────────────────────────

// DDL statements, parameterized only by retention days (a validated integer, so
// it is safe to inline; ClickHouse does not bind params inside DDL).
//
// Timezone note: Xray writes naive local timestamps; nodes are expected to run
// UTC (standard for servers). Everything is declared/parsed/formatted as UTC
// explicitly so results do not depend on the ClickHouse server timezone.
function schemaStatements(retentionDays) {
    const days = Math.max(1, Math.min(3650, parseInt(retentionDays, 10) || 30));
    return [
        // Raw insert point. Stores nothing itself; the MV consumes each insert.
        `CREATE TABLE IF NOT EXISTS access_ingest (
            node_id String,
            raw String
        ) ENGINE = Null`,

        // Parsed, queryable events with native TTL retention.
        `CREATE TABLE IF NOT EXISTS access_events (
            event_time DateTime('UTC') CODEC(DoubleDelta, ZSTD(1)),
            node_id LowCardinality(String),
            email String CODEC(ZSTD(1)),
            source_ip String CODEC(ZSTD(1)),
            source_port UInt16,
            dest_host String CODEC(ZSTD(1)),
            dest_ip String CODEC(ZSTD(1)),
            dest_port UInt16,
            network LowCardinality(String),
            inbound_tag String CODEC(ZSTD(1)),
            outbound_tag String CODEC(ZSTD(1)),
            action LowCardinality(String),
            raw String CODEC(ZSTD(3)),
            parse_ok UInt8
        ) ENGINE = MergeTree
        PARTITION BY toDate(event_time)
        ORDER BY (event_time, email)
        TTL event_time + INTERVAL ${days} DAY
        SETTINGS non_replicated_deduplication_window = 1000`,

        // Parse raw -> structured on insert. Everything derives from `raw`.
        // Two shapes are recognised: (n) a normal access line and, as a fallback,
        // (ne) a connection-level error line ("from IP rejected <msg>", no
        // destination) which is tagged outbound_tag = 'handshake-error' so the
        // action counters stay accurate and the attacking source IP is visible.
        // A line matching neither still lands with parse_ok = 0 and
        // event_time = now(), so nothing is lost and it stays searchable by raw.
        `CREATE MATERIALIZED VIEW IF NOT EXISTS ${MV_NAME} TO access_events AS
        WITH
            extractGroups(raw, '${sqlString(CH_LINE_RE)}') AS g,
            length(g) AS n,
            extractGroups(raw, '${sqlString(CH_ERR_RE)}') AS ge,
            length(ge) AS ne,
            if(n > 0, g[1], if(ne > 0, ge[1], '')) AS ts_str,
            if(n > 0, g[2], if(ne > 0, ge[2], '')) AS src,
            if(n > 0, g[3], if(ne > 0, ge[3], '')) AS act,
            if(n > 0, g[4], '') AS net,
            if(n > 0, g[5], '') AS dst,
            if(n > 0, g[6], '') AS route,
            if(n > 0, g[7], '') AS mail,
            -- Xray may prefix the source with the inbound protocol
            -- ("from tcp:1.2.3.4:5678" when the outbound is UDP), so strip a
            -- leading tcp:/udp: before splitting host:port. Without this the
            -- same client shows up as both "1.2.3.4" and "tcp:1.2.3.4",
            -- inflating unique-IP counts.
            replaceRegexpOne(src, '^(?:tcp|udp):', '') AS src_noproto,
            -- host:port split from the right (keeps IPv6 host[:port] reasonable)
            if(match(src_noproto, ':\\\\d+$'), replaceRegexpOne(src_noproto, ':(\\\\d+)$', ''), src_noproto) AS src_host,
            toUInt16OrZero(if(match(src_noproto, ':(\\\\d+)$'), extract(src_noproto, ':(\\\\d+)$'), '')) AS src_port,
            if(match(dst, ':\\\\d+$'), replaceRegexpOne(dst, ':(\\\\d+)$', ''), dst) AS dst_host_raw,
            toUInt16OrZero(if(match(dst, ':(\\\\d+)$'), extract(dst, ':(\\\\d+)$'), '')) AS dst_port,
            -- a host that looks like an IPv4/IPv6 literal is stored as dest_ip
            match(dst_host_raw, '^\\\\d{1,3}(\\\\.\\\\d{1,3}){3}$') OR position(dst_host_raw, ':') > 0 AS dst_is_ip,
            trim(splitByString('->', route)[1]) AS in_tag,
            trim(if(length(splitByString('->', route)) > 1, splitByString('->', route)[2], '')) AS out_tag,
            parseDateTimeBestEffortOrZero(replaceAll(ts_str, '/', '-'), 'UTC') AS parsed_time
        SELECT
            if(toUnixTimestamp(parsed_time) = 0, now('UTC'), parsed_time) AS event_time,
            node_id,
            mail AS email,
            src_host AS source_ip,
            src_port AS source_port,
            if(dst_is_ip, '', dst_host_raw) AS dest_host,
            if(dst_is_ip, dst_host_raw, '') AS dest_ip,
            dst_port AS dest_port,
            net AS network,
            in_tag AS inbound_tag,
            if(n > 0, out_tag, if(ne > 0, 'handshake-error', '')) AS outbound_tag,
            act AS action,
            raw,
            toUInt8(n > 0 OR ne > 0) AS parse_ok
        FROM access_ingest`,
    ];
}

// Create the schema if it does not exist. Safe to call repeatedly and on boot.
// Also drops materialized views from older parser versions so their stale
// definitions cannot keep feeding access_events.
async function ensureSchema(retentionDays) {
    const client = await getClient();
    if (!client) throw new Error('clickhouse_not_configured');
    let days = retentionDays;
    if (days == null) {
        const Settings = require('../../models/settingsModel');
        const s = await Settings.get();
        days = s?.accessLogs?.retentionDays;
    }
    for (const name of LEGACY_MV_NAMES) {
        await client.command({ query: `DROP VIEW IF EXISTS ${name}` });
    }
    for (const ddl of schemaStatements(days)) {
        await client.command({ query: ddl });
    }
    logger.info('[AccessLogs] ClickHouse schema ensured');
}

// Apply a new retention window to the events table (called when settings change).
async function applyRetention(retentionDays) {
    const client = await getClient();
    if (!client) throw new Error('clickhouse_not_configured');
    const days = Math.max(1, Math.min(3650, parseInt(retentionDays, 10) || 30));
    await client.command({
        query: `ALTER TABLE access_events MODIFY TTL event_time + INTERVAL ${days} DAY`,
    });
    logger.info(`[AccessLogs] ClickHouse retention set to ${days} day(s)`);
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Insert a batch of raw rows into access_ingest. The materialized view parses
 * them into access_events. Idempotent per batch: the batch id is passed as the
 * insert deduplication token and dedup is explicitly extended to the dependent
 * materialized view — the source table is a Null engine, so only the MV target
 * (access_events, with its non_replicated_deduplication_window) can actually
 * drop a retried block. Matches the pipeline's at-least-once guarantee.
 *
 * @param {Array<{node_id:string, raw:string}>} rows
 * @param {string} batchId  sha256 of the original gzip body (dedup token)
 */
async function insertRaw(rows, batchId) {
    const client = await getClient();
    if (!client) throw new Error('clickhouse_not_configured');
    if (!rows || rows.length === 0) return { inserted: 0 };
    await client.insert({
        table: 'access_ingest',
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: batchId
            ? {
                insert_deduplication_token: String(batchId),
                deduplicate_blocks_in_dependent_materialized_views: 1,
            }
            : {},
    });
    return { inserted: rows.length };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * Run a read-only parameterized query. Parameters use ClickHouse's {name:Type}
 * placeholders; pass values in query_params. Returns { ok, rows } or
 * { ok:false, error }.
 */
async function query(sql, params = {}, opts = {}) {
    const client = await getClient();
    if (!client) return { ok: false, error: 'not_configured' };
    try {
        const rs = await client.query({
            query: sql,
            query_params: params,
            format: 'JSONEachRow',
            clickhouse_settings: {
                max_execution_time: Math.round((opts.timeoutMs || 30000) / 1000),
                // Return 64-bit integers as JSON numbers, not strings, so the
                // dashboard's numeric formatting works without extra coercion.
                output_format_json_quote_64bit_integers: 0,
            },
        });
        const rows = await rs.json();
        return { ok: true, rows };
    } catch (e) {
        return { ok: false, error: String(e && e.message || e).slice(0, 300) };
    }
}

const READONLY_SQL_START = /^(SELECT|WITH|EXPLAIN|DESCRIBE|DESC|SHOW)\b/i;
// Mid-query deny list. Intentionally omits SYSTEM — it would false-positive on
// system.* tables, while bare SYSTEM commands are already rejected by the
// start-keyword check. FORMAT is matched only as an output-format clause so
// the format() SQL function still works.
const READONLY_SQL_DENY = /\b(INSERT|ALTER|DROP|TRUNCATE|DELETE|CREATE|ATTACH|DETACH|RENAME|GRANT|REVOKE|KILL|OPTIMIZE|INTO\s+OUTFILE)\b|\bFORMAT\s+[A-Za-z0-9_]+/i;

/**
 * Lightweight SQL gate for MCP / ad-hoc reads. Not a full parser — rejects
 * multi-statement and obvious mutating keywords. Pair with ClickHouse
 * `readonly=2` so the server blocks writes while still allowing per-query
 * settings (max_result_rows, etc.).
 *
 * @param {string} sql
 * @returns {string} normalized single statement
 * @throws {Error} with message suitable for API responses
 */
function assertReadonlySql(sql) {
    if (typeof sql !== 'string') throw new Error('sql_required');
    let s = sql.trim();
    if (!s) throw new Error('sql_required');
    // Allow a single trailing semicolon; reject anything that looks like
    // a second statement.
    if (s.endsWith(';')) s = s.slice(0, -1).trim();
    if (!s) throw new Error('sql_required');
    if (s.includes(';')) throw new Error('multi_statement_forbidden');
    if (!READONLY_SQL_START.test(s)) throw new Error('only_readonly_sql_allowed');
    if (READONLY_SQL_DENY.test(s)) throw new Error('mutating_sql_forbidden');
    return s;
}

/**
 * Run an ad-hoc read-only query (MCP). Validates SQL, forces ClickHouse
 * readonly mode, and caps result size / runtime.
 *
 * @param {string} sql
 * @param {{ timeoutMs?: number, maxRows?: number }} [opts]
 * @returns {Promise<{ok:true, rows:object[], rowCount:number, truncated:boolean}|{ok:false, error:string}>}
 */
async function queryReadonly(sql, opts = {}) {
    let normalized;
    try {
        normalized = assertReadonlySql(sql);
    } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
    }

    const client = await getClient();
    if (!client) return { ok: false, error: 'not_configured' };

    const timeoutMs = opts.timeoutMs || 30000;
    const maxRows = Math.max(1, Math.min(5000, parseInt(opts.maxRows, 10) || 1000));

    try {
        const rs = await client.query({
            query: normalized,
            format: 'JSONEachRow',
            clickhouse_settings: {
                // readonly=2: block writes/DDL, but still allow changing query
                // settings. readonly=1 forbids setting max_result_rows /
                // result_overflow_mode in the same request.
                readonly: 2,
                max_execution_time: Math.round(timeoutMs / 1000),
                max_result_rows: maxRows,
                result_overflow_mode: 'break',
                output_format_json_quote_64bit_integers: 0,
            },
        });
        const rows = await rs.json();
        const list = Array.isArray(rows) ? rows : [];
        const truncated = list.length >= maxRows;
        return {
            ok: true,
            rows: truncated ? list.slice(0, maxRows) : list,
            rowCount: Math.min(list.length, maxRows),
            truncated,
        };
    } catch (e) {
        return { ok: false, error: String(e && e.message || e).slice(0, 300) };
    }
}

// Delete all stored events (admin purge). TRUNCATE keeps the schema.
async function truncate() {
    const client = await getClient();
    if (!client) throw new Error('clickhouse_not_configured');
    await client.command({ query: 'TRUNCATE TABLE IF EXISTS access_events' });
}

module.exports = {
    CH_LINE_RE,
    CH_ERR_RE,
    readConfig,
    getClient,
    reset,
    isConfigured,
    ping,
    testConnection,
    isAvailable,
    schemaStatements,
    ensureSchema,
    applyRetention,
    insertRaw,
    query,
    assertReadonlySql,
    queryReadonly,
    truncate,
};
