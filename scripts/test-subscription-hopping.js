'use strict';

// Port-hopping gate: subscriptions carry only the single main-port entry
// unless hopping is enabled globally (?hopping=1 / settings toggle).

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
            if (request === '../utils/subscriptionFormat') return require('../src/utils/subscriptionFormat');
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

const sub = loadSubscription();
const { getNodeConfigs } = sub;

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

const OFF = { hoppingEnabled: false };
const ON = { hoppingEnabled: true };

// Legacy default (no opts): hopping published, as before.
assert.deepStrictEqual(getNodeConfigs(hyNode()).map(c => c.name), ['TLS', 'Hopping']);
assert.deepStrictEqual(getNodeConfigs(hyNode(), ON).map(c => c.name), ['TLS', 'Hopping']);

// Gate off: single TLS entry even with variants:'both'.
assert.deepStrictEqual(getNodeConfigs(hyNode(), OFF).map(c => c.name), ['TLS']);
assert.deepStrictEqual(getNodeConfigs(hyNode({ subscriptionVariants: 'both' }), OFF).map(c => c.name), ['TLS']);

// variants:'hopping' + gate off falls back to TLS (node never drops out).
assert.deepStrictEqual(getNodeConfigs(hyNode({ subscriptionVariants: 'hopping' }), OFF).map(c => c.name), ['TLS']);

// variants:'tls' unaffected either way.
assert.deepStrictEqual(getNodeConfigs(hyNode({ subscriptionVariants: 'tls' }), OFF).map(c => c.name), ['TLS']);
assert.deepStrictEqual(getNodeConfigs(hyNode({ subscriptionVariants: 'tls' }), ON).map(c => c.name), ['TLS']);

// Explicit portConfigs are admin intent and bypass the gate.
const withPorts = hyNode({
    portConfigs: [
        { name: 'Main', port: 443, portRange: '', enabled: true },
        { name: 'Hop', port: 443, portRange: '30000-40000', enabled: true },
    ],
});
assert.deepStrictEqual(getNodeConfigs(withPorts, OFF).map(c => c.name), ['Main', 'Hop']);

console.log('subscription hopping tests passed');
