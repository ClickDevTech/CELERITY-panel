'use strict';

/**
 * Reality Guard — watches the Reality dest of standalone and portal Xray
 * nodes and replaces it automatically once it stops being usable.
 *
 * A dest dies when the site behind it disappears, loses TLS 1.3 / X25519 or
 * its certificate expires or no longer covers the SNI. Missing H2 is only a
 * warning: Xray works without it, but the masquerade is weaker. The guard:
 *   1. checks every dest from the panel on a cron tick;
 *   2. after FAIL_THRESHOLD consecutive failures confirms the verdict from
 *      the node itself over one SSH session, since the node is what actually
 *      connects to the dest. A dest the node can reach is left alone and not
 *      re-confirmed for NODE_CONFIRM_TTL_MS;
 *   3. when the node confirms the failure, picks a replacement in the same
 *      session: the operator's reserve list first, then a /24 scan, every
 *      candidate verified from the node and unused by any other node;
 *   4. writes the new dest/SNI, pushes the config (syncService validates it
 *      with `xray run -test` and restores the previous one on failure) and
 *      reverts the database if the push did not succeed.
 *
 * Only the client-facing inbounds are guarded; the tunnel Reality of cascade
 * links is configured separately and never touched.
 *
 * Only built-in modules are used; the scan reuses sniScanner and the node
 * check relies on the openssl binary present on the node.
 */

const tls = require('tls');
const net = require('net');

const HyNode = require('../models/hyNodeModel');
const NodeSSH = require('./nodeSSH');
const sniScanner = require('./sniScanner');
const webhook = require('./webhookService');
const cache = require('./cacheService');
const nodeSetupLock = require('../utils/nodeSetupLock');
const logger = require('../utils/logger');

const LOG = '[Reality Guard]';

const MODES = ['auto', 'notify', 'off'];
const DEFAULT_MODE = 'auto';

const FAIL_THRESHOLD = 3;
const ROTATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// A node that already failed and was reported is retried at most this often:
// every retry costs an SSH session and possibly a 254-probe scan.
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
// The panel cannot reach the dest but the node can: no new SSH session for this long.
const NODE_CONFIRM_TTL_MS = 6 * 60 * 60 * 1000;
const RESERVE_FAIL_SKIP_MS = 24 * 60 * 60 * 1000;

const CHECK_TIMEOUT_MS = 5000;
const CHECK_CONCURRENCY = 5;
const MAX_SNI_PER_DEST = 5;

const DEFAULT_DEST_PORT = 443;
const MAX_RESERVE_SNIS = 20;

const NODE_CHECK_TIMEOUT_SEC = 6;
const NODE_EXEC_TIMEOUT_MS = 45 * 1000;
const MAX_NODE_CHECK_PAIRS = 40;

const SCAN_PORT = 443;
const SCAN_THREADS = 30;
const SCAN_TIMEOUT_SEC = 5;
const MAX_CANDIDATE_CHECKS = 10;
const SCAN_SPARE_CANDIDATES = 2;

// Circuit breaker: a mass failure means the panel network is down, not the sites.
const BREAKER_MIN_FAILED = 3;
const BREAKER_RATIO = 0.5;

const MAX_TEXT = 300;
const MAX_FAIL_COUNT = 1000;
const MAX_REPORTED_CANDIDATES = 10;

const GUARDED_ROLES = ['standalone', 'portal'];

const NODE_PROJECTION = 'name ip type status active cascadeRole '
    + 'xray.security xray.realityDest xray.realitySni xray.extraInbounds xray.realityGuard';

// ── Pure helpers ─────────────────────────────────────────────────────────────

function normalizeMode(value) {
    return MODES.includes(value) ? value : DEFAULT_MODE;
}

function clip(value) {
    return String(value || '').slice(0, MAX_TEXT);
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Strict hostname check for values coming from remote certificates.
 * Rejects wildcards, IPs, single labels and anything outside [a-z0-9.-].
 */
function isValidHostname(value) {
    return typeof value === 'string' && HOSTNAME_RE.test(value.toLowerCase());
}

function isPrivateIp(host) {
    const version = net.isIP(host);
    if (version === 4) {
        const [a, b] = host.split('.').map(Number);
        return a === 127 || a === 10 || a === 0
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 169 && b === 254);
    }
    if (version === 6) {
        const lower = host.toLowerCase();
        return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
    }
    return false;
}

/**
 * Parse a Reality dest into { host, port }. Returns null for forms the panel
 * cannot check from outside: unix sockets, bare ports (local listener),
 * loopback/private addresses (self-steal setups) and malformed values.
 */
function parseDest(dest) {
    const value = String(dest || '').trim();
    if (!value || value.startsWith('/') || value.startsWith('@')) return null;
    if (/^\d+$/.test(value)) return null;

    let host;
    let portStr;
    const v6 = value.match(/^\[([^\]]+)\]:(\d+)$/);
    if (v6) {
        host = v6[1];
        portStr = v6[2];
    } else {
        const idx = value.lastIndexOf(':');
        if (idx <= 0) return null;
        host = value.slice(0, idx);
        portStr = value.slice(idx + 1);
    }

    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    host = host.toLowerCase();
    if (host === 'localhost' || isPrivateIp(host)) return null;
    if (!net.isIP(host) && !isValidHostname(host)) return null;
    return { host, port };
}

