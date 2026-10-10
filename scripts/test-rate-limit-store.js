'use strict';

// Hybrid Redis/memory rate-limit store: counter shape, increment, reset.
// Runs against real Redis when available, memory fallback otherwise.

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const assert = require('assert');
const { createHybridStore } = require('../src/utils/rateLimiters');

(async () => {
    const store = createHybridStore('test', 60 * 1000);
    if (typeof store.init === 'function') store.init({ windowMs: 60 * 1000 });

    const key = 'unit-' + Date.now();
    const r1 = await store.increment(key);
    assert.strictEqual(r1.totalHits, 1, 'first hit is 1, got ' + r1.totalHits);
    assert.ok(r1.resetTime instanceof Date, 'resetTime is a Date');
    assert.ok(r1.resetTime.getTime() > Date.now(), 'resetTime is in the future');

    const r2 = await store.increment(key);
    assert.strictEqual(r2.totalHits, 2, 'second hit is 2, got ' + r2.totalHits);

    await store.resetKey(key);
    const r3 = await store.increment(key);
    assert.strictEqual(r3.totalHits, 1, 'after reset hit is 1, got ' + r3.totalHits);
    await store.resetKey(key);

    // Independent keys do not share buckets.
    const a = await store.increment('a-' + key);
    const b = await store.increment('b-' + key);
    assert.strictEqual(a.totalHits, 1);
    assert.strictEqual(b.totalHits, 1);
    await store.resetKey('a-' + key);
    await store.resetKey('b-' + key);

    console.log('rate limit store tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
