/**
 * Hysteria + Xray user model
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const hyUserSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    
    subscriptionToken: {
        type: String,
        unique: true,
        index: true,
    },
    
    username: {
        type: String,
        default: '',
    },

    // Free-form operator note. Displayed in the panel only — never used
    // in Hysteria/Xray auth, subscription URIs, or protocol identifiers.
    comment: {
        type: String,
        default: '',
        trim: true,
        maxlength: 500,
    },
    
    password: {
        type: String,
        required: true,
    },

    // UUID used for Xray VLESS authentication (auto-generated on first save)
    xrayUuid: {
        type: String,
        default: () => crypto.randomUUID(),
        index: true,
    },

    enabled: {
        type: Boolean,
        default: false,
    },
    
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServerGroup',
    }],
    
    nodes: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'HyNode',
    }],
    
    traffic: {
        tx: { type: Number, default: 0 },
        rx: { type: Number, default: 0 },
        lastUpdate: { type: Date, default: null },
    },
    
    trafficLimit: {
        type: Number,
        default: 0,
    },
    
    maxDevices: {
        type: Number,
        default: 0,
    },

    /** HWID device limit override: inherit panel mode, off, or strict (require x-hwid). */
    hwidMode: {
        type: String,
        enum: ['inherit', 'off', 'strict'],
        default: 'inherit',
    },

    /** When set in the future, HWID devices are recorded but limit is not enforced until this moment. */
    hwidEnforceFrom: {
        type: Date,
        default: null,
    },
    
    expireAt: {
        type: Date,
        default: null,
    },

    /**
     * Marks a hidden user owned by a diagnostic probe. Such users are excluded
     * from listings and statistics, but still take part in node sync and
     * subscription generation so the probe can actually reach the nodes.
     */
    isProbe: {
        type: Boolean,
        default: false,
        index: true,
    },

}, { timestamps: true });

hyUserSchema.index({ enabled: 1 });
hyUserSchema.index({ groups: 1 });
hyUserSchema.index({ expireAt: 1 });
hyUserSchema.index({ enabled: 1, nodes: 1 });
hyUserSchema.index({ enabled: 1, groups: 1 });
// Covers expireScheduler queries (next upcoming + overdue sweep).
hyUserSchema.index({ enabled: 1, expireAt: 1 });

hyUserSchema.virtual('trafficUsedGB').get(function() {
    return ((this.traffic.tx + this.traffic.rx) / (1024 * 1024 * 1024)).toFixed(2);
});

hyUserSchema.methods.isTrafficExceeded = function() {
    if (this.trafficLimit === 0) return false;
    return (this.traffic.tx + this.traffic.rx) >= this.trafficLimit;
};

hyUserSchema.pre('save', function(next) {
    if (!this.subscriptionToken) {
        const hash = crypto.createHash('sha256')
            .update(this.userId + crypto.randomBytes(8).toString('hex'))
            .digest('hex')
            .substring(0, 16);
        this.subscriptionToken = hash;
    }
    // Ensure xrayUuid exists for existing users (migration on save)
    if (!this.xrayUuid) {
        this.xrayUuid = crypto.randomUUID();
    }
    next();
});

hyUserSchema.statics.findByToken = function(token) {
    return this.findOne({ subscriptionToken: token });
};

module.exports = mongoose.model('HyUser', hyUserSchema);

