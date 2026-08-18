const assert = require('assert');
const Module = require('module');

// Module paths use backslashes on Windows, so suffix checks compare against a
// normalized form or every stub silently misses and the test hits the database.
function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

function loadSubscription() {
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'qrcode') return {};
        if (normalizePath(parent?.filename).endsWith('/src/routes/subscription.js')) {
            if (request === '../../config') {
                return { BASE_URL: 'https://panel.example.com', DOMAIN: 'panel.example.com' };
            }
            if (request === '../models/hyUserModel') return {};
            if (request === '../models/hyNodeModel') return {};
            if (request === '../services/cacheService') return {};
            if (request === '../utils/logger') {
                return { debug() {}, info() {}, warn() {}, error() {} };
            }
            if (request === '../services/cryptoService') return {};
            if (request === '../middleware/i18n') {
                return { getDateLocale: () => 'en-US', normalizeLanguage: v => v || 'en' };
            }
            if (request === '../services/uaStatsService') return { track() {} };
            if (request === '../utils/hwidHeaders') return { extractHwidHeaders: () => null };
            if (request === '../services/hwidDeviceService') return {};
            if (request === '../services/webhookService') return { EVENTS: {}, emit() {} };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../src/routes/subscription')];
        return require('../src/routes/subscription');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/routes/subscription')];
    }
}

const { singboxRuleSetTag, vlessURIForInbound } = loadSubscription();
const { buildXrayStreamSettings } = require('../src/services/configGenerator');

// ---- rule-set tags ----------------------------------------------------------
// sing-geosite publishes attribute variants (`google@cn`, `geolocation-!cn`),
// so rejecting those characters would silently drop working rules.
{
    assert.strictEqual(singboxRuleSetTag('geosite', 'geolocation-!cn'), 'geosite-geolocation-!cn');
    assert.strictEqual(singboxRuleSetTag('geosite', 'google@cn'), 'geosite-google@cn');
    assert.strictEqual(singboxRuleSetTag('geosite', 'category-ads-all'), 'geosite-category-ads-all');
    assert.strictEqual(singboxRuleSetTag('geosite', 'x'), 'geosite-x');
    // Short forms the panel stores for Xray have no same-named list upstream.
    assert.strictEqual(singboxRuleSetTag('geosite', 'ru'), 'geosite-category-ru');

    // sing-geoip carries country codes only — provider lists would 404, and a
    // failing rule-set download makes sing-box discard the whole config.
    assert.strictEqual(singboxRuleSetTag('geoip', 'ru'), 'geoip-ru');
    assert.strictEqual(singboxRuleSetTag('geoip', 'telegram'), null);
    assert.strictEqual(singboxRuleSetTag('geoip', 'private'), null);

    // Nothing may escape the rule-set path.
    assert.strictEqual(singboxRuleSetTag('geosite', '../../etc/passwd'), null);
    assert.strictEqual(singboxRuleSetTag('geosite', 'a/b'), null);
    assert.strictEqual(singboxRuleSetTag('geoip', ''), null);
}

// ---- XHTTP hints in the vless URI ------------------------------------------
const node = {
    _id: 'n1',
    name: 'Frankfurt',
    flag: '',
    type: 'xray',
    domain: 'de.example.com',
    port: 443,
    xray: {},
};
const xhttpInbound = {
    port: 443,
    transport: 'xhttp',
    security: 'reality',
    fingerprint: 'chrome',
    realitySni: ['www.microsoft.com'],
    realityPublicKey: 'PUBKEY',
    realityShortIds: ['ab12'],
    xhttpPath: '/x',
    xhttpMode: 'packet-up',
    xhttpXPaddingBytes: '2000-3000',
    xhttpScMaxEachPostBytes: '500000',
    xhttpXmuxMaxConcurrency: '16-32',
    xhttpNoGrpcHeader: true,
};

function uriParams(inbound) {
    const uri = vlessURIForInbound({ xrayUuid: 'UUID' }, node, inbound);
    return new URL(uri.replace('vless://', 'http://')).searchParams;
}

{
    const params = uriParams(xhttpInbound);
    // The inbound rejects a padding length outside its range and drops oversized
    // posts, so URI-only clients must learn both. Two encodings, because the
    // client families read different ones.
    assert.strictEqual(params.get('x_padding_bytes'), '2000-3000');
    assert.deepStrictEqual(JSON.parse(params.get('extra')), {
        xPaddingBytes: '2000-3000',
        scMaxEachPostBytes: '500000',
    });
    // One-sided knobs stay out: extra keys make some parsers reject the URI.
    assert.ok(!params.get('extra').includes('xmux'));
    assert.ok(!params.get('extra').includes('noGRPCHeader'));
}

{
    const params = uriParams({ ...xhttpInbound, xhttpXPaddingBytes: '', xhttpScMaxEachPostBytes: '' });
    assert.strictEqual(params.get('x_padding_bytes'), null);
    assert.strictEqual(params.get('extra'), null);
}

{
    // Garbage never reaches the client: a malformed range is a fatal error.
    const params = uriParams({ ...xhttpInbound, xhttpXPaddingBytes: '100..200', xhttpScMaxEachPostBytes: 'abc' });
    assert.strictEqual(params.get('x_padding_bytes'), null);
    assert.strictEqual(params.get('extra'), null);
}

// ---- server-side ranges stay a superset of the client defaults --------------
{
    const stream = buildXrayStreamSettings({
        transport: 'xhttp',
        security: 'reality',
        xhttpPath: '/x',
        xhttpXPaddingBytes: '2000-3000',
        xhttpScMaxEachPostBytes: '500000',
    }, node);
    assert.strictEqual(stream.xhttpSettings.extra.xPaddingBytes, '100-3000');
    assert.strictEqual(stream.xhttpSettings.extra.scMaxEachPostBytes, '1000000');
}

{
    const stream = buildXrayStreamSettings({
        transport: 'xhttp',
        security: 'reality',
        xhttpXPaddingBytes: '50',
        xhttpScMaxEachPostBytes: '2000000',
    }, node);
    assert.strictEqual(stream.xhttpSettings.extra.xPaddingBytes, '50-1000');
    assert.strictEqual(stream.xhttpSettings.extra.scMaxEachPostBytes, '2000000');
}

{
    const stream = buildXrayStreamSettings({ transport: 'xhttp', security: 'reality' }, node);
    assert.strictEqual(stream.xhttpSettings.extra, undefined);
}

console.log('subscription rule-set and XHTTP tests passed');
