/**
 * Admin audit service — best-effort persistence, never breaks requests.
 */

const logger = require('../utils/logger');

function buildEntry({ req, statusCode, actor, authType }) {
    return {
        actor: actor || 'anonymous',
        authType: authType || 'anonymous',
        action: `${req.method} ${req.path}`,
        method: req.method,
        path: req.path,
        statusCode: statusCode || 0,
        target: req.params?.id || req.params?.userId || '',
        ip: req.ip || '',
    };
}

async function write(entry) {
    try {
        const AuditLog = require('../models/auditLogModel');
        await AuditLog.create(entry);
    } catch (err) {
        logger.warn(`[Audit] write failed: ${err.message}`);
    }
}

function actorFromReq(req) {
    if (req.session?.authenticated && req.session?.adminUsername) {
        return { actor: `panel:${req.session.adminUsername}`, authType: 'panel' };
    }
    if (req.apiKey) {
        return { actor: `apikey:${req.apiKey.keyPrefix || '?'}`, authType: 'apikey' };
    }
    return { actor: 'anonymous', authType: 'anonymous' };
}

module.exports = {
    buildEntry,
    write,
    actorFromReq,
};
