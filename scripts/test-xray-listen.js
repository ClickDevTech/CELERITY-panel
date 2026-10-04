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
const { isLoopbackAddress, uploadFile } = require('../src/services/nodeSetup');
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

// XHTTP padding: "0-1000" is a legitimate lower bound, only an all-zero range
// (which disables padding while pretending to configure it) is rejected.
const withPadding = value => ({ transport: 'xhttp', security: 'none', xhttpXPaddingBytes: value });
assert.strictEqual(validateXrayFormFields(withPadding('0-1000'), { port: 8443 }), null);
assert.match(validateXrayFormFields(withPadding('0-0'), { port: 8443 }), /non-zero size/);
assert.match(validateXrayFormFields(withPadding('0'), { port: 8443 }), /non-zero size/);

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

const xhttpNode = node.toObject();
xhttpNode.xray.transport = 'xhttp';
xhttpNode.xray.security = 'none';
xhttpNode.xray.xhttpPath = '/api';
xhttpNode.xray.xhttpXPaddingHeader = 'X-Padding';
xhttpNode.xray.xhttpSessionIDTable = 'Base62';
xhttpNode.xray.xhttpSessionIDLength = '16-32';
const xhttpConfig = JSON.parse(configGenerator.generateXrayConfig(xhttpNode, []));
const xhttpInbound = xhttpConfig.inbounds.find(inbound => inbound.tag === 'vless-in');
assert.strictEqual(xhttpInbound.streamSettings.xhttpSettings.extra.xPaddingHeader, 'X-Padding');
assert.strictEqual(xhttpInbound.streamSettings.xhttpSettings.extra.sessionIDTable, 'Base62');
assert.strictEqual(xhttpInbound.streamSettings.xhttpSettings.extra.sessionIDLength, '16-32');

// connIdle: the Xray default is not written, so existing configs stay identical.
assert.deepStrictEqual(generated.policy.levels['0'], { statsUserUplink: true, statsUserDownlink: true });
const idleNode = node.toObject();
idleNode.xray.connIdle = 120;
const idleConfig = JSON.parse(configGenerator.generateXrayConfig(idleNode, []));
assert.strictEqual(idleConfig.policy.levels['0'].connIdle, 120);
assert.strictEqual(idleConfig.policy.levels['0'].statsUserUplink, true);
idleNode.xray.connIdle = 5;
assert.ok(!('connIdle' in JSON.parse(configGenerator.generateXrayConfig(idleNode, [])).policy.levels['0']),
    'out-of-range values never reach the config');
assert.ok(new HyNode({ name: 'idle', type: 'xray', ip: '192.0.2.12', xray: { connIdle: 5 } })
    .validateSync()?.errors?.['xray.connIdle']);
assert.ok(new HyNode({ name: 'idle', type: 'xray', ip: '192.0.2.12', xray: { connIdle: 60.5 } })
    .validateSync()?.errors?.['xray.connIdle']);
assert.strictEqual(parseXrayFormFields({ 'xray.connIdle': '120' }).connIdle, 120);
assert.strictEqual(parseXrayFormFields({ 'xray.connIdle': '' }).connIdle, 300);
assert.strictEqual(parseXrayFormFields({ 'xray.connIdle': '1e9' }).connIdle, 300);

assert.strictEqual(isLoopbackAddress('127.0.0.42'), true);
assert.strictEqual(isLoopbackAddress('::1'), true);
assert.strictEqual(isLoopbackAddress('0:0:0:0:0:0:0:1'), true);
assert.strictEqual(isLoopbackAddress('0.0.0.0'), false);

const selfCdnNode = new HyNode({
    _id: '64b000000000000000000001',
    name: 'self-referencing-cdn',
    type: 'cdn',
    cdn: {
        originNode: '64b000000000000000000001',
        domain: 'cdn.example.com',
        security: 'tls',
    },
});

// uploadFile must not leave modes to the remote sftp-server umask.
function fakeSftpConn(calls) {
    const { EventEmitter } = require('events');
    return {
        sftp(cb) {
            cb(null, {
                createWriteStream(path, options) {
                    calls.push(['open', path, options.mode]);
                    const stream = new EventEmitter();
                    stream.write = () => true;
                    stream.end = () => setImmediate(() => stream.emit('close'));
                    return stream;
                },
                chmod(path, mode, done) {
                    calls.push(['chmod', path, mode]);
                    setImmediate(done);
                },
                end() { calls.push(['end']); },
            });
        },
    };
}

(async () => {
    await assert.rejects(
        selfCdnNode.validate(),
        /CDN origin cannot be the CDN node itself/
    );

    const calls = [];
    await uploadFile(fakeSftpConn(calls), 'unit', '/etc/systemd/system/xray.service');
    await uploadFile(fakeSftpConn(calls), 'secret', '/etc/cc-agent/config.json', 0o600);
    assert.deepStrictEqual(calls, [
        ['open', '/etc/systemd/system/xray.service', 0o644],
        ['chmod', '/etc/systemd/system/xray.service', 0o644],
        ['end'],
        ['open', '/etc/cc-agent/config.json', 0o600],
        ['chmod', '/etc/cc-agent/config.json', 0o600],
        ['end'],
    ]);
    console.log('xray listen tests passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