/**
 * Normalize the operator's reserve list: lowercase hostnames only, no IPs,
 * no duplicates, at most MAX_RESERVE_SNIS entries. Accepts a textarea string
 * (any whitespace, comma or semicolon separated) or an array.
 */
function normalizeReserveSnis(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
    const out = [];
    for (const item of raw) {
        const name = String(item || '').trim().toLowerCase()
            .replace(/:443$/, '')
            .replace(/\.$/, '');
        if (!isValidHostname(name) || out.includes(name)) continue;
        out.push(name);
        if (out.length >= MAX_RESERVE_SNIS) break;
    }
    return out;
}

/**
 * Group the Reality inbounds of a node by dest. Every group is checked once
 * and replaced as a whole, so inbounds sharing a dest keep sharing it.
 *
 * @returns {Array<{ key, dest, host, port, snis, inbounds }>} where inbounds
 *          holds 'main' and/or extra inbound indexes.
 */
function collectRealityTargets(xray) {
    const groups = new Map();
    const add = (inbound, ref) => {
        if (!inbound || (inbound.security || 'reality') !== 'reality') return;
        const parsed = parseDest(inbound.realityDest);
        if (!parsed) return;
        const key = `${parsed.host}:${parsed.port}`;
        let group = groups.get(key);
        if (!group) {
            group = { key, dest: key, host: parsed.host, port: parsed.port, snis: [], inbounds: [] };
            groups.set(key, group);
        }
        group.inbounds.push(ref);
        for (const sni of inbound.realitySni || []) {
            const name = String(sni || '').trim().toLowerCase();
            if (name && !group.snis.includes(name)) group.snis.push(name);
        }
    };

    add(xray || {}, 'main');
    (xray?.extraInbounds || []).forEach((extra, idx) => add(extra, idx));

    for (const group of groups.values()) {
        if (group.snis.length === 0 && !net.isIP(group.host)) group.snis.push(group.host);
        group.snis = group.snis.slice(0, MAX_SNI_PER_DEST);
    }
    return [...groups.values()];
}

/**
 * Standalone and portal nodes serve clients directly. Bridges and relays
 * only carry cascade traffic, so their dest is owned by the cascade link.
 */
function isGuardedXray(node) {
    return node?.type === 'xray' && GUARDED_ROLES.includes(node.cascadeRole || 'standalone');
}

/**
 * True when so many dests failed at once that the panel itself is the likely
 * cause; the tick is then discarded without touching any counter.
 */
function breakerTripped(total, failed) {
    return failed >= BREAKER_MIN_FAILED && total > 0 && failed / total >= BREAKER_RATIO;
}

function isReported(status) {
    return status === 'dead' || status === 'no_candidate';
}

function inCooldown(guard, now) {
    const lastRotatedAt = guard.lastRotatedAt ? new Date(guard.lastRotatedAt).getTime() : 0;
    return !!lastRotatedAt && now - lastRotatedAt < ROTATION_COOLDOWN_MS;
}

function formatFailures(failed) {
    return clip(failed.map(f => `${f.dest}: ${f.reason}`).join('; '));
}

function formatWarnings(warnings) {
    const seen = new Set();
    const parts = [];
    for (const w of warnings) {
        const entry = `${w.sni}: ${w.warn}`;
        if (seen.has(entry)) continue;
        seen.add(entry);
        parts.push(entry);
    }
    return clip(parts.join('; '));
}

/**
 * Decide what to do with a node after its dests were checked from the panel.
 * The panel alone never declares a dest dead: at the threshold it asks for a
 * confirmation from the node.
 *
 * @returns {{ set: Object, action: 'none'|'confirm'|'notify', cause?: string }}
 *          `set` holds the realityGuard fields that changed.
 */
function evaluateNode(node, failed, now) {
    const guard = node.xray?.realityGuard || {};
    const mode = normalizeMode(guard.mode);
    const prevStatus = guard.status || 'ok';
    const prevFails = guard.failCount || 0;
    const set = {};

    if (failed.length === 0) {
        if (prevStatus !== 'ok') set.status = 'ok';
        if (prevFails !== 0) set.failCount = 0;
        if (guard.lastError) set.lastError = '';
        return { set, action: 'none' };
    }

    const confirmedAt = guard.nodeConfirmedAt ? new Date(guard.nodeConfirmedAt).getTime() : 0;
    if (confirmedAt && now - confirmedAt < NODE_CONFIRM_TTL_MS) {
        // The node reached these dests recently; the panel network is the odd one out.
        if (prevStatus !== 'ok') set.status = 'ok';
        if (prevFails !== 0) set.failCount = 0;
        const lastError = clip(failed.map(f => `${f.dest}: panel_unreachable`).join('; '));
        if (lastError !== guard.lastError) set.lastError = lastError;
        return { set, action: 'none' };
    }

    const failCount = Math.min(prevFails + 1, MAX_FAIL_COUNT);
    set.failCount = failCount;
    const lastError = formatFailures(failed);
    if (lastError !== guard.lastError) set.lastError = lastError;

    if (failCount < FAIL_THRESHOLD) {
        if (prevStatus !== 'failing') set.status = 'failing';
        return { set, action: 'none' };
    }

    if (node.status === 'offline') {
        if (!isReported(prevStatus)) set.status = 'dead';
        return { set, action: isReported(prevStatus) ? 'none' : 'notify', cause: 'node_offline' };
    }

    // Already reported: only auto mode keeps retrying, and not during the cooldown.
    if (isReported(prevStatus) && (mode !== 'auto' || inCooldown(guard, now))) {
        return { set, action: 'none' };
    }

    return { set, action: 'confirm' };
}

