/**
 * XHTTP option handling shared by the panel form, REST, MCP, the node config
 * generator and the subscription builders.
 *
 * Every path used to carry its own copy of the "is this a range?" regex, which
 * let an inverted range ("5000-100") through the API and only surfaced as an
 * Xray that refuses to start. Keeping the rules here means a value accepted by
 * one entry point behaves the same in all of them.
 */

// Xray stores range bounds as int32.
const XHTTP_RANGE_MAX = 2147483647;

const XHTTP_PLACEMENT_VALUES = ['', 'query', 'header', 'path', 'cookie'];
const XHTTP_PADDING_PLACEMENT_VALUES = ['', 'query', 'header', 'cookie', 'queryInHeader'];
const XHTTP_DATA_PLACEMENT_VALUES = ['', 'body', 'header', 'cookie'];
const XHTTP_METHOD_VALUES = ['', 'GET', 'POST', 'PUT', 'PATCH'];
const XHTTP_PADDING_METHOD_VALUES = ['', 'tokenish', 'repeat-x'];

// Charset names xray-core resolves internally (PredefinedTable in
// transport/internet/splithttp/config.go). A literal ASCII alphabet is also
// accepted by the core, but a whitelist keeps the form and the API honest.
const XHTTP_SESSION_TABLE_VALUES = [
    '', 'uuid', 'ALPHABET', 'Alphabet', 'BASE36', 'Base62', 'HEX',
    'alphabet', 'base36', 'hex', 'number',
];

const XHTTP_SESSION_TABLE_SIZES = {
    ALPHABET: 26,
    Alphabet: 52,
    BASE36: 36,
    Base62: 62,
    HEX: 16,
    alphabet: 26,
    base36: 36,
    hex: 16,
    number: 10,
};

// xray-core refuses a session-ID space smaller than this (PR XTLS/Xray-core#6258).
const XHTTP_SESSION_ID_MIN_SPACE = 2.1e9;

/**
 * Parse an XHTTP range ("100-1000", or a bare "500" meaning 500-500).
 *
 * @param {*} raw
 * @returns {{from: number, to: number}|null} null when the value is absent or malformed
 */
function parseXhttpRange(raw) {
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!/^\d{1,10}(-\d{1,10})?$/.test(value)) return null;
    const [from, to = from] = value.split('-').map(Number);
    if (from > to) return null;
    if (to > XHTTP_RANGE_MAX) return null;
    return { from, to };
}

function isValidXhttpRange(raw) {
    return parseXhttpRange(raw) !== null;
}

/**
 * Keep a range field only when it is usable, otherwise store an empty string so
 * the core falls back to its own default. Xray treats a malformed range as a
 * fatal config error, which would take the whole node down over one typo.
 */
function sanitizeXhttpRange(raw) {
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    return isValidXhttpRange(value) ? value : '';
}

function isAllZeroRange(raw) {
    const range = parseXhttpRange(raw);
    return range !== null && range.from === 0 && range.to === 0;
}

/**
 * Size of the session-ID space a table/length pair can produce, used to mirror
 * the core's own lower bound before it rejects the config on startup.
 */
function sessionIdSpace(table, length) {
    const alphabet = XHTTP_SESSION_TABLE_SIZES[table];
    const range = parseXhttpRange(length);
    if (!alphabet || !range) return null;
    return Math.pow(alphabet, range.from);
}

/**
 * Validate one XHTTP inbound (main or extra) against the invariants xray-core
 * enforces at startup, plus the cross-field rules that would otherwise produce
 * an inbound no client can talk to.
 *
 * @param {Object} inbound - per-inbound config in DB shape (xhttp* fields)
 * @param {string} label - human-readable inbound name for the message
 * @returns {string|null} error message, or null when the inbound is valid
 */
