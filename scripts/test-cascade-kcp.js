'use strict';

const assert = require('assert');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const {
    validateTransportSecurity,
    sanitizeKcpInput,
    generateKcpPassword,
    tunnelSocketProtocol,
    portInRange,
    findHysteriaUdpConflict,
} = require('../src/utils/cascadeTransport');
const {
    buildCascadeTunnelStreamSettings,
    generateBridgeConfig,
} = require('../src/services/configGenerator');

// ---- transport / security combinations ------------------------------------
assert.strictEqual(validateTransportSecurity('kcp', 'none'), null);
assert.strictEqual(validateTransportSecurity('kcp', 'tls'), null);
assert.match(validateTransportSecurity('kcp', 'reality'), /mKCP/);
assert.match(validateTransportSecurity('ws', 'reality'), /WebSocket/);
assert.strictEqual(validateTransportSecurity('tcp', 'reality'), null);
assert.match(validateTransportSecurity('udp', 'none'), /tunnelTransport/);
assert.match(validateTransportSecurity('tcp', 'plain'), /tunnelSecurity/);

// ---- mKCP input sanitizing --------------------------------------------------
assert.deepStrictEqual(sanitizeKcpInput({}), { fields: {}, error: null });
assert.deepStrictEqual(
    sanitizeKcpInput({ kcpMtu: '1200', kcpUplinkCapacity: 50, kcpHeader: 'wechat' }).fields,
    { kcpMtu: 1200, kcpUplinkCapacity: 50, kcpHeader: 'wechat' }
);
assert.match(sanitizeKcpInput({ kcpMtu: 2000 }).error, /kcpMtu/);
assert.match(sanitizeKcpInput({ kcpTti: 5 }).error, /kcpTti/);
assert.match(sanitizeKcpInput({ kcpDownlinkCapacity: 1.5 }).error, /kcpDownlinkCapacity/);
assert.match(sanitizeKcpInput({ kcpUplinkCapacity: '1;reboot' }).error, /kcpUplinkCapacity/);
assert.match(sanitizeKcpInput({ kcpHeader: 'utp' }).error, /kcpHeader/);
// The password is generated server-side only and never taken from input.
assert.deepStrictEqual(sanitizeKcpInput({ kcpPassword: 'attacker' }).fields, {});

assert.match(generateKcpPassword(), /^[0-9a-f]{32}$/);
assert.notStrictEqual(generateKcpPassword(), generateKcpPassword());

assert.strictEqual(tunnelSocketProtocol({ tunnelTransport: 'kcp' }), 'udp');
assert.strictEqual(tunnelSocketProtocol({ tunnelTransport: 'tcp' }), 'tcp');
assert.strictEqual(tunnelSocketProtocol({}), 'tcp');

// ---- stream settings --------------------------------------------------------
const kcpLink = {
    _id: '64a1b2c3d4e5f6a7b8c9d0e1',
    name: 'kcp-test',
    tunnelTransport: 'kcp',
    tunnelSecurity: 'none',
    tunnelProtocol: 'vless',
    tunnelUuid: '5783a3e7-e373-51cd-8642-c83782b807c5',
    tunnelPort: 10086,
    kcpPassword: 'secret',
    kcpHeader: 'none',
};

for (const server of [false, true]) {
    const stream = buildCascadeTunnelStreamSettings(kcpLink, { server });
    assert.strictEqual(stream.network, 'kcp');
    assert.strictEqual(stream.security, 'none');
    // Defaults must beat Xray's own 5 MB/s uplink, otherwise mKCP is slower than TCP.
    assert.deepStrictEqual(stream.kcpSettings, { mtu: 1350, tti: 20, uplinkCapacity: 100, downlinkCapacity: 100 });
    // Removed from xray-core: their presence breaks config parsing.
    assert.ok(!('header' in stream.kcpSettings));
    assert.ok(!('seed' in stream.kcpSettings));
    assert.ok(!('sockopt' in stream));
    assert.deepStrictEqual(stream.finalmask, {
        udp: [{ type: 'mkcp-legacy', settings: { header: '', value: 'secret' } }],
    });
}

// Encryption is the innermost layer (first), camouflage header wraps it (last).
const masked = buildCascadeTunnelStreamSettings({
    ...kcpLink,
    kcpHeader: 'wechat',
    kcpMtu: 1200,
    kcpTti: 30,
    kcpUplinkCapacity: 40,
    kcpDownlinkCapacity: 200,
});
assert.deepStrictEqual(masked.kcpSettings, { mtu: 1200, tti: 30, uplinkCapacity: 40, downlinkCapacity: 200 });
assert.deepStrictEqual(masked.finalmask.udp, [
    { type: 'mkcp-legacy', settings: { header: '', value: 'secret' } },
    { type: 'mkcp-legacy', settings: { header: 'wechat', value: '' } },
]);

// A kcp link without a password must never produce an unencrypted config.
assert.throws(
    () => buildCascadeTunnelStreamSettings({ ...kcpLink, kcpPassword: '' }),
    /kcpPassword/
);

