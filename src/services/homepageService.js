/**
 * Homepage Service - serves the public root page (`/`).
 *
 * Modes:
 *   - 'nginx'  : built-in fake nginx welcome page (mask the panel)
 *   - 'custom' : user-uploaded HTML stored in settings
 *
 * Hot path (`respond`) only touches in-memory state — no DB or disk
 * reads per request. Cache is rebuilt on init() and on setMode/setCustom/clearCustom.
 */

const crypto = require('crypto');

const logger = require('../utils/logger');
const {
    MAX_CUSTOM_BYTES,
    NGINX_WELCOME_BUFFER: NGINX_BUFFER,
    validateCustomHtml,
} = require('../utils/decoyPage');

const FAKE_SERVER_HEADER = 'nginx/1.24.0';

const NGINX_ETAG = computeEtag(NGINX_BUFFER);

// Atomically-replaced state object. Always treat as immutable; never mutate fields.
let state = {
    mode: 'nginx',
    body: NGINX_BUFFER,
    etag: NGINX_ETAG,
    hasCustom: false,
    customSize: 0,
};

function computeEtag(buf) {
    return '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"';
}

function normalizeCustomBuffer(value) {
    if (!value) return null;

    let buf;
    try {
        buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    } catch (err) {
        logger.warn(`[Homepage] customHtml has invalid buffer value: ${err.message}`);
        return null;
    }
    if (buf.length === 0) return null;
    if (buf.length > MAX_CUSTOM_BYTES) {
        logger.warn(`[Homepage] customHtml is ${buf.length} bytes, exceeds ${MAX_CUSTOM_BYTES}; ignoring`);
        return null;
    }
    return buf;
}

function setNginxState(customBuf = null) {
    state = {
        mode: 'nginx',
        body: NGINX_BUFFER,
        etag: NGINX_ETAG,
        hasCustom: !!customBuf,
        customSize: customBuf ? customBuf.length : 0,
    };
}

function setCustomState(buf) {
    state = {
        mode: 'custom',
        body: buf,
        etag: computeEtag(buf),
        hasCustom: true,
        customSize: buf.length,
    };
}

/**
 * Initialize the in-memory cache. Reads Settings.homepage.mode and the
 * custom HTML payload (if any). Falls back to 'nginx' if mode='custom' but
 * the payload is missing or invalid.
 */
async function init() {
    try {
        const Settings = require('../models/settingsModel');
        const settings = await Settings.get();
        const mode = settings?.homepage?.mode === 'custom' ? 'custom' : 'nginx';
        const customBuf = normalizeCustomBuffer(settings?.homepage?.customHtml);

        if (mode === 'custom') {
            if (customBuf) {
                setCustomState(customBuf);
                logger.info(`[Homepage] Loaded custom HTML (${customBuf.length} bytes)`);
                return;
            }
            await Settings.update({ 'homepage.mode': 'nginx' });
            logger.warn('[Homepage] mode=custom but no valid customHtml found; falling back to nginx');
        }
        setNginxState(customBuf);
        logger.info('[Homepage] Serving fake nginx welcome page');
    } catch (err) {
        logger.error(`[Homepage] init failed: ${err.message}`);
        setNginxState();
    }
}

/**
 * Switch the active mode. If 'custom' is requested but no custom HTML exists,
 * revert persisted mode to nginx so the next restart stays consistent.
 */
async function setMode(mode) {
    if (mode !== 'nginx' && mode !== 'custom') return;

    const Settings = require('../models/settingsModel');
    const settings = await Settings.get();
    const customBuf = normalizeCustomBuffer(settings?.homepage?.customHtml);

    if (mode === 'nginx') {
        await Settings.update({ 'homepage.mode': 'nginx' });
        setNginxState(customBuf);
        return;
    }

    if (!customBuf) {
        await Settings.update({ 'homepage.mode': 'nginx' });
        setNginxState();
        logger.warn('[Homepage] setMode(custom) requested but no customHtml in settings; staying on nginx');
        return;
    }
    await Settings.update({ 'homepage.mode': 'custom' });
    setCustomState(customBuf);
}

/**
 * Persist a new custom HTML buffer and refresh the in-memory cache.
 */
async function setCustom(buffer) {
    validateCustomHtml(buffer);

    const Settings = require('../models/settingsModel');
    await Settings.update({
        'homepage.mode': 'custom',
        'homepage.customHtml': buffer,
    });

    setCustomState(buffer);
    logger.info(`[Homepage] Custom HTML saved (${buffer.length} bytes)`);
}

/**
 * Remove the custom HTML payload and reset the cache to the built-in nginx page.
 */
async function clearCustom() {
    const Settings = require('../models/settingsModel');
    await Settings.update({
        'homepage.mode': 'nginx',
        'homepage.customHtml': null,
    });
    setNginxState();
    logger.info('[Homepage] Custom HTML cleared, reverted to nginx');
}

function hasCustom() {
    return state.hasCustom;
}

function getCustomSize() {
    return state.customSize;
}

/**
 * Express handler for `GET /` (and HEAD /). Serves the cached body with
 * masking headers and ETag-based 304 support.
 */
function respond(req, res) {
    const { body, etag } = state;

    res.setHeader('Server', FAKE_SERVER_HEADER);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('ETag', etag);
    res.removeHeader('X-Powered-By');

    if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
    }

    if (req.method === 'HEAD') {
        res.setHeader('Content-Length', body.length);
        res.status(200).end();
        return;
    }

    res.status(200).send(body);
}

function getMode() {
    return state.mode;
}

module.exports = {
    init,
    setMode,
    setCustom,
    clearCustom,
    respond,
    hasCustom,
    getCustomSize,
    getMode,
    MAX_CUSTOM_BYTES,
};
