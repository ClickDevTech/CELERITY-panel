/**
 * Probe transport result
 *
 * One document is a rollup window reported by a single probe for a single
 * node inbound. Probes aggregate locally and ship windows, so the panel
 * stores tens of documents per minute instead of thousands.
 *
 * Keyed by (probeId, nodeId, inboundId, bucket, ts):
 * - inboundId is 'main' for the primary Xray inbound, the stable extra inbound
 *   id for additional ones, 'group' for a virtual node urltest group, and
 *   'hysteria' for Hysteria nodes;
 * - bucket is 'raw' for shipped windows and 'hourly' for the read-side rollup.
 */

const mongoose = require('mongoose');

// Failure taxonomy counters. The set is intentionally fixed: it maps directly
// to operator actions and keeps documents small on low-end hardware.
const failureCodesSchema = new mongoose.Schema({
    netUnreachable: { type: Number, default: 0 },
    handshakeFailed: { type: Number, default: 0 },
    authRejected: { type: Number, default: 0 },
    tunnelNoData: { type: Number, default: 0 },
    degraded: { type: Number, default: 0 },
    // The probe's own core was down. Kept apart from node failures because it
    // is evidence about the probe host, not about the node.
    coreDown: { type: Number, default: 0 },
}, { _id: false });

const probeResultSchema = new mongoose.Schema({
    probeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Probe',
        required: true,
    },
    nodeId: { type: String, required: true },
    inboundId: { type: String, required: true },
    inboundTag: { type: String, default: '' },

    // For virtual node groups: which leaf node the balancer actually picked.
    selectedNodeId: { type: String, default: '' },

    bucket: {
        type: String,
        enum: ['raw', 'hourly'],
        required: true,
    },
    ts: { type: Date, required: true },

    netFingerprint: { type: String, default: '' },

    attempts: { type: Number, default: 0 },
    ok: { type: Number, default: 0 },
    codes: { type: failureCodesSchema, default: () => ({}) },

    // Latency percentiles over the window, milliseconds.
    latencyP50: { type: Number, default: 0 },
    latencyP95: { type: Number, default: 0 },
    handshakeMs: { type: Number, default: 0 },
    ttfbMs: { type: Number, default: 0 },

    // Bounded speed test. Zero when no measurement happened in this window.
    // `speedBps` is the typical reading (mean inside a raw window, median of
    // the windows in an hourly rollup) and `speedBpsMax` the best one, so a
    // single lucky burst cannot hide a sustained drop. `speedCapped` marks a
    // reading that stopped on the size cap and is therefore a lower bound.
    speedBps: { type: Number, default: 0 },
    speedBpsMax: { type: Number, default: 0 },
    speedSamples: { type: Number, default: 0 },
    speedCapped: { type: Boolean, default: false },

    exitIp: { type: String, default: '' },

    // Dominant failure code of the window, empty when fully healthy.
    lastCode: { type: String, default: '' },
}, {
    timestamps: false,
    versionKey: false,
});

probeResultSchema.index(
    { probeId: 1, nodeId: 1, inboundId: 1, bucket: 1, ts: 1 },
    { unique: true }
);
probeResultSchema.index({ nodeId: 1, bucket: 1, ts: -1 });
probeResultSchema.index({ bucket: 1, ts: 1 });

/**
 * Upsert one rollup window. Idempotent so redelivered batches are harmless.
 */
probeResultSchema.statics.upsertWindow = async function(key, data) {
    return this.updateOne(
        {
            probeId: key.probeId,
            nodeId: key.nodeId,
            inboundId: key.inboundId,
            bucket: key.bucket,
            ts: key.ts,
        },
        { $set: { ...data, ...key } },
        { upsert: true }
    );
};

/**
 * Upsert many windows in one round-trip. A batch carries one window per node
 * inbound, so writing them one by one would multiply latency by the fleet size.
 */
probeResultSchema.statics.bulkUpsertWindows = async function(operations) {
    if (!operations.length) return 0;

    const ops = operations.map(({ key, data }) => ({
        updateOne: {
            filter: {
                probeId: key.probeId,
                nodeId: key.nodeId,
                inboundId: key.inboundId,
                bucket: key.bucket,
                ts: key.ts,
            },
            update: { $set: { ...data, ...key } },
            upsert: true,
        },
    }));

    // Unordered: one bad window must not stop the rest of the batch.
    const res = await this.bulkWrite(ops, { ordered: false });
    return (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
};

/**
 * Latest raw window per (probe, inbound) for one node. Drives the node card.
 */
probeResultSchema.statics.getLatestForNode = async function(nodeId, sinceMs = 30 * 60 * 1000) {
    const since = new Date(Date.now() - sinceMs);
    return this.aggregate([
        { $match: { nodeId: String(nodeId), bucket: 'raw', ts: { $gte: since } } },
        { $sort: { ts: -1 } },
        {
            $group: {
                _id: { probeId: '$probeId', inboundId: '$inboundId' },
                doc: { $first: '$$ROOT' },
            },
        },
        { $replaceRoot: { newRoot: '$doc' } },
    ]);
};

/**
 * Windows over a period, oldest first, for the history view. Short ranges read
 * raw windows; longer ones read hourly rollups so a week-wide question never
 * pulls thousands of documents.
 *
 * The read is ordered newest first and reversed afterwards: a fleet large
 * enough to exceed the limit must lose the far end of the range, never the
 * measurements taken minutes ago.
 */
probeResultSchema.statics.getHistory = async function({ probeId, nodeId, since, bucket, limit = 6000 }) {
    const filter = { bucket, ts: { $gte: since } };
    if (probeId) filter.probeId = probeId;
    if (nodeId) filter.nodeId = String(nodeId);

    const docs = await this.find(filter)
        .sort({ ts: -1 })
        .limit(limit)
        .lean();

    return docs.reverse();
};

/**
 * Delete rows past retention. Raw windows expire with the configured
 * retention, hourly rollups are kept three times longer as the read index.
 */
probeResultSchema.statics.cleanup = async function(retentionDays = 30) {
    const now = Date.now();
    const rawExpiry = new Date(now - retentionDays * 24 * 60 * 60 * 1000);
    const hourlyExpiry = new Date(now - retentionDays * 3 * 24 * 60 * 60 * 1000);

    const [raw, hourly] = await Promise.all([
        this.deleteMany({ bucket: 'raw', ts: { $lt: rawExpiry } }),
        this.deleteMany({ bucket: 'hourly', ts: { $lt: hourlyExpiry } }),
    ]);

    return { raw: raw.deletedCount, hourly: hourly.deletedCount };
};

module.exports = mongoose.model('ProbeResult', probeResultSchema);