// TCP links are untouched by the kcp branch.
const tcpStream = buildCascadeTunnelStreamSettings({ ...kcpLink, tunnelTransport: 'tcp' });
assert.strictEqual(tcpStream.network, 'tcp');
assert.ok(tcpStream.sockopt);
assert.ok(!('kcpSettings' in tcpStream));
assert.ok(!('finalmask' in tcpStream));

// Reverse bridge config carries the kcp stream on its tunnel outbound.
const bridgeConfig = JSON.parse(generateBridgeConfig(kcpLink, { ip: '203.0.113.10' }));
const tunnel = bridgeConfig.outbounds.find(o => o.tag === 'tunnel');
assert.strictEqual(tunnel.streamSettings.network, 'kcp');
assert.strictEqual(tunnel.streamSettings.finalmask.udp[0].settings.value, 'secret');

// ---- Hysteria UDP port conflicts -------------------------------------------
assert.strictEqual(portInRange(25000, '20000-50000'), true);
assert.strictEqual(portInRange(20000, ' 20000 - 50000 '), true);
assert.strictEqual(portInRange(10086, '20000-50000'), false);
assert.strictEqual(portInRange(30000, '50000-20000'), false);
assert.strictEqual(portInRange(30000, ''), false);
assert.strictEqual(portInRange(30000, '20000-50000;rm'), false);

const hysteria = [{
    name: 'hy',
    port: 8443,
    portRange: '20000-50000',
    portConfigs: [
        { port: 9443, portRange: '', enabled: true },
        { port: 7443, portRange: '60000-61000', enabled: false },
    ],
}];
assert.strictEqual(findHysteriaUdpConflict(10086, hysteria), null);
assert.match(findHysteriaUdpConflict(8443, hysteria), /used by Hysteria/);
assert.match(findHysteriaUdpConflict(30000, hysteria), /port hopping range/);
assert.match(findHysteriaUdpConflict(9443, hysteria), /used by Hysteria/);
assert.strictEqual(findHysteriaUdpConflict(60500, hysteria), null);
// Hysteria listens on 443 when the node has no explicit port.
assert.match(findHysteriaUdpConflict(443, [{ name: 'hy', portRange: '' }]), /used by Hysteria/);

// ---- per-node Xray version filter --------------------------------------------
const HyNode = require('../src/models/hyNodeModel');
const CascadeLink = require('../src/models/cascadeLinkModel');
const cascadeService = require('../src/services/cascadeService');

async function runFilterTests() {
    let storedVersion = '26.5.9';
    const marked = [];
    HyNode.findById = () => ({ select: () => ({ lean: async () => ({ xrayVersion: storedVersion }) }) });
    CascadeLink.updateMany = async (filter, update) => {
        marked.push({ ids: filter._id.$in.map(String), lastError: update.$set.lastError });
        return { modifiedCount: filter._id.$in.length };
    };
    cascadeService._invalidateTopologyCache = async () => {};

    const node = { _id: 'n1', name: 'old-node' };
    const tcp = id => ({ _id: id, tunnelTransport: 'tcp' });
    const kcp = id => ({ _id: id, tunnelTransport: 'kcp' });

    // No mKCP links: nothing is queried or changed.
    const plain = { reverseLinks: [tcp('r1')], forwardLinks: [tcp('f1')], forwardHopLinks: [tcp('h1')] };
    assert.deepStrictEqual(await cascadeService.filterLinksForNodeXray(node, plain), plain);
    assert.strictEqual(marked.length, 0);

    // Old core: mKCP links are dropped, a forward chain with mKCP goes whole.
    const filtered = await cascadeService.filterLinksForNodeXray(node, {
        reverseLinks: [tcp('r1'), kcp('r2')],
        forwardLinks: [tcp('f1'), kcp('f2')],
        forwardHopLinks: [kcp('h1'), tcp('h2')],
    });
    assert.deepStrictEqual(filtered.reverseLinks.map(l => l._id), ['r1']);
    assert.deepStrictEqual(filtered.forwardLinks, []);
    assert.deepStrictEqual(filtered.forwardHopLinks.map(l => l._id), ['h2']);
    assert.deepStrictEqual(marked[0].ids.sort(), ['f1', 'f2', 'h1', 'r2']);
    assert.match(marked[0].lastError, /26\.6\.1.*old-node runs 26\.5\.9/);

    // Unknown version fails safe.
    storedVersion = '';
    const unknown = await cascadeService.filterLinksForNodeXray(node, { reverseLinks: [kcp('r2')] });
    assert.deepStrictEqual(unknown.reverseLinks, []);
    assert.match(marked[1].lastError, /Cannot detect Xray version/);

    // Supported core keeps everything.
    storedVersion = 'v26.6.1';
    const supported = { reverseLinks: [kcp('r2')], forwardLinks: [kcp('f2')], forwardHopLinks: [kcp('h1')] };
    assert.deepStrictEqual(await cascadeService.filterLinksForNodeXray(node, supported), supported);
    assert.strictEqual(marked.length, 2);
}

runFilterTests().then(() => {
    console.log('cascade kcp tests passed');
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
