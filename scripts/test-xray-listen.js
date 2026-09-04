'use strict';

const assert = require('assert');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

// This test exercises form parsing only; avoid loading the optional TOTP stack.
const totpServicePath = require.resolve('../src/services/totpService');
require.cache[totpServicePath] = { exports: {} };

const HyNode = require('../src/models/hyNodeModel');
const configGenerator = require('../src/services/configGenerator');
const { isLoopbackAddress } = require('../src/services/nodeSetup');
const {
    parseXrayFormFields,
    validateXrayFormFields,
} = require('../src/routes/panel/helpers');

const parsed = parseXrayFormFields({
    'xray.listen': ' 127.0.0.1 ',
    'xray.transport': 'tcp',
    'xray.security': 'none',
    xray_extra_id: ['extra-1'],
    xray_extra_port: ['8444'],
    xray_extra_listen: [' ::1 '],
    xray_extra_inboundTag: ['vless-extra-1'],
    xray_extra_transport: ['ws'],
    xray_extra_security: ['none'],
});

assert.strictEqual(parsed.listen, '127.0.0.1');
assert.strictEqual(parsed.extraInbounds[0].listen, '::1');
assert.strictEqual(validateXrayFormFields(parsed, { port: 8443 }), null);

const defaults = parseXrayFormFields({
    'xray.listen': '',
    'xray.transport': 'tcp',
    'xray.security': 'none',
    xray_extra_id: ['extra-1'],
    xray_extra_port: ['8444'],
    xray_extra_listen: [''],
    xray_extra_inboundTag: ['vless-extra-1'],
    xray_extra_transport: ['tcp'],
    xray_extra_security: ['none'],
});
assert.strictEqual(defaults.listen, '0.0.0.0');
assert.strictEqual(defaults.extraInbounds[0].listen, '0.0.0.0');

assert.match(
    validateXrayFormFields({ ...parsed, listen: 'localhost' }, { port: 8443 }),
    /valid IPv4 or IPv6/
);
assert.match(
    validateXrayFormFields({
        ...parsed,
        extraInbounds: [{ ...parsed.extraInbounds[0], listen: '127.0.0.999' }],
    }, { port: 8443 }),
    /valid IPv4 or IPv6/
);

const node = new HyNode({
    name: 'listen-test',
    type: 'xray',
    ip: '192.0.2.10',
    port: 8443,
    xray: {
        listen: '127.0.0.1',
        transport: 'tcp',
        security: 'none',
        inboundTag: 'vless-in',
        apiPort: 61000,
        extraInbounds: [{
            id: 'extra-1',
            listen: '::1',
            port: 8444,
            inboundTag: 'vless-extra-1',
            transport: 'ws',
            security: 'none',
        }],
    },
});
assert.strictEqual(node.validateSync(), undefined);

const invalidNode = new HyNode({
    name: 'invalid-listen-test',
    type: 'xray',
    ip: '192.0.2.11',
    xray: { listen: 'localhost' },
});
assert.ok(invalidNode.validateSync()?.errors?.['xray.listen']);

const generated = JSON.parse(configGenerator.generateXrayConfig(node.toObject(), []));
const mainInbound = generated.inbounds.find(inbound => inbound.tag === 'vless-in');
const extraInbound = generated.inbounds.find(inbound => inbound.tag === 'vless-extra-1');
assert.strictEqual(mainInbound.listen, '127.0.0.1');
assert.strictEqual(extraInbound.listen, '::1');
assert.strictEqual(isLoopbackAddress('127.0.0.42'), true);
assert.strictEqual(isLoopbackAddress('::1'), true);
assert.strictEqual(isLoopbackAddress('0:0:0:0:0:0:0:1'), true);
assert.strictEqual(isLoopbackAddress('0.0.0.0'), false);

console.log('xray listen tests passed');