/**
 * Decide what to do once the node confirmed (or could not refute) the failure.
 *
 * @returns {{ set: Object, action: 'none'|'notify'|'rotate', cause?: string }}
 */
function decideAfterConfirm(node, now) {
    const guard = node.xray?.realityGuard || {};
    const reported = isReported(guard.status);
    const markDead = cause => ({
        set: reported ? {} : { status: 'dead' },
        action: reported ? 'none' : 'notify',
        cause,
    });

    if (normalizeMode(guard.mode) === 'notify') return markDead('notify_mode');
    if (inCooldown(guard, now)) return markDead('cooldown');
    return { set: {}, action: 'rotate' };
}

/**
 * Domains already taken by any node or cascade link. A replacement must not
 * reuse them, otherwise one dead site takes several nodes down at once.
 */
function collectUsedDomains(nodes, links) {
    const used = new Set();
    const addDest = (dest) => {
        const parsed = parseDest(dest);
        if (parsed) used.add(parsed.host);
    };
    const addSnis = (snis) => {
        for (const sni of snis || []) {
            const name = String(sni || '').trim().toLowerCase();
            if (name) used.add(name);
        }
    };
    for (const node of nodes || []) {
        const xray = node.xray || {};
        addDest(xray.realityDest);
        addSnis(xray.realitySni);
        for (const extra of xray.extraInbounds || []) {
            addDest(extra.realityDest);
            addSnis(extra.realitySni);
        }
    }
    for (const link of links || []) {
        addDest(link.realityDest);
        addSnis(link.realitySni);
    }
    return used;
}

/**
 * Reserve domains worth checking, in the operator's order: not used by any
 * node and not failed within RESERVE_FAIL_SKIP_MS.
 */
function pickReserveCandidates(guard, used, now) {
    const failedAt = new Map((guard?.reserveFailed || [])
        .map(f => [f.domain, f.at ? new Date(f.at).getTime() : 0]));
    return normalizeReserveSnis(guard?.reserveSnis).filter((domain) => {
        if (used.has(domain)) return false;
        const at = failedAt.get(domain);
        return !(at && now - at < RESERVE_FAIL_SKIP_MS);
    });
}

/**
 * Fold fresh reserve check results into the stored failure list. Entries for
 * domains no longer in the list, expired entries and domains that passed are
 * dropped, so the list stays bounded by MAX_RESERVE_SNIS.
 *
 * @param {Object} guard
 * @param {Map<string, {ok: boolean, reason?: string}>} checked
 * @param {number} now
 */
function mergeReserveFailed(guard, checked, now) {
    const allowed = new Set(normalizeReserveSnis(guard?.reserveSnis));
    const out = [];
    for (const f of guard?.reserveFailed || []) {
        if (!allowed.has(f.domain) || checked.has(f.domain)) continue;
        if (!f.at || now - new Date(f.at).getTime() >= RESERVE_FAIL_SKIP_MS) continue;
        out.push({ domain: f.domain, at: f.at, reason: f.reason });
    }
    for (const [domain, result] of checked) {
        if (!allowed.has(domain) || result.ok) continue;
        out.push({ domain, at: new Date(now), reason: clip(result.reason).slice(0, 40) });
    }
    return out;
}

/**
 * Filter raw scan results down to candidates worth a strict check, best ping first.
 */
function filterScanResults(results, used, nodeIp) {
    const seen = new Set();
    return [...(results || [])]
        .sort((a, b) => (a.ping || 0) - (b.ping || 0))
        .map(r => ({ ...r, domain: String(r.domain || '').toLowerCase() }))
        .filter((r) => {
            if (!isValidHostname(r.domain)) return false;
            if (r.ip === nodeIp) return false;
            if (used.has(r.domain) || seen.has(r.domain)) return false;
            seen.add(r.domain);
            return true;
        });
}

/**
 * Build the Mongo filter/$set pair that swaps the dest of every inbound in
 * the given groups. The filter pins the old values so a concurrent manual
 * edit makes the update a no-op instead of being overwritten.
 */
function buildDestUpdate(nodeId, replacements, { revert = false } = {}) {
    const filter = { _id: nodeId };
    const set = {};
    for (const r of replacements) {
        for (const ref of r.target.inbounds) {
            const base = ref === 'main' ? 'xray' : `xray.extraInbounds.${ref}`;
            const from = revert ? r.next : r.prev[String(ref)];
            const to = revert ? r.prev[String(ref)] : r.next;
            filter[`${base}.realityDest`] = from.dest;
            set[`${base}.realityDest`] = to.dest;
            set[`${base}.realitySni`] = to.sni;
        }
    }
    return { filter, set };
}

// ── TLS check from the panel ─────────────────────────────────────────────────

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME']);
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT']);

