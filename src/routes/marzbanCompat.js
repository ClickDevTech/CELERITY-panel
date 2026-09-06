/**
 * Marzban legacy subscription-URL compatibility layer.
 *
 * When a Marzban → Celerity migration is finalized, every subscription link
 * that has ever been handed out to a Marzban user is of the form:
 *
 *     https://host[/random-salt]/<path>/<token>[/<client>]
 *
 * where `<path>` matches `XRAY_SUBSCRIPTION_PATH` in the source panel and
 * `<token>` is a deterministic HMAC of `(username, timestamp)` keyed by the
 * Marzban JWT secret. This middleware:
 *
 *   1. Pattern-matches the URL against the configured legacy path.
 *   2. Verifies the token signature with the stored (encrypted) JWT secret.
 *   3. Looks the user up by `userId` (lower-cased Marzban username).
 *   4. Hands control off to the regular Celerity subscription pipeline.
 *
 * The handler is a no-op when migration mode is disabled in settings, which
 * is the safe default. Settings are cached at module scope and re-loaded on
 * demand via `invalidate()` (called from `reloadSettings()` in index.js).
 */

const HyUser = require('../models/hyUserModel');
const Settings = require('../models/settingsModel');
const cryptoService = require('../services/cryptoService');
const logger = require('../utils/logger');
const { decodeMarzbanToken } = require('../utils/marzbanToken');
const { subscriptionLimiter } = require('../utils/rateLimiters');
const subscriptionModule = require('./subscription');

// First-segment values that already belong to first-class Celerity routes
// or static asset trees. Allowing the compat regex to swallow these would
// shadow real endpoints — refuse to arm in that case.
const PATH_BLACKLIST = new Set([
    'api', 'panel', 'health', 'sse', 'docs',
    'public', 'static', 'assets',
    'css', 'js', 'img', 'images', 'fonts', 'favicon.ico',
]);

// Same shape as the client_type whitelist in Marzban's subscription router.
// Kept tight to avoid swallowing arbitrary trailing path segments.
const LEGACY_CLIENT_RE = 'info|usage|clash|clash-meta|sing-?box|v2ray|v2ray-json|outline|shadowrocket';

// Map Marzban client_type → Celerity `format` query value.
// `info` is special-cased and routed to serveInfo() instead of serveSubscription.
const CLIENT_TO_FORMAT = {
    'clash':         'clash',
    'clash-meta':    'clash',
    'singbox':       'singbox',
    'sing-box':      'singbox',
    'v2ray':         'uri',
    'v2ray-json':    'v2ray-json',
    'outline':       'singbox',
    'shadowrocket':  'shadowrocket',
};

// Cached state — rebuilt lazily on first request after invalidate().
let _loaded = false;
let _enabled = false;
let _regex = null;
let _secret = '';
// Single-flight guard so a burst of cold requests does not stampede the
// settings loader. All concurrent callers await the same promise.
let _loadingPromise = null;

/**
 * (Re)load migration settings into the module-level cache and recompile the
 * URL regex. Synchronous I/O is avoided — the function awaits Settings.get().
 *
 * Fail-safe semantics: any condition that would make compat unsafe (bad path,
 * missing/undecryptable secret, blacklisted path) leaves `_enabled = false`.
 */
async function _load() {
    _loaded = true;
    _enabled = false;
    _regex = null;
    _secret = '';

    let settings;
    try {
        settings = await Settings.get();
    } catch (err) {
        logger.error(`[MarzbanCompat] Failed to load settings: ${err.message}`);
        return;
    }

    const cfg = settings?.migration?.marzban;
    if (!cfg || !cfg.enabled) return;

    const path = String(cfg.path || '').trim().toLowerCase();
    if (!_isValidPath(path)) {
        logger.warn(`[MarzbanCompat] Refusing to arm: invalid or blacklisted path "${cfg.path}"`);
        return;
    }

    let secret = '';
    try {
        secret = cryptoService.decrypt(cfg.jwtSecretEncrypted || '');
    } catch (err) {
        logger.warn(`[MarzbanCompat] Failed to decrypt jwtSecret: ${err.message}`);
        return;
    }
    if (!secret) {
        logger.warn('[MarzbanCompat] Refusing to arm: jwtSecret is empty after decryption');
        return;
    }

    _secret = secret;
    _regex = _compileRegex(path, !!cfg.acceptUrlSalt);
    _enabled = true;
    logger.info(`[MarzbanCompat] Armed for legacy path "/${path}/" (salt=${cfg.acceptUrlSalt ? 'on' : 'off'})`);
}