function validateXhttpInbound(inbound, label = 'Inbound') {
    if (!inbound || (inbound.transport || 'tcp') !== 'xhttp') return null;

    const ranges = [
        ['padding size', inbound.xhttpXPaddingBytes],
        ['max post size', inbound.xhttpScMaxEachPostBytes],
        ['upload chunk size', inbound.xhttpUplinkChunkSize],
        ['min post interval', inbound.xhttpScMinPostsIntervalMs],
        ['xmux max concurrency', inbound.xhttpXmuxMaxConcurrency],
        ['xmux max request times', inbound.xhttpXmuxHMaxRequestTimes],
        ['xmux max reusable seconds', inbound.xhttpXmuxHMaxReusableSecs],
        ['session ID length', inbound.xhttpSessionIDLength],
    ];
    for (const [field, value] of ranges) {
        const raw = String(value === undefined || value === null ? '' : value).trim();
        if (raw && !isValidXhttpRange(raw)) {
            return `${label}: XHTTP ${field} must be a number or an ascending range within 0-${XHTTP_RANGE_MAX}`;
        }
    }

    // Only an all-zero range ("0", "0-0") is rejected — "0-1000" is a valid
    // lower bound and is already in use by existing nodes.
    if (isAllZeroRange(inbound.xhttpXPaddingBytes)) {
        return `${label}: XHTTP padding range must allow a non-zero size`;
    }

    const mode = inbound.xhttpMode || 'auto';
    // Anything other than a body upload sends one request per packet, which
    // only packet-up mode produces. Xray treats an omitted placement as body.
    const dataPlacement = inbound.xhttpUplinkDataPlacement || '';
    const effectivePlacement = dataPlacement || 'body';
    if (dataPlacement && dataPlacement !== 'body' && mode !== 'packet-up') {
        return `${label}: XHTTP ${dataPlacement} upload requires packet-up mode`;
    }
    if (dataPlacement && dataPlacement !== 'body' && !inbound.xhttpUplinkDataKey) {
        return `${label}: XHTTP ${dataPlacement} upload requires an uplink data key`;
    }
    if ((inbound.xhttpUplinkHTTPMethod === 'GET') && mode !== 'packet-up') {
        return `${label}: XHTTP GET upload requires packet-up mode`;
    }
    if (inbound.xhttpUplinkHTTPMethod === 'GET' && effectivePlacement === 'body') {
        return `${label}: XHTTP GET upload cannot carry data in the body`;
    }

    const tokenPattern = /^[A-Za-z0-9_-]{1,64}$/;
    const tokenFields = [
        ['uplink data key', inbound.xhttpUplinkDataKey],
        ['padding key', inbound.xhttpXPaddingKey],
        ['session key', inbound.xhttpSessionKey],
        ['sequence key', inbound.xhttpSeqKey],
    ];
    for (const [field, value] of tokenFields) {
        if (value && !tokenPattern.test(value)) {
            return `${label}: XHTTP ${field} must match [A-Za-z0-9_-]{1,64}`;
        }
    }

    // A key is meaningless for path placement (the value is appended to the URL)
    // and the core picks its own default for the other placements, so only the
    // session-ID charset needs a paired length.
    const table = inbound.xhttpSessionIDTable || '';
    const length = String(inbound.xhttpSessionIDLength || '').trim();
    if (table && table !== 'uuid') {
        if (!length) {
            return `${label}: XHTTP session ID table requires a session ID length`;
        }
        const range = parseXhttpRange(length);
        if (range.from < 1) {
            return `${label}: XHTTP session ID length must start above 0`;
        }
        const space = sessionIdSpace(table, length);
        if (space !== null && space < XHTTP_SESSION_ID_MIN_SPACE) {
            return `${label}: XHTTP session ID space is too small — use a longer ID or a larger table`;
        }
    }
    if (!table && length) {
        return `${label}: XHTTP session ID length requires a session ID table`;
    }

    return null;
}

/**
 * Run {@link validateXhttpInbound} over a node's main inbound and every extra.
 *
 * @param {Object} xray - node.xray in DB shape
 * @returns {string|null}
 */
function validateXrayXhttp(xray) {
    if (!xray) return null;
    const inbounds = [
        { label: 'Main inbound', value: xray },
        ...((xray.extraInbounds || []).map((value, index) => ({
            label: value?.label || `Extra inbound #${index + 1}`,
            value,
        }))),
    ];
    for (const { label, value } of inbounds) {
        const error = validateXhttpInbound(value, label);
        if (error) return error;
    }
    return null;
}

module.exports = {
    XHTTP_RANGE_MAX,
    XHTTP_PLACEMENT_VALUES,
    XHTTP_PADDING_PLACEMENT_VALUES,
    XHTTP_DATA_PLACEMENT_VALUES,
    XHTTP_METHOD_VALUES,
    XHTTP_PADDING_METHOD_VALUES,
    XHTTP_SESSION_TABLE_VALUES,
    isAllZeroRange,
    isValidXhttpRange,
    parseXhttpRange,
    sanitizeXhttpRange,
    sessionIdSpace,
    validateXhttpInbound,
    validateXrayXhttp,
};