function classifyError(err) {
    const code = String(err?.code || '');
    if (DNS_CODES.has(code)) return 'dns';
    if (CONNECT_CODES.has(code)) return 'connect';
    if (code === 'CERT_HAS_EXPIRED') return 'cert_expired';
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'cert_name';
    if (/CERT|SELF_SIGNED|UNABLE_TO|DEPTH_ZERO/.test(code)) return 'cert_invalid';
    return 'tls';
}

/**
 * One strict handshake: TLS 1.3 only, X25519 only and a certificate that
 * validates for `servername`. H2 is requested; its absence is a warning.
 */
function tlsHandshake(host, port, servername, timeoutMs = CHECK_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;
        let socket = null;
        let timer = null;
        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (socket) socket.destroy();
            resolve(result);
        };

        timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs + 1000);
        timer.unref?.();

        try {
            socket = tls.connect({
                host,
                port,
                servername: net.isIP(servername) ? undefined : servername,
                ALPNProtocols: ['h2'],
                minVersion: 'TLSv1.3',
                maxVersion: 'TLSv1.3',
                ecdhCurve: 'X25519',
                rejectUnauthorized: true,
            });
        } catch (err) {
            done({ ok: false, reason: classifyError(err) });
            return;
        }

        socket.setTimeout(timeoutMs, () => done({ ok: false, reason: 'timeout' }));
        socket.once('secureConnect', () => {
            if (socket.getProtocol() !== 'TLSv1.3') return done({ ok: false, reason: 'tls_version' });
            if (socket.alpnProtocol !== 'h2') return done({ ok: true, warn: 'no_h2' });
            done({ ok: true });
        });
        socket.once('error', err => done({ ok: false, reason: classifyError(err) }));
    });
}

/**
 * Check a dest against every SNI it serves. `memo` dedupes identical
 * host:port|sni handshakes within one tick.
 *
 * @returns {{ ok: boolean, reason?: string, sni?: string, warnings?: Array<{sni, warn}> }}
 */
async function checkDest(target, memo = new Map(), timeoutMs = CHECK_TIMEOUT_MS) {
    const names = target.snis.length ? target.snis : [target.host];
    const warnings = [];
    for (const sni of names) {
        const key = `${target.host}:${target.port}|${sni}`;
        if (!memo.has(key)) memo.set(key, tlsHandshake(target.host, target.port, sni, timeoutMs));
        const result = await memo.get(key);
        if (!result.ok) return { ok: false, reason: result.reason, sni };
        if (result.warn) warnings.push({ sni, warn: result.warn });
    }
    return warnings.length ? { ok: true, warnings } : { ok: true };
}

async function runLimited(items, limit, worker) {
    let idx = 0;
    const slots = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: slots }, async () => {
        while (idx < items.length) {
            const i = idx++;
            await worker(items[i]);
        }
    }));
}

// ── TLS check from the node ──────────────────────────────────────────────────

const OUTPUT_FILTER = 'New, |Protocol *:|Verify return code|ALPN|errno|refused|unreachable|lookup|getaddrinfo|not known|unknown option|use -help';

function isSafeHost(value) {
    return isValidHostname(value) || net.isIP(value) !== 0;
}

/**
 * Only values that passed the hostname/IP/port checks reach the script, so
 * single quotes are enough to keep the shell from interpreting them.
 */
function isSafePair(pair) {
    return isSafeHost(pair.host) && isSafeHost(pair.sni)
        && Number.isInteger(pair.port) && pair.port >= 1 && pair.port <= 65535;
}

/**
 * Build one shell script that runs every openssl check on the node in
 * parallel and prints a marked block per pair. Unsafe pairs are omitted.
 */
function buildNodeCheckScript(pairs) {
    const lines = [
        "command -v openssl >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 || { echo '@@RG_NO_OPENSSL'; exit 0; }",
        'rg_check() {',
        '  if [ "$4" = ip ]; then',
        `    o=$(timeout ${NODE_CHECK_TIMEOUT_SEC} openssl s_client -connect "$2" -verify_ip "$3" -tls1_3 -groups X25519 -alpn h2 </dev/null 2>&1)`,
        '  else',
        `    o=$(timeout ${NODE_CHECK_TIMEOUT_SEC} openssl s_client -connect "$2" -servername "$3" -verify_hostname "$3" -tls1_3 -groups X25519 -alpn h2 </dev/null 2>&1)`,
        '  fi',
        '  c=$?',
        `  printf '@@RG %s %s\\n%s\\n@@RG_END\\n' "$1" "$c" "$(printf '%s\\n' "$o" | grep -E -i '${OUTPUT_FILTER}' | head -n 12)"`,
        '}',
    ];
    let count = 0;
    pairs.forEach((pair, i) => {
        if (!isSafePair(pair)) return;
        const connect = net.isIP(pair.host) === 6 ? `[${pair.host}]:${pair.port}` : `${pair.host}:${pair.port}`;
        const kind = net.isIP(pair.sni) ? 'ip' : 'host';
        lines.push(`rg_check ${i} '${connect}' '${pair.sni}' ${kind} &`);
        count++;
    });
    if (count === 0) return null;
    lines.push('wait');
    return lines.join('\n');
}

/**
 * Classify the filtered openssl output of one pair.
 */
