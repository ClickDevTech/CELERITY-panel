/**
 * MCP Tools — external diagnostic probes
 *
 * Exposes what probes observed from the outside, which is the one thing the
 * panel cannot answer from its own control-plane data: whether a real client
 * behind a given ISP can still connect to a node.
 */

const { z } = require('zod');
const Probe = require('../../models/probeModel');
const HyNode = require('../../models/hyNodeModel');
const ProbeResult = require('../../models/probeResultModel');
const ProbeTargetResult = require('../../models/probeTargetResultModel');
const { getSettings } = require('../../utils/helpers');

const queryProbesSchema = z.object({
    view: z.enum(['probes', 'nodes', 'targets']).default('probes')
        .describe('probes = vantage points and their liveness; nodes = latest verdict per node inbound; targets = checklist resources per node'),
    nodeId: z.string().optional().describe('Restrict node/target views to a single node'),
    probeId: z.string().optional().describe('Restrict results to a single probe'),
    hours: z.number().int().min(1).max(720).default(1)
        .describe('Look-back window in hours. Windows longer than 24h read hourly rollups.'),
    limit: z.number().int().min(1).max(500).default(100),
});

const TOOL_DESCRIPTION = [
    'Inspect results from external diagnostic probes.',
    'A probe is an operator-installed agent that dials nodes through a real sing-box core using a hidden subscription,',
    'so it reports whether a client can actually connect rather than whether the node agent is alive.',
    '',
    'Failure codes and what each one means:',
    '- net_unreachable: TCP/UDP never arrives — the address or port is filtered, or the node is down',
    '- handshake_failed: TLS/REALITY does not complete — dead masquerade destination, wrong SNI, or DPI interference',
    '- auth_rejected: the tunnel stands but credentials are refused — a sync problem',
    '- tunnel_no_data: authenticated but no data flows — broken outbound or ACL',
    '- degraded: works, but slowly',
    '- core_down: the probe own client core was not running — says nothing about the node, fix the probe host',
    'Target results are separate: a blocked resource means a geo-block or a blacklisted exit address, not an outage.',
    '',
    'Views: probes (vantage points), nodes (latest verdict per inbound), targets (checklist per node).',
].join(' ');

/**
 * Windows shorter than a day read raw data; longer ranges use hourly rollups so
 * a month-wide question never aggregates raw documents.
 */
function bucketFor(hours) {
    return hours > 24 ? 'hourly' : 'raw';
}

async function queryProbes(args) {
    const parsed = queryProbesSchema.parse(args || {});

    const settings = await getSettings();
    if (!settings?.probes?.enabled) {
        return { enabled: false, probes: [] };
    }

    const since = new Date(Date.now() - parsed.hours * 60 * 60 * 1000);
    const bucket = bucketFor(parsed.hours);
    const reportSec = settings.probes.reportIntervalSec || 900;

    if (parsed.view === 'probes') {
        const probes = await Probe.listProbes();
        return {
            enabled: true,
            probes: probes.map((p) => ({
                id: String(p._id),
                name: p.name,
                enrolled: !!p.enrolledAt,
                live: !!p.lastSeenAt && Date.now() - new Date(p.lastSeenAt).getTime() < reportSec * 3 * 1000,
                country: p.country || '',
                asn: p.asn || '',
                egressIp: p.egressIp || '',
                version: p.version || '',
                os: p.os || '',
                arch: p.arch || '',
                lastSeenAt: p.lastSeenAt,
                trafficUsedBytes: p.trafficUsedBytes || 0,
                sameHostNodeIds: p.sameHostNodeIds || [],
            })),
        };
    }

    const match = { bucket, ts: { $gte: since } };
    if (parsed.nodeId) match.nodeId = String(parsed.nodeId);
    if (parsed.probeId) match.probeId = toObjectId(parsed.probeId);

    if (parsed.view === 'targets') {
        const rows = await ProbeTargetResult.find(match)
            .sort({ ts: -1 })
            .limit(parsed.limit)
            .lean();

        const nodeNames = await nodeNameMap(rows);
        return {
            enabled: true,
            bucket,
            results: rows.map((r) => ({
                nodeId: r.nodeId,
                nodeName: nodeNames.get(r.nodeId) || '',
                targetId: r.targetId,
                ts: r.ts,
                attempts: r.attempts,
                ok: r.ok,
                blocked: r.blocked,
                httpStatus: r.httpStatus,
                latencyMs: r.latencyMs,
                verdict: r.blocked > 0 ? 'target_blocked' : 'ok',
            })),
        };
    }

    const rows = await ProbeResult.find(match)
        .sort({ ts: -1 })
        .limit(parsed.limit)
        .lean();

    const nodeNames = await nodeNameMap(rows);
    return {
        enabled: true,
        bucket,
        results: rows.map((r) => ({
            probeId: String(r.probeId),
            nodeId: r.nodeId,
            nodeName: nodeNames.get(r.nodeId) || '',
            inboundId: r.inboundId,
            inboundTag: r.inboundTag,
            selectedNodeId: r.selectedNodeId || '',
            ts: r.ts,
            attempts: r.attempts,
            ok: r.ok,
            codes: r.codes,
            verdict: r.ok > 0 ? (r.lastCode || 'ok') : (r.lastCode || 'tunnel_no_data'),
            latencyP50: r.latencyP50,
            latencyP95: r.latencyP95,
            speedBps: r.speedBps,
            exitIp: r.exitIp,
        })),
    };
}

function toObjectId(value) {
    const mongoose = require('mongoose');
    return mongoose.Types.ObjectId.isValid(value)
        ? new mongoose.Types.ObjectId(value)
        : value;
}

async function nodeNameMap(rows) {
    const ids = [...new Set(rows.map((r) => r.nodeId).filter(Boolean))];
    if (ids.length === 0) return new Map();

    const nodes = await HyNode.find({ _id: { $in: ids } }).select('name').lean();
    return new Map(nodes.map((n) => [String(n._id), n.name]));
}

module.exports = {
    TOOL_DESCRIPTION,
    queryProbes,
    schemas: { queryProbes: queryProbesSchema },
};
