'use strict';

// Subscription format helpers: UA detection order, ?format validation,
// ETag stability and userinfo refresh (VamPanel internals round).

const assert = require('assert');
const {
    detectFormat,
    isHappUa,
    isIncyUa,
    isXrayProfileClient,
    isBrowser,
    normalizeFormatParam,
    computeEtag,
    refreshSubscriptionUserinfo,
} = require('../src/utils/subscriptionFormat');

// --- detectFormat ---
assert.strictEqual(detectFormat('Shadowrocket/123'), 'shadowrocket');
assert.strictEqual(detectFormat('HAPP/2.0'), 'uri');
assert.strictEqual(detectFormat('Incy/1.0'), 'uri');
// Hiddify UA contains "ClashMeta" — sing-box must win (order matters).
assert.strictEqual(detectFormat('HiddifyNext/4.0.5 (android) like ClashMeta v2ray sing-box'), 'singbox');
assert.strictEqual(detectFormat('sing-box/1.9'), 'singbox');
assert.strictEqual(detectFormat('ClashMeta/1.0'), 'clash');
assert.strictEqual(detectFormat('Clash-Verge/2.0'), 'clash');
assert.strictEqual(detectFormat('Stash/1.0'), 'clash');
assert.strictEqual(detectFormat('curl/8.0'), 'uri');
assert.strictEqual(detectFormat(''), 'uri');
assert.strictEqual(detectFormat(null), 'uri');

// --- UA predicates ---
assert.strictEqual(isHappUa('HAPP/2.0'), true);
assert.strictEqual(isHappUa('happ-android'), true);
assert.strictEqual(isHappUa('Clash'), false);
assert.strictEqual(isIncyUa('Incy/1.0'), true);
assert.strictEqual(isIncyUa('HAPP'), false);
assert.strictEqual(isXrayProfileClient('HAPP'), true);
assert.strictEqual(isXrayProfileClient('Incy'), true);
assert.strictEqual(isXrayProfileClient('sing-box'), false);

// --- isBrowser ---
assert.strictEqual(isBrowser({ headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 Chrome' } }), true);
assert.strictEqual(isBrowser({ headers: { accept: '*/*', 'user-agent': 'Mozilla/5.0' } }), false);
assert.strictEqual(isBrowser({ headers: { accept: 'text/html', 'user-agent': 'sing-box' } }), false);

// --- normalizeFormatParam: known pass through, junk -> null ---
for (const f of ['clash', 'yaml', 'singbox', 'json', 'uri', 'raw', 'shadowrocket', 'v2ray-json', 'xray-json']) {
    assert.strictEqual(normalizeFormatParam(f), f, f);
}
assert.strictEqual(normalizeFormatParam('CLASH'), 'clash');
assert.strictEqual(normalizeFormatParam(' clash '), 'clash');
assert.strictEqual(normalizeFormatParam('yaml-ish'), null);
assert.strictEqual(normalizeFormatParam('exe'), null);
assert.strictEqual(normalizeFormatParam(''), null);
assert.strictEqual(normalizeFormatParam(null), null);
assert.strictEqual(normalizeFormatParam(undefined), null);

// --- computeEtag: stable, quoted hex, content-sensitive ---
const e1 = computeEtag('hello');
const e2 = computeEtag('hello');
const e3 = computeEtag('world');
assert.strictEqual(e1, e2);
assert.notStrictEqual(e1, e3);
assert.match(e1, /^"[0-9a-f]{40}"$/);
assert.match(computeEtag(''), /^"[0-9a-f]{40}"$/);

// --- refreshSubscriptionUserinfo: volatile fields follow the fresh user ---
const data = {
    content: 'vless://...',
    profileTitle: 'Old',
    username: 'old',
    traffic: { tx: 1, rx: 2 },
    trafficLimit: 5,
    expireAt: new Date('2020-01-01'),
};
const user = {
    userId: 'u1',
    username: 'neo',
    traffic: { tx: 100, rx: 200 },
    trafficLimit: 1000,
    expireAt: new Date('2030-01-01'),
};
const out = refreshSubscriptionUserinfo(data, user, 'Premium');
assert.strictEqual(out, data, 'mutates in place');
assert.deepStrictEqual(out.traffic, { tx: 100, rx: 200 });
assert.strictEqual(out.trafficLimit, 1000);
assert.strictEqual(out.username, 'neo');
assert.strictEqual(out.profileTitle, 'Premium');
assert.strictEqual(out.content, 'vless://...', 'content untouched');
assert.strictEqual(refreshSubscriptionUserinfo(null, user), null);
assert.strictEqual(refreshSubscriptionUserinfo(data, null), data);

console.log('subscription format tests passed');
