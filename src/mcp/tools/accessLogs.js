/**
 * MCP Tools — ClickHouse access logs (read-only SQL)
 */

const { z } = require('zod');
const clickhouse = require('../../services/accessLogs/clickhouseService');

const MAX_SQL_LEN = 16384;

const queryAccessLogsSchema = z.object({
    sql: z.string().min(1).max(MAX_SQL_LEN).describe(
        'Read-only ClickHouse SQL (SELECT / WITH / EXPLAIN / DESCRIBE / SHOW). Single statement only.'
    ),
});

/**
 * Human-readable schema for the tool description so agents can write queries
 * without a separate describe tool.
 */
const TOOL_DESCRIPTION = [
    'Run a read-only SQL query against ClickHouse access logs (Xray connection events).',
    'Not system/panel logs — use query resource=logs for those.',
    '',
    'Main table: access_events (MergeTree, PARTITION BY toDate(event_time), ORDER BY (event_time, email)).',
    'Columns:',
    '- event_time DateTime UTC — event timestamp',
    '- node_id String — Mongo node id',
    '- email String — Xray user email / user id',
    '- source_ip String, source_port UInt16 — client address',
    '- dest_host String — destination domain; empty string means connect-by-IP (no DNS name)',
    '- dest_ip String — destination IP when host is empty / resolved',
    '- dest_port UInt16',
    '- network LowCardinality — tcp | udp',
    '- inbound_tag String, outbound_tag String — route tags; handshake failures use outbound_tag=handshake-error',
    '- action LowCardinality — accepted | rejected | blocked',
    '- raw String — original access.log line',
    '- parse_ok UInt8 — 1 if the line parsed into structured fields',
    '',
    'Always filter by event_time when possible. Results are capped (default 1000 rows, 30s timeout).',
    'Only SELECT / WITH / EXPLAIN / DESCRIBE / SHOW are allowed.',
].join(' ');

async function queryAccessLogs(args) {
    const parsed = queryAccessLogsSchema.parse(args);

    if (!(await clickhouse.isConfigured())) {
        return { ok: false, error: 'not_configured' };
    }

    return clickhouse.queryReadonly(parsed.sql);
}

module.exports = {
    TOOL_DESCRIPTION,
    queryAccessLogs,
    schemas: { queryAccessLogs: queryAccessLogsSchema },
};
