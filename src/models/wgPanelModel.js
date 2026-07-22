const mongoose = require('mongoose');

const wgPanelSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 100 },
    kind: { type: String, enum: ['wg-easy', 'awg-easy'], default: 'wg-easy' },
    baseUrl: { type: String, required: true, trim: true },
    country: { type: String, default: '', trim: true, uppercase: true, match: /^$|^[A-Z]{2}$/ },
    username: { type: String, default: '', trim: true },
    password: { type: String, required: true, select: false },
    apiVersion: { type: String, enum: ['auto', 'v14', 'v15'], default: 'auto' },
    rejectUnauthorized: { type: Boolean, default: true },
    enabled: { type: Boolean, default: true, index: true },
    detectedVersion: { type: String, enum: ['', 'v14', 'v15'], default: '' },
    status: { type: String, enum: ['unknown', 'online', 'error'], default: 'unknown' },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
}, { timestamps: true });

wgPanelSchema.index({ baseUrl: 1 }, { unique: true });

module.exports = mongoose.model('WgPanel', wgPanelSchema);