/**
 * Force a reload on the next request. Called from `reloadSettings()` in
 * index.js whenever Settings are mutated through the panel.
 */
function invalidate() {
    _loaded = false;
    _loadingPromise = null;
}

function _isValidPath(path) {
    if (!path) return false;
    if (PATH_BLACKLIST.has(path)) return false;
    return /^[a-z0-9_\-]{1,32}$/.test(path);
}

function _compileRegex(path, acceptSalt) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Salt segment: 1..64 char hex-ish (Marzban uses 16-char hex by default,
    // but operators occasionally override). We refuse to match if the salt
    // collides with a known top-level Celerity route.
    const saltGroup = acceptSalt ? `(?:(?<salt>[A-Za-z0-9_\\-]{1,64})\\/)?` : '';
    const clientGroup = `(?:\\/(?<client>${LEGACY_CLIENT_RE}))?`;
    return new RegExp(`^\\/${saltGroup}${escaped}\\/(?<token>[^\\/]+?)${clientGroup}\\/?$`);
}

// ─── Express middleware ──────────────────────────────────────────────────────

async function _handle(req, res, next) {
    if (!_loaded) {
        if (!_loadingPromise) _loadingPromise = _load().finally(() => { _loadingPromise = null; });
        await _loadingPromise;
    }
    if (!_enabled || !_regex) return next();

    // Only intercept idempotent reads. Other verbs fall through.
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const m = _regex.exec(req.path);
    if (!m) return next();

    // Reject when the optional salt segment collides with a real top-level
    // route. Cheap belt-and-suspenders alongside path validation.
    const salt = m.groups?.salt;
    if (salt && PATH_BLACKLIST.has(salt.toLowerCase())) return next();

    const token = m.groups?.token;
    if (!token) return next();

    const payload = decodeMarzbanToken(token, _secret);
    if (!payload) {
        return res.status(404).type('text/plain').send('# Not found');
    }

    const userId = String(payload.username).toLowerCase();
    let user;
    try {
        user = await HyUser
            .findOne({ userId })
            .populate('nodes', 'active name type status onlineUsers maxOnlineUsers rankingCoefficient domain sni ip port portRange hopInterval portConfigs obfs flag xray cascadeRole groups virtual cdn')
            .populate('groups', '_id name subscriptionTitle maxDevices');
    } catch (err) {
        logger.error(`[MarzbanCompat] Lookup failed: ${err.message}`);
        return res.status(500).type('text/plain').send('# Error');
    }
    if (!user) {
        return res.status(404).type('text/plain').send('# User not found');
    }

    // Map legacy client_type into Celerity's `format` query so the shared
    // pipeline picks the right generator branch. Done before validation so the
    // soft-block fake subscription also honours the requested client format.
    // Setting it on req.query keeps the helper signature stable.
    const client = m.groups?.client;
    if (client && CLIENT_TO_FORMAT[client]) {
        req.query = { ...req.query, format: CLIENT_TO_FORMAT[client] };
    }

    const validation = subscriptionModule.validateUser(user);
    if (!validation.valid) {
        const cacheToken = user.subscriptionToken || userId;
        const baseUrl = `${req.protocol}://${req.get('host')}${req.path.replace(/\/+$/, '')}`;
        return subscriptionModule.rejectOrSoftBlock(req, res, user, validation, { cacheToken, baseUrl });
    }

    if (client === 'info') {
        return subscriptionModule.serveInfo(req, res, user);
    }

    // Cache key uses the user's Celerity subscriptionToken so both native and
    // legacy URLs share one cache entry. Without this we would double the
    // Redis footprint and double-generate after every panel mutation.
    const cacheToken = user.subscriptionToken || userId;
    const baseUrl = `${req.protocol}://${req.get('host')}${req.path.replace(/\/+$/, '')}`;

    // Reuse the public-facing limiter so legacy hits share the same bucket as
    // /api/files — operator cannot bypass rate limits by switching URL form.
    return subscriptionLimiter(req, res, (err) => {
        if (err) return next(err);
        return subscriptionModule
            .serveSubscription(req, res, { user, cacheToken, baseUrl })
            .catch(innerErr => {
                logger.error(`[MarzbanCompat] serveSubscription failed: ${innerErr.message}`);
                if (!res.headersSent) res.status(500).type('text/plain').send('# Error');
            });
    });
}

module.exports = _handle;
module.exports.invalidate = invalidate;
module.exports._isValidPath = _isValidPath; // exported for the panel form validator
module.exports.PATH_BLACKLIST = PATH_BLACKLIST;
