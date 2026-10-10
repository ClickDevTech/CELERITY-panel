'use strict';

// Subscription contract: every format renders a valid, non-empty payload for
// a plain Hysteria node, and the hopping gate holds across all of them.
// Guards the future builders/ split — any extraction must keep this green.

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

const sub = loadSubscription();

const user = {
    userId: 'u1',
    password: 'pw',
    username: 'Neo',
    xrayUuid: '00000000-0000-4000-8000-000000000001',
    traffic: { tx: 10, rx: 20 },
    trafficLimit: 0,
    expireAt: null,
    groups: [],
};
const node = {
    type: 'hysteria',
    name: 'Amsterdam',
    flag: 'NL',
    ip: '203.0.113.20',
    port: 443,
    portRange: '20000-50000',
    subscriptionVariants: 'both',
};
const nodes = [node];

const OFF = { hoppingEnabled: false };
const ON = { hoppingEnabled: true };

// --- URI ---
{
    const off = sub.generateSubscriptionData(user, nodes, 'uri', 'curl/8.0', '', null, OFF);
    assert.ok(off.content.includes('hysteria2://'), 'uri body');
    assert.ok(!off.content.includes('mport='), 'no hopping when off');
    const on = sub.generateSubscriptionData(user, nodes, 'uri', 'curl/8.0', '', null, ON);
    assert.ok(on.content.includes('mport=20000-50000'), 'hopping when on');
}

// --- Clash: one proxy vs two ---
{
    const off = sub.generateSubscriptionData(user, nodes, 'clash', 'Clash-Verge/2.0', '', null, OFF);
    const on = sub.generateSubscriptionData(user, nodes, 'clash', 'Clash-Verge/2.0', '', null, ON);
    const count = (s) => (s.content.match(/^\s+type: hysteria2$/gm) || []).length;
    assert.strictEqual(count(off), 1, 'clash off: 1 proxy, got ' + count(off));
    assert.strictEqual(count(on), 2, 'clash on: 2 proxies, got ' + count(on));
}

// --- Sing-box: valid JSON, hysteria2 entry count follows the gate ---
{
    for (const [opts, want] of [[OFF, 1], [ON, 2]]) {
        const data = sub.generateSubscriptionData(user, nodes, 'singbox', 'sing-box/1.9', '', null, opts);
        const json = JSON.parse(data.content);
        assert.ok(Array.isArray(json.outbounds), 'outbounds array');
        const hy = json.outbounds.filter((o) => o.type === 'hysteria2');
        assert.strictEqual(hy.length, want, `singbox hysteria2 entries, want ${want}`);
    }
}

// --- Shadowrocket: base64 of a valid URI list ---
{
    const data = sub.generateSubscriptionData(user, nodes, 'shadowrocket', 'Shadowrocket/123', '', null, OFF);
    const decoded = Buffer.from(data.content, 'base64').toString('utf8');
    assert.ok(decoded.includes('hysteria2://'), 'decoded uri list');
    assert.ok(!decoded.includes('mport='), 'no hopping when off');
}

// --- v2ray-json / xray-json: parseable ---
{
    const v2 = sub.generateSubscriptionData(user, nodes, 'v2ray-json', 'v2rayNG/1.0', '', null, OFF);
    assert.ok(typeof JSON.parse(v2.content) === 'object');
    const xj = sub.generateSubscriptionData(user, nodes, 'xray-json', 'HAPP/2.0', '', null, OFF);
    assert.ok(typeof JSON.parse(xj.content) === 'object');
}

// --- Snapshot fields always present (fresh-userinfo contract) ---
{
    const data = sub.generateSubscriptionData(user, nodes, 'uri', 'curl/8.0', '', null, OFF);
    assert.deepStrictEqual(data.traffic, { tx: 10, rx: 20 });
    assert.strictEqual(data.username, 'Neo');
    assert.ok(typeof data.profileTitle === 'string');
    assert.ok(typeof data.contentFormat === 'string');
}

console.log('subscription contract tests passed');
