'use strict';

// /healthz handler: shape, always-200, never throws.

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const assert = require('assert');
const { getHealth } = require('../src/routes/health');

function fakeRes() {
    return {
        body: undefined,
        json(b) { this.body = b; return this; },
    };
}

(async () => {
    const res = fakeRes();
    await getHealth({}, res);
    assert.ok(res.body && typeof res.body === 'object');
    assert.strictEqual(typeof res.body.ok, 'boolean');
    assert.strictEqual(typeof res.body.version, 'string');
    assert.ok(res.body.version.length > 0);
    assert.strictEqual(typeof res.body.uptime, 'number');
    assert.ok(['up', 'down'].includes(res.body.mongo));
    assert.ok(['up', 'down'].includes(res.body.redis));
    console.log('health tests passed (mongo:' + res.body.mongo + ' redis:' + res.body.redis + ')');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
