'use strict';

// Hysteria subscriptionVariants: which of the TLS / Hopping entries a node
// publishes, through the real getNodeConfigs (issue #24).

const assert = require('assert');
const Module = require('module');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

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

const { getNodeConfigs } = loadSubscription();
const { normalizeSubscriptionVariants } = require('../src/utils/helpers');

function hyNode(overrides = {}) {
    return {
        type: 'hysteria',
        name: 'Amsterdam',
        ip: '203.0.113.20',
        port: 443,
        portRange: '20000-50000',
        ...overrides,
    };
}

const names = node => getNodeConfigs(node).map(cfg => cfg.name);

// Nodes stored before the field existed publish both, as before.
assert.deepStrictEqual(names(hyNode()), ['TLS', 'Hopping']);
assert.deepStrictEqual(names(hyNode({ subscriptionVariants: 'both' })), ['TLS', 'Hopping']);

assert.deepStrictEqual(names(hyNode({ subscriptionVariants: 'tls' })), ['TLS']);

const hoppingOnly = getNodeConfigs(hyNode({ subscriptionVariants: 'hopping' }));
assert.deepStrictEqual(hoppingOnly.map(cfg => cfg.name), ['Hopping']);
assert.strictEqual(hoppingOnly[0].portRange, '20000-50000');

assert.deepStrictEqual(
    names(hyNode({ subscriptionVariants: 'hopping', portRange: '' })),
    ['TLS'],
    'hopping-only without a range falls back to TLS instead of dropping the node'
);

// Explicit portConfigs carry their own enabled flags and are not filtered.
const withPortConfigs = hyNode({
    subscriptionVariants: 'tls',
    portConfigs: [
        { name: 'Main', port: 443, portRange: '', enabled: true },
        { name: 'Hop', port: 443, portRange: '30000-40000', enabled: true },
        { name: 'Off', port: 8443, portRange: '', enabled: false },
    ],
});
assert.deepStrictEqual(names(withPortConfigs), ['Main', 'Hop']);

assert.deepStrictEqual(getNodeConfigs({ type: 'xray', subscriptionVariants: 'tls' }), []);

assert.strictEqual(normalizeSubscriptionVariants('tls'), 'tls');
assert.strictEqual(normalizeSubscriptionVariants('hopping'), 'hopping');
assert.strictEqual(normalizeSubscriptionVariants('both'), 'both');
for (const bad of [undefined, null, '', 'TLS', '<script>', ['tls'], { $ne: 'x' }]) {
    assert.strictEqual(normalizeSubscriptionVariants(bad), 'both', `rejects ${JSON.stringify(bad)}`);
}

console.log('subscription variants tests passed');
