/**
 * Subscription format helpers (extracted from src/routes/subscription.js).
 *
 * Pure functions: UA → format detection, ?format validation, ETag computation
 * and userinfo-snapshot refresh. Covered by scripts/test-subscription-format.js.
 */

const crypto = require('crypto');

// Formats the pipeline can render. Aliases (yaml/json/raw) are kept as-is on
// purpose: the cache key and the generator switch match on them.
const KNOWN_FORMATS = new Set([
    'clash',
    'yaml',
    'singbox',
    'json',
    'uri',
    'raw',
    'shadowrocket',
    'v2ray-json',
    'xray-json',
]);

function detectFormat(userAgent) {
    const ua = (userAgent || '').toLowerCase();
    // Shadowrocket expects base64-encoded URI list
    if (/shadowrocket/.test(ua)) return 'shadowrocket';
    // HAPP / Incy (Xray-core based) — plain URI list, upgraded to xray-json when
    // a virtual node is present (see generateSubscriptionData).
    if (/happ/.test(ua)) return 'uri';
    if (/incy/.test(ua)) return 'uri';
    // sing-box based clients — checked BEFORE clash because Hiddify UA contains "ClashMeta"
    // Example: "HiddifyNext/4.0.5 (android) like ClashMeta v2ray sing-box"
    if (/hiddify|hiddifynext|sing-?box|nekobox|nekoray|neko|sfi|sfa|sfm|sft|karing/.test(ua)) return 'singbox';
    if (/clash|stash|surge|loon/.test(ua)) return 'clash';
    return 'uri';
}

// HAPP and Incy: Xray-core clients sharing our xray-json profile array and the
// ://routing/onadd/{base64} routing deep-link (only the URL scheme differs).
function isHappUa(userAgent) {
    return /happ/i.test(userAgent || '');
}
function isIncyUa(userAgent) {
    return /incy/i.test(userAgent || '');
}
function isXrayProfileClient(userAgent) {
    return isHappUa(userAgent) || isIncyUa(userAgent);
}

function isBrowser(req) {
    const accept = req.headers.accept || '';
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    return accept.includes('text/html') && /mozilla|chrome|safari|edge|opera/.test(ua);
}

/**
 * Validate an explicit ?format= value. Returns the canonical value when known,
 * or null when the caller should fall back to UA detection (prevents junk
 * values from exploding the cache keyspace).
 */
function normalizeFormatParam(value) {
    if (value == null || value === '') return null;
    const v = String(value).trim().toLowerCase();
    return KNOWN_FORMATS.has(v) ? v : null;
}

/**
 * Weak ETag over the final response body (computed AFTER HAPP prepends, so a
 * 304 always means byte-identical content).
 */
function computeEtag(content) {
    return '"' + crypto.createHash('sha1').update(content || '').digest('hex') + '"';
}

/**
 * Refresh the volatile userinfo snapshot of a cached subscription entry with
 * a freshly loaded user document. Content (servers) keeps its TTL; traffic,
 * expiry and titles are always current. Mutates and returns `data`.
 */
function refreshSubscriptionUserinfo(data, user, profileTitle) {
    if (!data || !user) return data;
    data.traffic = { tx: user.traffic?.tx || 0, rx: user.traffic?.rx || 0 };
    data.trafficLimit = user.trafficLimit || 0;
    data.expireAt = user.expireAt;
    data.username = user.username || user.userId;
    if (profileTitle != null) data.profileTitle = profileTitle;
    return data;
}

module.exports = {
    KNOWN_FORMATS,
    detectFormat,
    isHappUa,
    isIncyUa,
    isXrayProfileClient,
    isBrowser,
    normalizeFormatParam,
    computeEtag,
    refreshSubscriptionUserinfo,
};
