/**
 * Probe target result
 *
 * Reachability of a checklist resource (google, telegram, openai, ...) through
 * a given node, as seen by a given probe. Kept separate from transport results
 * on purpose: a blocked target means the node egress IP is geo-blocked or
 * blacklisted, which is not the same as the node being down.
 *
 * Keyed by (probeId, nodeId, targetId, bucket, ts).
 */

const mongoose = require('mongoose');

const probeTargetResultSchema = new mongoose.Schema({
    probeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Probe',
        required: true,
    },
    nodeId: { type: String, required: true },
    targetId: { type: String, required: true },

    bucket: {
        type: String,
        enum: ['raw', 'hourly'],
        required: true,
    },
    ts: { type: Date, required: true },

    netFingerprint: { type: String, default: '' },

    attempts: { type: Number, default: 0 },
    ok: { type: Number, default: 0 },
    blocked: { type: Number, default: 0 },

    // Last observed HTTP status through the tunnel, 0 when unreachable.
    httpStatus: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
}, {
    timestamps: false,
    versionKey: false,
});

probeTargetResultSchema.index(
    { probeId: 1, nodeId: 1, targetId: 1, bucket: 1, ts: 1 },
    { unique: true }
);
probeTargetResultSchema.index({ nodeId: 1, bucket: 1, ts: -1 });
probeTargetResultSchema.index({ bucket: 1, ts: 1 });

probeTargetResultSchema.statics.upsertWindow = async function(key, data) {
    return this.updateOne(
        {
            probeId: key.probeId,
            nodeId: key.nodeId,
            targetId: key.targetId,
            bucket: key.bucket,
            ts: key.ts,
        },
        { $set: { ...data, ...key } },
        { upsert: true }
    );
};

/**
 * Upsert many windows in one round-trip, mirroring ProbeResult: a checklist run
 * produces one window per (node, target) pair and they arrive together.
 */
probeTargetResultSchema.statics.bulkUpsertWindows = async function(operations) {
    if (!operations.length) return 0;

    const ops = operations.map(({ key, data }) => ({
        updateOne: {
            filter: {
                probeId: key.probeId,
                nodeId: key.nodeId,
                targetId: key.targetId,
                bucket: key.bucket,
                ts: key.ts,
            },
            update: { $set: { ...data, ...key } },
            upsert: true,
        },
    }));

    const res = await this.bulkWrite(ops, { ordered: false });
    return (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
};

/**
 * Latest raw window per (probe, target) for one node.
 */
probeTargetResultSchema.statics.getLatestForNode = async function(nodeId, sinceMs = 3 * 60 * 60 * 1000) {
    const since = new Date(Date.now() - sinceMs);
    return this.aggregate([
        { $match: { nodeId: String(nodeId), bucket: 'raw', ts: { $gte: since } } },
        { $sort: { ts: -1 } },
        {
            $group: {
                _id: { probeId: '$probeId', targetId: '$targetId' },
                doc: { $first: '$$ROOT' },
            },
        },
        { $replaceRoot: { newRoot: '$doc' } },
    ]);
};

/**
 * Windows over a period, oldest first, for the history view.
 */
probeTargetResultSchema.statics.getHistory = async function({ probeId, nodeId, since, bucket, limit = 6000 }) {
    const filter = { bucket, ts: { $gte: since } };
    if (probeId) filter.probeId = probeId;
    if (nodeId) filter.nodeId = String(nodeId);

    return this.find(filter)
        .sort({ ts: 1 })
        .limit(limit)
        .lean();
};

probeTargetResultSchema.statics.cleanup = async function(retentionDays = 30) {
    const now = Date.now();
    const rawExpiry = new Date(now - retentionDays * 24 * 60 * 60 * 1000);
    const hourlyExpiry = new Date(now - retentionDays * 3 * 24 * 60 * 60 * 1000);

    const [raw, hourly] = await Promise.all([
        this.deleteMany({ bucket: 'raw', ts: { $lt: rawExpiry } }),
        this.deleteMany({ bucket: 'hourly', ts: { $lt: hourlyExpiry } }),
    ]);

    return { raw: raw.deletedCount, hourly: hourly.deletedCount };
};

module.exports = mongoose.model('ProbeTargetResult', probeTargetResultSchema);
