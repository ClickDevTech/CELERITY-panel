/**
 * Audit middleware: records every mutating /api and /panel request.
 *
 * Skips reads (GET/HEAD/OPTIONS) and high-volume machine endpoints
 * (/api/auth, /api/access-logs/*, /api/probe/*, /api/files/*, /api/info/*).
 * Identity is resolved on response finish, so both panel sessions and API
 * keys (set by downstream requireAuth) are captured. Fire-and-forget —
 * a failing Mongo must never fail the request.
 */

const auditService = require('../services/auditService');

const SKIP_PREFIXES = [
    '/api/auth',
    '/api/access-logs',
    '/api/probe',
    '/api/files',
    '/api/info',
];

function shouldAudit(req) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return false;
    const path = req.path || '';
    return !SKIP_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

function auditMiddleware(req, res, next) {
    if (!shouldAudit(req)) return next();
    res.on('finish', () => {
        try {
            const { actor, authType } = auditService.actorFromReq(req);
            auditService.write(auditService.buildEntry({ req, statusCode: res.statusCode, actor, authType }));
        } catch { /* never break responses */ }
    });
    next();
}

module.exports = auditMiddleware;
module.exports.shouldAudit = shouldAudit;
