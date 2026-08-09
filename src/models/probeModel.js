/**
 * Probe model
 *
 * A probe is an external diagnostic agent installed by the operator on their
 * own server. It never gets any node privileges: the only credentials it holds
 * are client-side subscription credentials of a hidden probe user.
 *
 * Two credentials exist per probe:
 * - enrollment token (one-time, short TTL) is embedded into the install command
 *   and exchanged once for the permanent token;
 * - probe token (format cp_<48 hex>) authenticates every later request.
 *
 * Only SHA-256 hashes are used for verification. The permanent token is also
 * kept encrypted so the panel can re-display the install command later.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const cryptoService = require('../services/cryptoService');

const ENROLL_TTL_MS = 24 * 60 * 60 * 1000;

const probeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    tokenHash: {
        type: String,
        default: '',
        index: true,
    },
    tokenPrefix: {
        type: String,
        default: '',
    },
    tokenEncrypted: {
        type: String,
        default: '',
    },

    // One-time enrollment credential. Cleared once the probe exchanges it.
    enrollTokenHash: {
        type: String,
        default: '',
        index: true,
    },
    enrollExpiresAt: {
        type: Date,
        default: null,
    },
    enrolledAt: {
        type: Date,
        default: null,
    },

    // Hidden HyUser carrying the probe subscription. Removed with the probe.
    probeUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'HyUser',
        default: null,
    },

    active: {
        type: Boolean,
        default: true,
    },

    // Self-reported runtime info, refreshed on every profile poll.
    version: { type: String, default: '' },
    singboxVersion: { type: String, default: '' },
    os: { type: String, default: '' },
    arch: { type: String, default: '' },

    // Vantage point identity. egressIp is observed by the panel, the rest is
    // reported by the probe from a direct (non-tunneled) request.
    egressIp: { type: String, default: '' },
    asn: { type: String, default: '' },
    country: { type: String, default: '' },

    // Fingerprint of the probe network environment (e.g. Wi-Fi vs LTE). Used to
    // avoid mixing measurements taken over different uplinks.
    netFingerprint: { type: String, default: '' },

    lastSeenAt: { type: Date, default: null },
    lastReportAt: { type: Date, default: null },
    lastError: { type: String, default: '' },

    // Guards the offline alert against repeating every cron tick.
    offlineNotified: { type: Boolean, default: false },

    // Traffic consumed by this probe, mirrored from its hidden user.
    trafficUsedBytes: { type: Number, default: 0 },

    // Set when the probe egress IP matches one of the nodes: such a vantage
    // point is useless for that node and the UI warns about it.
    sameHostNodeIds: { type: [String], default: [] },

    createdBy: { type: String, default: '' },
}, { timestamps: true });

probeSchema.index({ active: 1 });

/**
 * Hash a plaintext token using SHA-256.
 */
function hashToken(plainToken) {
    return crypto.createHash('sha256').update(plainToken).digest('hex');
}

/**
 * Constant-time comparison of two hex digests of equal length.
 */
function safeHashEqual(a, b) {
    if (!a || !b) return false;
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Create a probe with a fresh one-time enrollment token.
 * Returns the plaintext enrollment token (only time it is available).
 */
probeSchema.statics.createProbe = async function({ name, createdBy }) {
    const enrollToken = `ce_${crypto.randomBytes(16).toString('hex')}`;

    const doc = await this.create({
        name,
        enrollTokenHash: hashToken(enrollToken),
        enrollExpiresAt: new Date(Date.now() + ENROLL_TTL_MS),
        createdBy: createdBy || '',
    });

    return { doc, enrollToken };
};

/**
 * Issue (or re-issue) the permanent token for a probe. The plaintext value is
 * returned once and additionally stored encrypted for later re-display.
 */
probeSchema.statics.issueToken = async function(probeId) {
    const plainToken = `cp_${crypto.randomBytes(24).toString('hex')}`;

    await this.updateOne(
        { _id: probeId },
        {
            $set: {
                tokenHash: hashToken(plainToken),
                tokenPrefix: plainToken.substring(0, 12),
                tokenEncrypted: cryptoService.encrypt(plainToken),
                enrollTokenHash: '',
                enrollExpiresAt: null,
                enrolledAt: new Date(),
            },
        }
    );

    return plainToken;
};

/**
 * Resolve a probe by its plaintext permanent token.
 * Returns null when not found or deactivated.
 */
probeSchema.statics.findByToken = async function(plainToken) {
    if (!plainToken || typeof plainToken !== 'string') return null;

    const incomingHash = hashToken(plainToken);
    const probe = await this.findOne({ tokenHash: incomingHash, active: true });
    if (!probe) return null;
    if (!safeHashEqual(probe.tokenHash, incomingHash)) return null;

    return probe;
};

/**
 * Resolve a probe by its plaintext one-time enrollment token.
 * Returns null when not found, already exchanged, or expired.
 */
probeSchema.statics.findByEnrollToken = async function(plainToken) {
    if (!plainToken || typeof plainToken !== 'string') return null;

    const incomingHash = hashToken(plainToken);
    const probe = await this.findOne({ enrollTokenHash: incomingHash, active: true });
    if (!probe) return null;
    if (!safeHashEqual(probe.enrollTokenHash, incomingHash)) return null;
    if (!probe.enrollExpiresAt || new Date(probe.enrollExpiresAt) < new Date()) return null;

    return probe;
};

// Explicit allow-list rather than an exclusion list: a secret added to the
// schema later must not start leaking into the UI by default.
const PUBLIC_FIELDS = [
    'name', 'active', 'tokenPrefix',
    'enrollExpiresAt', 'enrolledAt',
    'version', 'singboxVersion', 'os', 'arch',
    'egressIp', 'asn', 'country', 'netFingerprint',
    'lastSeenAt', 'lastReportAt', 'lastError',
    'trafficUsedBytes', 'sameHostNodeIds',
    'createdBy', 'createdAt',
].join(' ');

/**
 * List probes for display without any secret material.
 */
probeSchema.statics.listProbes = async function() {
    return this.find({})
        .select(PUBLIC_FIELDS)
        .sort({ createdAt: -1 })
        .lean();
};

probeSchema.statics.hashToken = hashToken;
probeSchema.statics.ENROLL_TTL_MS = ENROLL_TTL_MS;

module.exports = mongoose.model('Probe', probeSchema);
