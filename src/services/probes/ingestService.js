/**
 * Probe result ingest
 *
 * Probes aggregate locally and ship gzipped NDJSON windows, so the panel only
 * writes tens of documents per minute even with several probes and dozens of
 * nodes. Three record kinds are accepted:
 *
 *   transport - one rollup window for a node inbound
 *   target    - one rollup window for a checklist resource through a node
 *   event     - an immediate state transition, used for alerting
 *   meta      - probe self-report (versions, egress identity, traffic used)
 *
 * Records are upserted by their natural key, which makes redelivered batches
 * harmless on top of the batch-level deduplication done by the route.
 */

const zlib = require('zlib');
const { promisify } = require('util');

const Probe = require('../../models/probeModel');
const HyNode = require('../../models/hyNodeModel');
const HyUser = require('../../models/hyUserModel');
const ProbeResult = require('../../models/probeResultModel');
const ProbeTargetResult = require('../../models/probeTargetResultModel');
const Settings = require('../../models/settingsModel');
const webhook = require('../webhookService');
const logger = require('../../utils/logger');

const gunzip = promisify(zlib.gunzip);

// Guards against decompression bombs: the route caps the compressed body, this
// caps what a malicious probe could expand it into.
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS_PER_BATCH = 5000;

// Known node ids, refreshed lazily. Keeps unknown-node garbage out of storage
// without a database round-trip per record.
let _nodeCache = { ids: new Set(), ips: new Map(), names: new Map(), at: 0 };
const NODE_CACHE_TTL_MS = 60 * 1000;

async function getNodeIndex() {
    if (Date.now() - _nodeCache.at < NODE_CACHE_TTL_MS && _nodeCache.ids.size > 0) {
        return _nodeCache;
    }
    const nodes = await HyNode.find({}).select('_id ip name').lean();
    const ids = new Set(nodes.map((n) => String(n._id)));
    const ips = new Map();
    const names = new Map();
    for (const n of nodes) {
        if (n.ip) ips.set(String(n.ip), String(n._id));
        names.set(String(n._id), n.name || '');
    }
    _nodeCache = { ids, ips, names, at: Date.now() };
    return _nodeCache;
}

function invalidateNodeIndex() {
    _nodeCache = { ids: new Set(), ips: new Map(), names: new Map(), at: 0 };
}

/**
 * Inflate a gzipped body when needed and split it into NDJSON records.
 */
async function parseBatch(body, contentEncoding) {
    let raw = body;
    if (String(contentEncoding || '').toLowerCase().includes('gzip')) {
        raw = await gunzip(body, { maxOutputLength: MAX_INFLATED_BYTES });
    }

    const text = raw.toString('utf8');
    const records = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // An oversized batch is refused outright instead of being silently
        // truncated: acknowledging a batch whose tail was dropped would tell
        // the probe to delete measurements the panel never stored.
        if (records.length >= MAX_RECORDS_PER_BATCH) {
            const err = new Error('batch has too many records');
            err.statusCode = 413;
            throw err;
        }

        try {
            records.push(JSON.parse(trimmed));
        } catch (_) {
            // Skip malformed lines rather than rejecting the whole batch: a
            // single corrupted line must not block a probe forever.
        }
    }
    return records;
}

