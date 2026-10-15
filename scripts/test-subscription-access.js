'use strict';

// Group visibility default: groupless users see all nodes unless locked down.

const assert = require('assert');
const Module = require('module');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

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

const { filterNodesByGroups } = loadSubscription();
assert.strictEqual(typeof filterNodesByGroups, 'function');

const G1 = { _id: 'g1', name: 'EU' };
const G2 = { _id: 'g2', name: 'Asia' };
const nodes = [
    { name: 'a', groups: [G1] },
    { name: 'b', groups: [] },
    { name: 'c', groups: [G2] },
];
const names = (list) => list.map((n) => n.name);

// Groupless user, default policy: sees everything.
assert.deepStrictEqual(names(filterNodesByGroups(nodes, [], undefined)), ['a', 'b', 'c']);
assert.deepStrictEqual(names(filterNodesByGroups(nodes, [], 'all')), ['a', 'b', 'c']);
// Strict policy: sees nothing.
assert.deepStrictEqual(filterNodesByGroups(nodes, [], 'none'), []);
// Grouped user: strict intersection, unaffected by the policy.
assert.deepStrictEqual(names(filterNodesByGroups(nodes, ['g1'], undefined)), ['a']);
assert.deepStrictEqual(names(filterNodesByGroups(nodes, ['g1'], 'none')), ['a']);
assert.deepStrictEqual(names(filterNodesByGroups(nodes, ['nope'], 'all')), []);
assert.deepStrictEqual(filterNodesByGroups([], [], 'all'), []);

console.log('subscription access tests passed');