function classifyNodeCheck(code, text) {
    if (/unknown option|use -help/i.test(text)) return { ok: false, reason: 'unsupported' };
    if (code === 124) return { ok: false, reason: 'timeout' };
    const tls13 = /New, TLSv1\.3|Protocol\s*:\s*TLSv1\.3/.test(text);
    if (!tls13) {
        if (/lookup|getaddrinfo|not known/i.test(text)) return { ok: false, reason: 'dns' };
        if (/refused|errno|unreachable/i.test(text)) return { ok: false, reason: 'connect' };
        return { ok: false, reason: 'tls' };
    }
    const verify = text.match(/Verify return code:\s*(\d+)/);
    const verifyCode = verify ? Number(verify[1]) : -1;
    if (verifyCode === 62) return { ok: false, reason: 'cert_name' };
    if (verifyCode === 10) return { ok: false, reason: 'cert_expired' };
    if (verifyCode !== 0) return { ok: false, reason: 'cert_invalid' };
    return /ALPN protocol:\s*h2\b/.test(text) ? { ok: true } : { ok: true, warn: 'no_h2' };
}

/**
 * Parse the script output into index → result. Returns null when the node
 * cannot run the check (no openssl, or a build without TLS 1.3 options).
 */
function parseNodeCheckOutput(stdout) {
    const output = String(stdout || '');
    if (output.includes('@@RG_NO_OPENSSL')) return null;
    const results = new Map();
    const re = /@@RG (\d+) (\d+)\n([\s\S]*?)@@RG_END/g;
    let m;
    while ((m = re.exec(output)) !== null) {
        const code = Number(m[2]);
        // 127: the node has no timeout/openssl binary, so the check never ran.
        if (code === 127) return null;
        const result = classifyNodeCheck(code, m[3]);
        if (result.reason === 'unsupported') return null;
        results.set(Number(m[1]), result);
    }
    return results;
}

