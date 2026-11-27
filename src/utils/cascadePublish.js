/**
 * Publication of reverse-cascade exits in subscriptions.
 *
 * A portal can expose each of its exits (bridges) as a separate subscription
 * entry. All entries share the portal's inbounds; the exit is selected by the
 * VLESS UUID bytes 7-8 (third UUID group), which Xray ignores for user lookup
 * and exposes to routing as `vlessRoute`. No extra ports or inbounds needed.
 *
 * Shared by the models, REST/MCP validation, the config generator and the
 * subscription builder so every entry point applies the same rules.
 */

const { listXrayInbounds } = require('./xrayFront');

function portalListeners(node) {
    return listXrayInbounds(node.xray || {}, node.port).map(({ id, inboundTag, label, port }) => ({ id, inboundTag, label, port }));
}

const CASCADE_PUBLISH_MODES = ['single', 'perExit', 'both'];
const CASCADE_BALANCER_STRATEGIES = ['random', 'leastPing', 'leastLoad'];
const CASCADE_FALLBACKS = ['direct', 'block'];

// 0 is reserved for the balanced entry; it never gets a vlessRoute rule.
const ROUTE_ID_MIN = 1;
const ROUTE_ID_MAX = 4095;
const SUBSCRIPTION_LABEL_MAX = 64;

const DURATION_RE = /^\d{1,5}(ms|s|m|h)$/;
const PROBE_URL_RE = /^https?:\/\/[^\s"'<>]+$/;
const PROBE_URL_MAX = 255;
const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-)[0-9a-f]{4}(-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// Control characters break URI fragments, YAML scalars and client UIs.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// A cut emoji leaves half a surrogate pair, which MongoDB stores as U+FFFD.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Exit entries stay in subscriptions only while the portal runs their route.
const PUBLISHED_EXIT_STATUSES = Object.freeze(['deployed', 'online']);

const PORTAL_DEFAULTS = Object.freeze({
    inboundRoutes: Object.freeze([]),
    publishMode: 'single',
    balancerStrategy: 'random',
    fallback: 'direct',
    probeUrl: 'https://www.gstatic.com/generate_204',
    probeInterval: '1m',
});

/**
 * Fill missing portal settings with defaults. Accepts a mongoose subdocument,
 * a plain object or nothing.
 */
function normalizePortalSettings(raw) {
    const src = raw && typeof raw.toObject === 'function' ? raw.toObject() : (raw || {});
    return {
        inboundRoutes: (Array.isArray(src.inboundRoutes) ? src.inboundRoutes : []).map(route => ({
            inboundId: route.inboundId, linkId: String(route.linkId),
        })),
        publishMode: CASCADE_PUBLISH_MODES.includes(src.publishMode) ? src.publishMode : PORTAL_DEFAULTS.publishMode,
        balancerStrategy: CASCADE_BALANCER_STRATEGIES.includes(src.balancerStrategy)
            ? src.balancerStrategy
            : PORTAL_DEFAULTS.balancerStrategy,
        fallback: CASCADE_FALLBACKS.includes(src.fallback) ? src.fallback : PORTAL_DEFAULTS.fallback,
        probeUrl: typeof src.probeUrl === 'string' && PROBE_URL_RE.test(src.probeUrl)
            ? src.probeUrl
            : PORTAL_DEFAULTS.probeUrl,
        probeInterval: typeof src.probeInterval === 'string' && DURATION_RE.test(src.probeInterval)
            ? src.probeInterval
            : PORTAL_DEFAULTS.probeInterval,
    };
}

function publishesExits(settings) {
    const mode = normalizePortalSettings(settings).publishMode;
    return mode === 'perExit' || mode === 'both';
}

function publishesBalanced(settings) {
    return normalizePortalSettings(settings).publishMode !== 'perExit';
}

/**
 * Validate portal settings from untrusted input. Only keys present in `input`
 * are returned, so the result can be used for partial updates.
 * @returns {{ fields: Object, error: string|null }}
 */
function sanitizePortalSettingsInput(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { fields: {}, error: 'settings must be an object' };
    }
    const fields = {};
    const pickEnum = (key, values) => {
        if (input[key] === undefined) return null;
        if (!values.includes(input[key])) return `${key} must be one of: ${values.join(', ')}`;
        fields[key] = input[key];
        return null;
    };
    const enumError = pickEnum('publishMode', CASCADE_PUBLISH_MODES)
        || pickEnum('balancerStrategy', CASCADE_BALANCER_STRATEGIES)
        || pickEnum('fallback', CASCADE_FALLBACKS);
    if (enumError) return { fields: {}, error: enumError };

    if (input.inboundRoutes !== undefined) {
        if (!Array.isArray(input.inboundRoutes)) return { fields: {}, error: 'inboundRoutes must be an array' };
        const seen = new Set();
        fields.inboundRoutes = [];
        for (const route of input.inboundRoutes) {
            if (typeof route?.inboundId !== 'string' || !route.inboundId || seen.has(route.inboundId)) {
                return { fields: {}, error: 'Each inbound route needs a distinct inboundId' };
            }
            if (typeof route.linkId !== 'string' || !/^[0-9a-f]{24}$/i.test(route.linkId)) {
                return { fields: {}, error: 'Each inbound route needs a reverse link ID' };
            }
            seen.add(route.inboundId);
            fields.inboundRoutes.push({ inboundId: route.inboundId, linkId: route.linkId.toLowerCase() });
        }
    }

    if (input.probeUrl !== undefined) {
        const url = String(input.probeUrl || '').trim();
        if (!url || url.length > PROBE_URL_MAX || !PROBE_URL_RE.test(url)) {
            return { fields: {}, error: 'probeUrl must be an http(s) URL' };
        }
        fields.probeUrl = url;
    }
    if (input.probeInterval !== undefined) {
        const interval = String(input.probeInterval || '').trim();
        if (!DURATION_RE.test(interval)) {
            return { fields: {}, error: 'probeInterval must look like 30s, 1m or 500ms' };
        }
        fields.probeInterval = interval;
    }
    return { fields, error: null };
}

