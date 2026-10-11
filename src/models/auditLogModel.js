/**
 * Admin audit log: who changed what, and when.
 *
 * Written fire-and-forget by src/middleware/audit.js for every mutating
 * /api and /panel request. TTL index keeps 90 days; older entries evaporate
 * in Mongo automatically.
 */

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
    {
        actor: { type: String, default: 'anonymous', index: true },
        // "panel:admin" or "apikey:ck_abc123" — how the actor authenticated.
        authType: { type: String, enum: ['panel', 'apikey', 'anonymous'], default: 'anonymous' },
        action: { type: String, required: true, index: true },
        method: { type: String, default: '' },
        path: { type: String, default: '', index: true },
        statusCode: { type: Number, default: 0 },
        target: { type: String, default: '' },
        ip: { type: String, default: '' },
        createdAt: { type: Date, default: Date.now, index: { expires: 90 * 24 * 3600 } },
    },
    { collection: 'auditlogs' }
);

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);
