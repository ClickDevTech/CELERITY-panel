/**
 * API Key model
 *
 * Keys are shown once at creation, only the SHA-256 hash is stored.
 * Format: ck_<48 hex chars> (51 chars total)
 * Prefix (first 12 chars, e.g. ck_a1b2c3d4) is stored for display in UI.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const VALID_SCOPES = [
    'users:read',
    'users:write',
    'nodes:read',
    'nodes:write',
    'stats:read',
    'sync:write',
    'mcp:enabled',
    'probes:read',
];

const apiKeySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    keyHash: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    keyPrefix: {
        type: String,
        required: true,
    },
    scopes: {
        type: [{ type: String, enum: VALID_SCOPES }],
        default: [],
    },
    allowedIPs: {
        type: [String],
        default: [],
    },
    rateLimit: {
        type: Number,
        default: 60,
        min: 1,
        max: 10000,
    },
    expiresAt: {
        type: Date,
        default: null,
    },
    active: {
        type: Boolean,
        default: true,
    },
    lastUsedAt: {
        type: Date,
        default: null,
    },
    lastUsedIP: {
        type: String,
        default: '',
    },
    createdBy: {
        type: String,
        default: '',
    },
}, { timestamps: true });

apiKeySchema.index({ active: 1 });

/**
 * Hash a plaintext key using SHA-256
 */
function hashKey(plainKey) {
    return crypto.createHash('sha256').update(plainKey).digest('hex');
}

/**
 * Generate a new API key, save to DB, return plaintext key (once only)
 */
apiKeySchema.statics.createKey = async function({ name, scopes, allowedIPs, rateLimit, expiresAt, createdBy }) {
    const random = crypto.randomBytes(24).toString('hex'); // 48 hex chars
    const plainKey = `ck_${random}`;
    const keyHash = hashKey(plainKey);
    const keyPrefix = plainKey.substring(0, 12); // ck_a1b2c3d4

    const doc = await this.create({
        name,
        keyHash,
        keyPrefix,
        scopes: scopes || [],
        allowedIPs: allowedIPs || [],
        rateLimit: rateLimit || 60,
        expiresAt: expiresAt || null,
        active: true,
        createdBy: createdBy || '',
    });

    // Return plaintext key alongside the document (only time it's available)
    return { doc, plainKey };
};

/**
 * Find a key by its plaintext value.
 * Uses constant-time comparison to prevent timing attacks.
 * Returns null if not found, inactive, or expired.
 */
apiKeySchema.statics.findByKey = async function(plainKey) {
    if (!plainKey || typeof plainKey !== 'string') return null;

    const incomingHash = hashKey(plainKey);

    // Look up by hash directly - SHA-256 is deterministic
    const key = await this.findOne({ keyHash: incomingHash, active: true });

    if (!key) return null;

    // Constant-time compare as extra protection (hashes are same length)
    const storedBuf = Buffer.from(key.keyHash, 'hex');
    const incomingBuf = Buffer.from(incomingHash, 'hex');
    if (storedBuf.length !== incomingBuf.length) return null;
    if (!crypto.timingSafeEqual(storedBuf, incomingBuf)) return null;

    // Check expiration
    if (key.expiresAt && new Date(key.expiresAt) < new Date()) return null;

    return key;
};

/**
 * Return all keys for display (without keyHash)
 */
apiKeySchema.statics.listKeys = async function() {
    return this.find({}).select('-keyHash').sort({ createdAt: -1 }).lean();
};

apiKeySchema.statics.VALID_SCOPES = VALID_SCOPES;

module.exports = mongoose.model('ApiKey', apiKeySchema);