function sanitizeSubscriptionLabel(value) {
    const clean = String(value ?? '')
        .replace(CONTROL_CHARS_RE, ' ')
        .replace(LONE_SURROGATE_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
    // The limit counts UTF-16 units (like the schema maxlength), but the cut
    // never splits a character.
    let out = '';
    for (const ch of clean) {
        if (out.length + ch.length > SUBSCRIPTION_LABEL_MAX) break;
        out += ch;
    }
    return out.trim();
}

function parseBoolean(value) {
    if (value === true || value === 'true' || value === 'on' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 'off' || value === 0 || value === '0') return false;
    return null;
}

/**
 * Validate per-link publication fields from untrusted input. `routeId` is
 * never accepted from clients: it is allocated server-side.
 * @returns {{ fields: Object, error: string|null }}
 */
function sanitizeLinkPublishInput(input = {}) {
    const fields = {};
    for (const key of ['publishInSubscription', 'includeInBalancer']) {
        if (input[key] === undefined) continue;
        const parsed = parseBoolean(input[key]);
        if (parsed === null) return { fields: {}, error: `${key} must be a boolean` };
        fields[key] = parsed;
    }
    if (input.subscriptionLabel !== undefined) {
        if (input.subscriptionLabel !== null && typeof input.subscriptionLabel !== 'string') {
            return { fields: {}, error: 'subscriptionLabel must be a string' };
        }
        fields.subscriptionLabel = sanitizeSubscriptionLabel(input.subscriptionLabel);
    }
    return { fields, error: null };
}

/**
 * Smallest route id not present in `usedIds`, or null when the range is full.
 * @param {Iterable<number>} usedIds
 */
function pickFreeRouteId(usedIds) {
    const used = new Set(Array.from(usedIds || [], Number));
    for (let id = ROUTE_ID_MIN; id <= ROUTE_ID_MAX; id++) {
        if (!used.has(id)) return id;
    }
    return null;
}

function isValidRouteId(value) {
    return Number.isInteger(value) && value >= ROUTE_ID_MIN && value <= ROUTE_ID_MAX;
}

/**
 * Return `uuid` with its third group replaced by `routeId` (big-endian hex),
 * which Xray reads as `vlessRoute`. Returns null for malformed UUIDs so callers
 * never publish an entry that would silently land on the default route.
 */
function uuidWithRoute(uuid, routeId) {
    const match = UUID_RE.exec(String(uuid || ''));
    if (!match) return null;
    const route = Number(routeId) || 0;
    if (route < 0 || route > 0xffff) return null;
    return `${match[1]}${route.toString(16).padStart(4, '0')}${match[2]}`.toLowerCase();
}

module.exports = {
    portalListeners,
    CASCADE_PUBLISH_MODES,
    CASCADE_BALANCER_STRATEGIES,
    CASCADE_FALLBACKS,
    ROUTE_ID_MIN,
    ROUTE_ID_MAX,
    SUBSCRIPTION_LABEL_MAX,
    DURATION_RE,
    PROBE_URL_RE,
    PUBLISHED_EXIT_STATUSES,
    PORTAL_DEFAULTS,
    normalizePortalSettings,
    publishesExits,
    publishesBalanced,
    sanitizePortalSettingsInput,
    sanitizeSubscriptionLabel,
    sanitizeLinkPublishInput,
    pickFreeRouteId,
    isValidRouteId,
    uuidWithRoute,
};