function toDate(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function toInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * Normalize the fixed failure taxonomy coming from the probe.
 */
function normalizeCodes(codes) {
    const src = codes && typeof codes === 'object' ? codes : {};
    return {
        netUnreachable: toInt(src.netUnreachable),
        handshakeFailed: toInt(src.handshakeFailed),
        authRejected: toInt(src.authRejected),
        tunnelNoData: toInt(src.tunnelNoData),
        degraded: toInt(src.degraded),
        coreDown: toInt(src.coreDown),
    };
}

/**
 * Turn a transport record into a bulk operation, or null when it is unusable.
 */
function buildTransportOp(probe, rec, nodeIndex) {
    const nodeId = String(rec.nodeId || '');
    const inboundId = String(rec.inboundId || '');
    const ts = toDate(rec.ts);
    if (!nodeId || !inboundId || !ts) return null;
    if (!nodeIndex.ids.has(nodeId)) return null;

    return {
        key: { probeId: probe._id, nodeId, inboundId, bucket: 'raw', ts },
        data: {
            inboundTag: String(rec.inboundTag || ''),
            selectedNodeId: String(rec.selectedNodeId || ''),
            netFingerprint: String(rec.netFingerprint || ''),
            attempts: toInt(rec.attempts),
            ok: toInt(rec.ok),
            codes: normalizeCodes(rec.codes),
            latencyP50: toInt(rec.latencyP50),
            latencyP95: toInt(rec.latencyP95),
            handshakeMs: toInt(rec.handshakeMs),
            ttfbMs: toInt(rec.ttfbMs),
            speedBps: toInt(rec.speedBps),
            speedSamples: toInt(rec.speedSamples),
            exitIp: String(rec.exitIp || ''),
            lastCode: String(rec.lastCode || ''),
        },
    };
}

function buildTargetOp(probe, rec, nodeIndex) {
    const nodeId = String(rec.nodeId || '');
    const targetId = String(rec.targetId || '');
    const ts = toDate(rec.ts);
    if (!nodeId || !targetId || !ts) return null;
    if (!nodeIndex.ids.has(nodeId)) return null;

    return {
        key: { probeId: probe._id, nodeId, targetId, bucket: 'raw', ts },
        data: {
            netFingerprint: String(rec.netFingerprint || ''),
            attempts: toInt(rec.attempts),
            ok: toInt(rec.ok),
            blocked: toInt(rec.blocked),
            httpStatus: toInt(rec.httpStatus),
            latencyMs: toInt(rec.latencyMs),
            lastError: String(rec.lastError || '').slice(0, 300),
        },
    };
}

/**
 * Emit an alert for a state transition reported by the probe. Transitions are
 * shipped immediately so alerts do not wait for the end of a rollup window.
 */
function applyEvent(probe, rec, nodeIndex) {
    const event = String(rec.event || '');
    const nodeId = String(rec.nodeId || '');

    const base = {
        probeId: String(probe._id),
        probeName: probe.name,
        country: probe.country || '',
        asn: probe.asn || '',
        nodeId,
        // Resolved from the cached index: an alert must not cost a query per
        // event, and the index is already loaded for validation.
        nodeName: nodeIndex.names.get(nodeId) || '',
    };

    if (event === 'node_unreachable') {
        webhook.emit(webhook.EVENTS.PROBE_NODE_UNREACHABLE, {
            ...base,
            inboundId: String(rec.inboundId || ''),
            code: String(rec.code || ''),
            message: String(rec.message || '').slice(0, 300),
        });
        return true;
    }

    if (event === 'target_unreachable') {
        webhook.emit(webhook.EVENTS.PROBE_TARGET_UNREACHABLE, {
            ...base,
            targetId: String(rec.targetId || ''),
            httpStatus: toInt(rec.httpStatus),
            message: String(rec.message || '').slice(0, 300),
        });
        return true;
    }

    return false;
}

/**
 * Record probe self-reported metadata and detect a useless vantage point:
 * a probe sitting on a node host always sees that node as healthy.
 */
async function applyMeta(probe, rec, nodeIndex) {
    const update = {};
    if (rec.version) update.version = String(rec.version).slice(0, 32);
    if (rec.singboxVersion) update.singboxVersion = String(rec.singboxVersion).slice(0, 32);
    if (rec.os) update.os = String(rec.os).slice(0, 32);
    if (rec.arch) update.arch = String(rec.arch).slice(0, 32);
    if (rec.asn) update.asn = String(rec.asn).slice(0, 64);
    if (rec.country) update.country = String(rec.country).slice(0, 8);
    if (rec.netFingerprint) update.netFingerprint = String(rec.netFingerprint).slice(0, 64);
    if (rec.lastError !== undefined) update.lastError = String(rec.lastError || '').slice(0, 300);

    const egressIp = String(rec.egressIp || '');
    if (egressIp) {
        update.egressIp = egressIp;
        const collidingNode = nodeIndex.ips.get(egressIp);
        update.sameHostNodeIds = collidingNode ? [collidingNode] : [];
    }

    if (Object.keys(update).length > 0) {
        await Probe.updateOne({ _id: probe._id }, { $set: update });
    }
    return true;
}

/**
 * Process one decoded batch. Returns per-kind counters for logging.
 */
async function processBatch(probe, body, contentEncoding) {
    const records = await parseBatch(body, contentEncoding);
    const nodeIndex = await getNodeIndex();

    const counters = { transport: 0, target: 0, event: 0, meta: 0, skipped: 0 };
    const transportOps = [];
    const targetOps = [];
    const metaRecords = [];

    for (const rec of records) {
        try {
            switch (rec && rec.kind) {
                case 'transport': {
                    const op = buildTransportOp(probe, rec, nodeIndex);
                    if (op) { transportOps.push(op); counters.transport++; }
                    else counters.skipped++;
                    break;
                }
                case 'target': {
                    const op = buildTargetOp(probe, rec, nodeIndex);
                    if (op) { targetOps.push(op); counters.target++; }
                    else counters.skipped++;
                    break;
                }
                case 'event':
                    if (applyEvent(probe, rec, nodeIndex)) counters.event++;
                    else counters.skipped++;
                    break;
                case 'meta':
                    metaRecords.push(rec);
                    counters.meta++;
                    break;
                default:
                    counters.skipped++;
            }
        } catch (err) {
            counters.skipped++;
            logger.debug(`[Probes] Record rejected: ${err.message}`);
        }
    }

    // One round-trip per collection instead of one per window: a fleet of
    // dozens of inbounds otherwise turns a single report into dozens of writes.
    await Promise.all([
        ProbeResult.bulkUpsertWindows(transportOps),
        ProbeTargetResult.bulkUpsertWindows(targetOps),
    ]);

    for (const rec of metaRecords) {
        await applyMeta(probe, rec, nodeIndex).catch((err) => {
            logger.debug(`[Probes] Meta record rejected: ${err.message}`);
        });
    }

    const now = new Date();
    await Probe.updateOne(
        { _id: probe._id },
        { $set: { lastSeenAt: now, lastReportAt: now } }
    );

    await syncProbeTraffic(probe);

    return counters;
}

/**
 * Mirror the hidden user traffic counter onto the probe for the UI budget view.
 */
async function syncProbeTraffic(probe) {
    if (!probe.probeUserId) return;
    const user = await HyUser.findById(probe.probeUserId).select('traffic').lean();
    if (!user) return;
    const used = (user.traffic?.tx || 0) + (user.traffic?.rx || 0);
    await Probe.updateOne({ _id: probe._id }, { $set: { trafficUsedBytes: used } });
}

/**
 * Bump the aggregate ingest counters shown in settings.
 */
async function bumpStats(field) {
    const inc = {};
    inc[`probes.stats.${field}`] = 1;
    await Settings.updateOne(
        { _id: 'settings' },
        { $inc: inc, $set: { 'probes.stats.lastIngestAt': new Date() } },
        { upsert: true }
    ).catch(() => {});
}

module.exports = {
    processBatch,
    parseBatch,
    bumpStats,
    invalidateNodeIndex,
    MAX_INFLATED_BYTES,
};