function execWithTimeout(ssh, command, timeoutMs) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`node check timed out after ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
    });
    return Promise.race([ssh.exec(command), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Check targets from the node in one SSH exec.
 *
 * @returns {Promise<Map<string, {ok, reason?, sni?, warnings?}>|null>} keyed
 *          by target key, or null when the node could not run the check.
 */
async function checkFromNode(ssh, targets) {
    const pairs = [];
    for (const t of targets) {
        for (const sni of (t.snis.length ? t.snis : [t.host])) {
            pairs.push({ key: t.key, host: t.host, port: t.port, sni });
        }
    }
    const checked = pairs.slice(0, MAX_NODE_CHECK_PAIRS);
    const script = buildNodeCheckScript(checked);
    if (!script) return null;

    let parsed;
    try {
        const res = await execWithTimeout(ssh, script, NODE_EXEC_TIMEOUT_MS);
        parsed = parseNodeCheckOutput(res?.stdout);
    } catch (err) {
        logger.warn(`${LOG} node check failed: ${err.message}`);
        return null;
    }
    if (!parsed) return null;

    const out = new Map();
    pairs.forEach((pair, i) => {
        const prev = out.get(pair.key) || { ok: true, warnings: [] };
        if (!prev.ok) return;
        let result = parsed.get(i);
        if (!result) result = { ok: false, reason: isSafePair(pair) && i < checked.length ? 'timeout' : 'invalid' };
        if (!result.ok) {
            out.set(pair.key, { ok: false, reason: result.reason, sni: pair.sni });
            return;
        }
        if (result.warn) prev.warnings.push({ sni: pair.sni, warn: result.warn });
        out.set(pair.key, prev);
    });
    return out;
}

async function openNodeSession(node) {
    const ssh = new NodeSSH(node);
    try {
        await ssh.connect();
        return ssh;
    } catch (err) {
        logger.warn(`${LOG} ${node.name}: SSH connection failed, node check skipped: ${err.message}`);
        try { ssh.disconnect(); } catch (_) { /* already closed */ }
        return null;
    }
}

function hasSshCredentials(node) {
    return !!(node?.ssh?.password || node?.ssh?.privateKey);
}

// ── Notifications ────────────────────────────────────────────────────────────

function emitDead(node, failed, cause, candidates = []) {
    for (const f of failed) {
        const payload = {
            nodeId: String(node._id),
            name: node.name,
            dest: f.dest,
            reason: f.reason,
            cause,
        };
        if (candidates.length) payload.candidates = candidates.slice(0, MAX_REPORTED_CANDIDATES);
        webhook.emit(webhook.EVENTS.NODE_REALITY_DEST_DEAD, payload);
    }
}

// ── Rotation ─────────────────────────────────────────────────────────────────

const _lastAttemptAt = new Map();

async function loadUsedDomains() {
    const CascadeLink = require('../models/cascadeLinkModel');
    const [nodes, links] = await Promise.all([
        HyNode.find({ type: 'xray' })
            .select('xray.realityDest xray.realitySni xray.extraInbounds.realityDest xray.extraInbounds.realitySni')
            .lean(),
        CascadeLink.find({}).select('realityDest realitySni').lean(),
    ]);
    return collectUsedDomains(nodes, links);
}

/**
 * Scan the node /24 and return domains that pass the strict panel check,
 * a couple more than needed so the node check can still reject some.
 */
async function scanCandidates(node, needed, used, memo) {
    const scanned = await sniScanner.scanRange({
        ip: node.ip,
        port: SCAN_PORT,
        threads: SCAN_THREADS,
        timeout: SCAN_TIMEOUT_SEC,
    });

    const picked = [];
    const candidates = filterScanResults(scanned, used, node.ip).slice(0, MAX_CANDIDATE_CHECKS);
    for (const candidate of candidates) {
        if (picked.length >= needed + SCAN_SPARE_CANDIDATES) break;
        const result = await checkDest({ host: candidate.domain, port: SCAN_PORT, snis: [candidate.domain] }, memo);
        if (result.ok) picked.push(candidate.domain);
    }
    return picked;
}

/**
 * Verify candidate domains, from the node when a session is open and the
 * panel otherwise. Domain → { ok, reason? }.
 */
async function verifyCandidates(domains, ssh, memo) {
    const targets = domains.map(d => ({ key: d, host: d, port: DEFAULT_DEST_PORT, snis: [d] }));
    if (ssh) {
        const res = await checkFromNode(ssh, targets);
        if (res) return res;
    }
    const out = new Map();
    for (const t of targets) out.set(t.key, await checkDest(t, memo));
    return out;
}

async function setGuard(nodeId, fields) {
    const set = {};
    for (const [k, v] of Object.entries(fields)) set[`xray.realityGuard.${k}`] = v;
    await HyNode.updateOne({ _id: nodeId }, { $set: set });
}

/**
 * Replace the failed dests of one node. The caller holds the node lock.
 * Never throws.
 */
async function rotate(node, fresh, failed, ssh, now = Date.now()) {
    const nodeId = String(node._id);
    const syncService = require('./syncService');
    const plain = fresh.toObject?.() || fresh;
    const guard = plain.xray?.realityGuard || {};

    if (!hasSshCredentials(plain)) {
        logger.warn(`${LOG} ${node.name}: no SSH credentials, cannot push a new dest`);
        await setGuard(nodeId, { status: 'dead' });
        if (!isReported(guard.status)) emitDead(node, failed, 'no_ssh');
        return;
    }

    const current = new Map(collectRealityTargets(plain.xray).map(t => [t.key, t]));
    const targets = failed.map(f => current.get(f.key)).filter(Boolean);
    if (targets.length === 0) return;

    const used = await loadUsedDomains();
    for (const t of targets) used.add(t.host);
    const memo = new Map();
    const domains = [];
    const rejected = [];

    const reserve = pickReserveCandidates(guard, used, now);
    let reserveFailed = null;
    if (reserve.length) {
        logger.info(`${LOG} ${node.name}: checking ${reserve.length} reserve SNI(s)`);
        const checked = await verifyCandidates(reserve, ssh, memo);
        for (const domain of reserve) {
            const r = checked.get(domain);
            if (r?.ok) domains.push(domain);
            else rejected.push({ domain, reason: r?.reason || 'timeout' });
        }
        reserveFailed = mergeReserveFailed(guard, checked, now);
    }

    if (domains.length < targets.length && sniScanner.isValidIpv4(node.ip)) {
        logger.info(`${LOG} ${node.name}: scanning ${node.ip}/24 for ${targets.length - domains.length} replacement(s)`);
        for (const d of domains) used.add(d);
        const scanned = await scanCandidates(node, targets.length - domains.length, used, memo);
        if (scanned.length) {
            const checked = await verifyCandidates(scanned, ssh, memo);
            for (const domain of scanned) {
                const r = checked.get(domain);
                if (r?.ok) domains.push(domain);
                else rejected.push({ domain, reason: r?.reason || 'timeout' });
            }
        }
    }

    if (domains.length === 0) {
        logger.warn(`${LOG} ${node.name}: no usable replacement found`);
        const fields = { status: 'no_candidate' };
        if (reserveFailed) fields.reserveFailed = reserveFailed;
        await setGuard(nodeId, fields);
        await cache.invalidateNodes();
        if (guard.status !== 'no_candidate') emitDead(node, failed, 'no_candidate', rejected);
        return;
    }

    const replacements = targets.slice(0, domains.length).map((target, i) => {
        const prev = {};
        for (const ref of target.inbounds) {
            const inbound = ref === 'main' ? plain.xray : plain.xray.extraInbounds[ref];
            prev[String(ref)] = { dest: inbound.realityDest, sni: [...(inbound.realitySni || [])] };
        }
        return { target, prev, next: { dest: `${domains[i]}:${DEFAULT_DEST_PORT}`, sni: [domains[i]] } };
    });

    const apply = buildDestUpdate(fresh._id, replacements);
    const res = await HyNode.updateOne(apply.filter, { $set: apply.set });
    if (!res.matchedCount) {
        logger.warn(`${LOG} ${node.name}: dest changed concurrently, rotation skipped`);
        return;
    }

    const updated = await HyNode.findById(nodeId);
    const report = { applied: false };
    let pushed = false;
    try {
        pushed = await syncService.updateXrayNodeConfig(updated, { lockHeld: true, report });
    } catch (err) {
        logger.error(`${LOG} ${node.name}: config push failed: ${err.message}`);
    }

    // Reverting the database while the node already runs the new dest
    // would publish the dead SNI and bring it back on the next sync.
    if (!pushed && report.applied) {
        logger.warn(`${LOG} ${node.name}: new config is running but agent health was not confirmed; keeping the new dest`);
        pushed = true;
    }

    if (!pushed) {
        const revert = buildDestUpdate(fresh._id, replacements, { revert: true });
        await HyNode.updateOne(revert.filter, { $set: revert.set });
        const fields = { status: 'dead', lastError: clip('rotation rolled back: config push failed') };
        if (reserveFailed) fields.reserveFailed = reserveFailed;
        await setGuard(nodeId, fields);
        await cache.invalidateNodes();
        logger.error(`${LOG} ${node.name}: rotation rolled back`);
        if (guard.status !== 'dead') emitDead(node, failed, 'rollback');
        return;
    }

    const summary = replacements.map(r => r.target.dest).join(', ');
    const nextSummary = replacements.map(r => r.next.dest).join(', ');
    const fields = {
        status: 'ok',
        failCount: 0,
        lastError: '',
        warning: '',
        nodeConfirmedAt: null,
        lastRotatedAt: new Date(now),
        lastRotatedFrom: clip(summary),
        lastRotatedTo: clip(nextSummary),
    };
    if (reserveFailed) fields.reserveFailed = reserveFailed;
    await setGuard(nodeId, fields);
    _lastAttemptAt.delete(nodeId);
    const { invalidateNodesCache } = require('../utils/helpers');
    await invalidateNodesCache();

    const reasons = new Map(failed.map(f => [f.key, f.reason]));
    for (const r of replacements) {
        logger.info(`${LOG} ${node.name}: ${r.target.dest} -> ${r.next.dest} (${reasons.get(r.target.key)})`);
        webhook.emit(webhook.EVENTS.NODE_REALITY_DEST_ROTATED, {
            nodeId,
            name: node.name,
            oldDest: r.target.dest,
            newDest: r.next.dest,
            newSni: r.next.sni,
            reason: reasons.get(r.target.key) || '',
        });
    }
}

/**
 * Confirm a panel-side failure from the node and act on the verdict:
 * leave the dest alone, report it or rotate it. One SSH session serves the
 * confirmation and the candidate checks. Never throws.
 */
async function handleIncident(node, failed, now = Date.now()) {
    const nodeId = String(node._id);
    if (!nodeSetupLock.acquire(nodeId, 'Reality dest check')) {
        logger.info(`${LOG} ${node.name}: busy (${nodeSetupLock.holder(nodeId)}), check postponed`);
        return;
    }

    let ssh = null;
    try {
        const fresh = await HyNode.findById(nodeId);
        if (!fresh || !isGuardedXray(fresh)) return;
        _lastAttemptAt.set(nodeId, now);

        const plain = fresh.toObject?.() || fresh;
        const current = new Map(collectRealityTargets(plain.xray).map(t => [t.key, t]));
        let stillFailed = failed.filter(f => current.has(f.key));
        if (stillFailed.length === 0) return;

        let nodeCheckUnavailable = false;
        if (hasSshCredentials(plain)) ssh = await openNodeSession(fresh);
        if (ssh) {
            const targets = stillFailed.map(f => current.get(f.key));
            const verdict = await checkFromNode(ssh, targets);
            if (verdict) {
                const alive = targets.filter(t => verdict.get(t.key)?.ok);
                stillFailed = stillFailed
                    .filter(f => !verdict.get(f.key)?.ok)
                    .map(f => ({ ...f, reason: verdict.get(f.key)?.reason || f.reason }));

                if (stillFailed.length === 0) {
                    const warnings = alive.flatMap(t => verdict.get(t.key).warnings || []);
                    logger.info(`${LOG} ${node.name}: node reaches ${alive.map(t => t.dest).join(', ')}, panel-side failure ignored`);
                    await setGuard(nodeId, {
                        status: 'ok',
                        failCount: 0,
                        lastError: clip(alive.map(t => `${t.dest}: panel_unreachable`).join('; ')),
                        warning: formatWarnings(warnings),
                        nodeConfirmedAt: new Date(now),
                    });
                    await cache.invalidateNodes();
                    return;
                }
            } else {
                nodeCheckUnavailable = true;
            }
        } else if (hasSshCredentials(plain)) {
            nodeCheckUnavailable = true;
        }

        const lastError = clip(formatFailures(stillFailed) + (nodeCheckUnavailable ? '; node_check_unavailable' : ''));
        const decision = decideAfterConfirm(plain, now);
        await setGuard(nodeId, { ...decision.set, lastError });
        if ('status' in decision.set) await cache.invalidateNodes();

        if (decision.action === 'notify') emitDead(node, stillFailed, decision.cause);
        if (decision.action === 'rotate') await rotate(node, fresh, stillFailed, ssh, now);
    } catch (err) {
        logger.error(`${LOG} ${node.name}: check failed: ${err.message}`);
    } finally {
        if (ssh) {
            try { ssh.disconnect(); } catch (_) { /* already closed */ }
        }
        nodeSetupLock.release(nodeId);
    }
}

// ── Cron tick ────────────────────────────────────────────────────────────────

let _running = false;

async function tick(now = Date.now()) {
    const nodes = (await HyNode.find({ type: 'xray', active: true }).select(NODE_PROJECTION).lean())
        .filter(isGuardedXray);

    const watched = [];
    const resetOps = [];
    for (const node of nodes) {
        const guard = node.xray?.realityGuard || {};
        if (normalizeMode(guard.mode) === 'off') {
            if ((guard.status && guard.status !== 'ok') || guard.failCount || guard.warning) {
                resetOps.push({ updateOne: {
                    filter: { _id: node._id },
                    update: { $set: {
                        'xray.realityGuard.status': 'ok',
                        'xray.realityGuard.failCount': 0,
                        'xray.realityGuard.lastError': '',
                        'xray.realityGuard.warning': '',
                    } },
                } });
            }
            continue;
        }
        const targets = collectRealityTargets(node.xray);
        if (targets.length) watched.push({ node, targets });
    }

    // One check per unique dest across all nodes.
    const unique = new Map();
    for (const { targets } of watched) {
        for (const t of targets) {
            const known = unique.get(t.key);
            if (!known) unique.set(t.key, { ...t, snis: [...t.snis] });
            else for (const s of t.snis) if (!known.snis.includes(s)) known.snis.push(s);
        }
    }

    const memo = new Map();
    const results = new Map();
    await runLimited([...unique.values()], CHECK_CONCURRENCY, async (target) => {
        results.set(target.key, await checkDest(target, memo));
    });

    const failedTotal = [...results.values()].filter(r => !r.ok).length;
    if (breakerTripped(results.size, failedTotal)) {
        logger.warn(`${LOG} ${failedTotal}/${results.size} dests failed at once, assuming a panel network issue; tick discarded`);
        if (resetOps.length) await HyNode.bulkWrite(resetOps, { ordered: false });
        return;
    }

    const ops = [...resetOps];
    const notify = [];
    const incidents = [];
    const checkedAt = new Date(now);
    let statusChanged = resetOps.length > 0;

    for (const { node, targets } of watched) {
        const guard = node.xray?.realityGuard || {};
        const failed = [];
        const warnings = [];
        for (const t of targets) {
            const r = results.get(t.key);
            if (r && !r.ok) failed.push({ key: t.key, dest: t.dest, reason: r.reason });
            for (const w of r?.warnings || []) if (t.snis.includes(w.sni)) warnings.push(w);
        }

        const decision = evaluateNode(node, failed, now);
        if ('status' in decision.set) statusChanged = true;

        const $set = { 'xray.realityGuard.lastCheckAt': checkedAt };
        for (const [k, v] of Object.entries(decision.set)) $set[`xray.realityGuard.${k}`] = v;
        // A failed check says nothing about H2, so the warning is refreshed only on a clean pass.
        if (failed.length === 0) {
            const warning = formatWarnings(warnings);
            if (warning !== (guard.warning || '')) {
                $set['xray.realityGuard.warning'] = warning;
                statusChanged = true;
            }
        }
        ops.push({ updateOne: { filter: { _id: node._id }, update: { $set } } });

        if (decision.action === 'notify') notify.push({ node, failed, cause: decision.cause });
        if (decision.action === 'confirm') {
            const lastAttempt = _lastAttemptAt.get(String(node._id)) || 0;
            // Every incident costs an SSH session and possibly a /24 scan, so
            // a node that was already handled this hour is not touched again.
            if (now - lastAttempt >= RETRY_INTERVAL_MS) incidents.push({ node, failed });
        }
        if (failed.length) {
            logger.warn(`${LOG} ${node.name}: ${failed.map(f => `${f.dest} ${f.reason}`).join(', ')} (${decision.set.failCount ?? 0}/${FAIL_THRESHOLD})`);
        }
    }

    if (ops.length) await HyNode.bulkWrite(ops, { ordered: false });
    if (statusChanged) await cache.invalidateNodes();

    for (const n of notify) emitDead(n.node, n.failed, n.cause);

    // Sequential on purpose: at most one SSH session and one /24 scan at a time.
    for (const i of incidents) await handleIncident(i.node, i.failed, now);
}

/**
 * Cron entry point. Never throws; overlapping ticks are skipped.
 */
async function checkAll() {
    if (_running) {
        logger.warn(`${LOG} previous tick still running, skipped`);
        return;
    }
    _running = true;
    try {
        await tick();
    } catch (err) {
        logger.error(`${LOG} tick failed: ${err.message}`);
    } finally {
        _running = false;
    }
}

module.exports = {
    checkAll,
    checkDest,
    normalizeReserveSnis,
    MAX_RESERVE_SNIS,
    RESERVE_FAIL_SKIP_MS,
    // Exposed for tests.
    _internals: {
        MODES,
        FAIL_THRESHOLD,
        ROTATION_COOLDOWN_MS,
        NODE_CONFIRM_TTL_MS,
        RESERVE_FAIL_SKIP_MS,
        normalizeMode,
        isValidHostname,
        parseDest,
        collectRealityTargets,
        isGuardedXray,
        breakerTripped,
        evaluateNode,
        decideAfterConfirm,
        collectUsedDomains,
        pickReserveCandidates,
        mergeReserveFailed,
        filterScanResults,
        buildDestUpdate,
        classifyError,
        buildNodeCheckScript,
        classifyNodeCheck,
        parseNodeCheckOutput,
        _lastAttemptAt,
        RETRY_INTERVAL_MS,
        checkFromNode,
        tick,
        rotate,
        handleIncident,
    },
};
