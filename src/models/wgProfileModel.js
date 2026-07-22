const mongoose = require('mongoose');

const wgProfileSchema = new mongoose.Schema({
    panel: { type: mongoose.Schema.Types.ObjectId, ref: 'WgPanel', required: true, index: true },
    userId: { type: String, required: true, index: true },
    remoteClientId: { type: String, default: '' },
    remoteName: { type: String, required: true },
    configuration: { type: String, default: '', select: false },
    status: { type: String, enum: ['pending', 'active', 'disabled', 'error'], default: 'pending' },
    lastSyncedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
}, { timestamps: true });

wgProfileSchema.index({ panel: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('WgProfile', wgProfileSchema);
