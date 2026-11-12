'use strict';

// Virtual node probe settings: input normalization and the burstObservatory
// emitted into Xray JSON profiles.

const assert = require('assert');
const Module = require('module');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const {
    normalizeObservatoryHttpMethod,
    normalizeVirtualObservatory,
} = require('../src/utils/virtualObservatory');

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

// Subscription touches Mongo and Redis at require time.
function loadSubscription() {
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'qrcode') return {};
        if (normalizePath(parent?.filename).endsWith('/src/routes/subscription.js')) {
            if (request === '../../config') {
                return { BASE_URL: 'https://panel.example.com', PANEL_DOMAIN: 'panel.example.com' };
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

// ---- normalization ---------------------------------------------------------
{
    assert.strictEqual(normalizeObservatoryHttpMethod(undefined), 'HEAD');
    assert.strictEqual(normalizeObservatoryHttpMethod(''), 'HEAD');
    assert.strictEqual(normalizeObservatoryHttpMethod('  '), 'HEAD');
    assert.strictEqual(normalizeObservatoryHttpMethod('get'), 'GET');
    assert.strictEqual(normalizeObservatoryHttpMethod(' GET '), 'GET');
    assert.strictEqual(normalizeObservatoryHttpMethod('Head'), 'HEAD');
    assert.strictEqual(normalizeObservatoryHttpMethod('POST'), null,
        'Xray reads the body for GET only, other methods are refused');
    assert.strictEqual(normalizeObservatoryHttpMethod(['GET']), null);
    assert.strictEqual(normalizeObservatoryHttpMethod(1), null);

    assert.deepStrictEqual(normalizeVirtualObservatory(undefined).value, {
        destination: 'http://www.gstatic.com/generate_204',
        connectivity: '',
        interval: '1m',
        timeout: '5s',
        sampling: 3,
        httpMethod: 'HEAD',
    });
    const custom = normalizeVirtualObservatory({
        destination: ' https://cdn.example.com/probe.bin ',
        interval: '30s',
        sampling: '5',
        httpMethod: 'get',
    }).value;
    assert.strictEqual(custom.destination, 'https://cdn.example.com/probe.bin');
    assert.strictEqual(custom.interval, '30s');
    assert.strictEqual(custom.sampling, 5);
    assert.strictEqual(custom.httpMethod, 'GET');
    assert.ok(normalizeVirtualObservatory({ httpMethod: 'OPTIONS' }).error);
    assert.ok(!normalizeVirtualObservatory({ destination: 42 }).error,
        'a non-string URL falls back to the default instead of throwing');
}

// ---- schema ----------------------------------------------------------------
{
    const HyNode = require('../src/models/hyNodeModel');
    const node = new HyNode({ name: 'v', type: 'virtual', virtual: { sources: [] } });
    assert.strictEqual(node.virtual.observatory.httpMethod, 'HEAD');
    node.virtual.observatory.httpMethod = 'get';
    assert.strictEqual(node.virtual.observatory.httpMethod, 'GET');
    node.virtual.observatory.httpMethod = 'POST';
    assert.ok(node.validateSync()?.errors?.['virtual.observatory.httpMethod']);
}

// ---- Xray JSON -------------------------------------------------------------
{
    const { xrayJSON } = loadSubscription();
    const user = {
        userId: 'u1',
        xrayUuid: '11111111-1111-1111-1111-111111111111',
    };
    const source = {
        _id: 's1',
        name: 'Source',
        flag: '',
        type: 'xray',
        active: true,
        ip: '203.0.113.10',
        domain: 'de.example.com',
        port: 443,
        xray: {
            transport: 'tcp',
            security: 'reality',
            flow: 'xtls-rprx-vision',
            realityPublicKey: 'PUBLICKEY',
            realityShortIds: ['abcd'],
            realityServerNames: ['www.example.com'],
            realityDest: 'www.example.com:443',
            fingerprint: 'chrome',
            extraInbounds: [],
        },
    };
    function virtualNode(strategy, observatory) {
        return {
            _id: 'v1',
            name: 'Auto',
            flag: '',
            type: 'virtual',
            active: true,
            virtual: { strategy, fallbackToFirst: true, observatory },
            _resolvedSources: [source],
        };
    }
    function profileFor(node) {
        const profiles = xrayJSON(user, [node], null);
        assert.strictEqual(profiles.length, 1);
        return profiles[0];
    }

    const getProfile = profileFor(virtualNode('leastLoad', { httpMethod: 'GET' }));
    assert.strictEqual(getProfile.burstObservatory.pingConfig.httpMethod, 'GET');

    const headProfile = profileFor(virtualNode('leastLoad', { httpMethod: 'HEAD' }));
    assert.ok(!('httpMethod' in headProfile.burstObservatory.pingConfig),
        'HEAD is the Xray default, so the field is omitted');

    const legacyProfile = profileFor(virtualNode('leastLoad', {}));
    assert.ok(!('httpMethod' in legacyProfile.burstObservatory.pingConfig));

    const leastPing = profileFor(virtualNode('leastPing', { httpMethod: 'GET' }));
    assert.ok(!leastPing.burstObservatory);
    assert.ok(!('httpMethod' in leastPing.observatory),
        'the regular observatory has no method setting');
}

console.log('test-virtual-observatory: ok');
process.exit(0);
