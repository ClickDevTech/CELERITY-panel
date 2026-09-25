/**
 * 5xx response sanitizer.
 * Admin sessions see the original error; everyone else gets a masked body with
 * a requestId that points at the full error in the log.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

const MASKED_ERROR = 'Internal Server Error';

// An API key wins over a session cookie in requireAuth, so it must win here too.
const isAdminSession = req => !!req.session?.authenticated && !req.apiKey;

const shouldMask = req => process.env.NODE_ENV !== 'development' && !isAdminSession(req);

function maskError(req, message) {
    const requestId = crypto.randomBytes(4).toString('hex');
    logger.error(`[Error] ${requestId} ${req.method} ${req.originalUrl}: ${message}`);
    return requestId;
}

function sanitizeJsonErrors(req, res, next) {
    const json = res.json.bind(res);
    res.json = body => {
        if (res.statusCode < 500 || !shouldMask(req)) return json(body);
        const requestId = maskError(req, body?.error || body?.message || 'unknown error');
        return json({ error: MASKED_ERROR, requestId });
    };
    next();
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    const requestId = shouldMask(req) ? maskError(req, err.message) : undefined;
    if (!requestId) logger.error(`[Error] ${req.method} ${req.originalUrl}: ${err.message}`);
    const message = requestId ? MASKED_ERROR : err.message;

    res.status(500);
    if (!req.path.startsWith('/api')) {
        return res.type('text').send(requestId ? `${message} (${requestId})` : message);
    }
    // Sent as a string: res.json may be wrapped by sanitizeJsonErrors, which would mask twice.
    return res.type('json').send(JSON.stringify({ error: message, requestId }));
}

module.exports = { sanitizeJsonErrors, errorHandler };
