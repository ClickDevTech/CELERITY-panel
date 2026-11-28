'use strict';

const assert = require('assert');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const {
    isGlobalIpv6,
    canonicalIpv6,
    normalizeIpv6Input,
    parseGlobalIpv6Addrs,
} = require('../src/utils/netAddress');
const {
    sanitizeIpVersionInput,
    isIpv6Link,
    cascadeDialAddress,
    validateLinkIpVersion,
    ipv6ListenerLinkFilter,
} = require('../src/utils/cascadeTransport');
const {
    generateBridgeConfig,
    generateRelayConfig,
    applyForwardChain,
} = require('../src/services/configGenerator');
const HyNode = require('../src/models/hyNodeModel');
const CascadeLink = require('../src/models/cascadeLinkModel');
const cascadeService = require('../src/services/cascadeService');

const V6_PORTAL = '2a01:4f8:c17:1::1';
const V6_BRIDGE = '2a02:6b8::2';

// ---- address validation ----------------------------------------------------
for (const ok of [V6_PORTAL, '2001:db8::1', '3fff:ffff::1']) assert.strictEqual(isGlobalIpv6(ok), true, ok);
for (const bad of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:1.2.3.4',
    '4000::1', 'fe80::1%eth0', '203.0.113.10', 'example.com', '', null, undefined, 123]) {
    assert.strictEqual(isGlobalIpv6(bad), false, String(bad));
}
assert.strictEqual(canonicalIpv6('2A01:04F8:0C17:0001:0000:0000:0000:0001'), V6_PORTAL);

assert.deepStrictEqual(normalizeIpv6Input(''), { value: '', error: null });
assert.deepStrictEqual(normalizeIpv6Input(undefined), { value: '', error: null });
assert.deepStrictEqual(normalizeIpv6Input('  2A01:4F8:C17:1:0:0:0:1 '), { value: V6_PORTAL, error: null });
for (const bad of ['fe80::1', '127.0.0.1', '2a01::1; reboot', `[${V6_PORTAL}]`]) {
    assert.ok(normalizeIpv6Input(bad).error, bad);
}

// ---- address detection output ----------------------------------------------
const linuxOutput = [
    `2: eth0    inet6 ${V6_PORTAL}/64 scope global \\       valid_lft forever preferred_lft forever`,
    '2: eth0    inet6 2a01:4f8:c17:1:aaaa:bbbb:cccc:dddd/64 scope global temporary dynamic \\       valid_lft 86000sec',
    '2: eth0    inet6 2a01:4f8:c17:1::9/64 scope global deprecated \\       valid_lft forever preferred_lft 0sec',
    '3: eth1    inet6 2A01:04F8:0C17:0001::0001/64 scope global \\       valid_lft forever',
    '2: eth0    inet6 fe80::1/64 scope link \\       valid_lft forever preferred_lft forever',
].join('\n');
assert.deepStrictEqual(parseGlobalIpv6Addrs(linuxOutput), [V6_PORTAL]);
assert.deepStrictEqual(parseGlobalIpv6Addrs(linuxOutput, { stableOnly: false }).sort(), [
    V6_PORTAL,
    '2a01:4f8:c17:1:aaaa:bbbb:cccc:dddd',
    '2a01:4f8:c17:1::9',
].sort());

const freebsdOutput = [
    'vtnet0: flags=8863<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> metric 0 mtu 1500',
    '\tinet6 fe80::1%vtnet0 prefixlen 64 scopeid 0x1',
    `\tinet6 ${V6_BRIDGE} prefixlen 64`,
    '\tinet6 2a02:6b8::abcd prefixlen 64 autoconf temporary',
    'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> metric 0 mtu 16384',
    '\tinet6 ::1 prefixlen 128',
].join('\n');
assert.deepStrictEqual(parseGlobalIpv6Addrs(freebsdOutput), [V6_BRIDGE]);
assert.deepStrictEqual(parseGlobalIpv6Addrs('NO_IP_TOOL'), []);
assert.deepStrictEqual(parseGlobalIpv6Addrs(''), []);

// ---- per-link address family -----------------------------------------------
assert.deepStrictEqual(sanitizeIpVersionInput({}), { fields: {}, error: null });
assert.deepStrictEqual(sanitizeIpVersionInput({ ipVersion: '6' }).fields, { ipVersion: 6 });
assert.deepStrictEqual(sanitizeIpVersionInput({ ipVersion: 4 }).fields, { ipVersion: 4 });
for (const bad of [5, '6;rm', 'ipv6', true, 0]) {
    assert.match(sanitizeIpVersionInput({ ipVersion: bad }).error, /ipVersion/, String(bad));
}

assert.strictEqual(isIpv6Link({ ipVersion: 6 }), true);
assert.strictEqual(isIpv6Link({ ipVersion: 4 }), false);
assert.strictEqual(isIpv6Link({}), false);

const portal = { _id: 'p1', name: 'portal', ip: '203.0.113.10', ipv6: V6_PORTAL };
const bridge = { _id: 'b1', name: 'bridge', ip: '198.51.100.20', ipv6: V6_BRIDGE };
const v4Only = { _id: 'n4', name: 'v4-only', ip: '192.0.2.30', ipv6: '' };

assert.strictEqual(cascadeDialAddress({ ipVersion: 4 }, portal), portal.ip);
assert.strictEqual(cascadeDialAddress({}, portal), portal.ip);
assert.strictEqual(cascadeDialAddress({ ipVersion: 6 }, portal), V6_PORTAL);
assert.strictEqual(cascadeDialAddress({}, { ...portal, ip: '' }, 'host.example.com'), 'host.example.com');
assert.throws(() => cascadeDialAddress({ ipVersion: 6, name: 'l' }, v4Only), /no IPv6 address/);

// Only the listening node needs an address: portal for reverse, bridge for forward.
assert.strictEqual(validateLinkIpVersion({ ipVersion: 4, mode: 'reverse', transport: 'kcp' }), null);
assert.strictEqual(validateLinkIpVersion({ mode: 'reverse', portalNode: v4Only }), null);
assert.strictEqual(validateLinkIpVersion({ ipVersion: 6, mode: 'reverse', transport: 'tcp', portalNode: portal, bridgeNode: v4Only }), null);
assert.strictEqual(validateLinkIpVersion({ ipVersion: 6, mode: 'forward', transport: 'tcp', portalNode: v4Only, bridgeNode: bridge }), null);
assert.match(validateLinkIpVersion({ ipVersion: 6, mode: 'reverse', transport: 'tcp', portalNode: v4Only, bridgeNode: bridge }),
    /Reverse link over IPv6 needs an IPv6 address on the portal "v4-only"/);
assert.match(validateLinkIpVersion({ ipVersion: 6, mode: 'forward', transport: 'tcp', portalNode: portal, bridgeNode: v4Only }),
    /Forward link over IPv6 needs an IPv6 address on the bridge "v4-only"/);
assert.match(validateLinkIpVersion({ ipVersion: 6, mode: 'reverse', transport: 'kcp', portalNode: portal, bridgeNode: bridge }),
    /mKCP/);

assert.deepStrictEqual(ipv6ListenerLinkFilter('n1'), {
    active: true,
    ipVersion: 6,
    $or: [
        { mode: { $ne: 'forward' }, portalNode: 'n1' },
        { mode: 'forward', bridgeNode: 'n1' },
    ],
});

// ---- models ----------------------------------------------------------------
const nodeError = ipv6 => new HyNode({ name: 'n', ip: '203.0.113.10', ipv6 }).validateSync()?.errors?.ipv6;
assert.strictEqual(nodeError(''), undefined);
assert.strictEqual(nodeError(V6_PORTAL), undefined);
for (const bad of ['::1', 'fe80::1', 'fd00::1', '203.0.113.10', 'not-an-ip']) assert.ok(nodeError(bad), bad);
assert.strictEqual(new HyNode({ name: 'n', ip: '203.0.113.10', ipv6: ` ${V6_PORTAL.toUpperCase()} ` }).ipv6, V6_PORTAL);

assert.strictEqual(new CascadeLink({}).ipVersion, 4);
assert.ok(new CascadeLink({ ipVersion: 5 }).validateSync()?.errors?.ipVersion);
assert.strictEqual(new CascadeLink({ ipVersion: 6 }).validateSync()?.errors?.ipVersion, undefined);

// ---- generated configs -----------------------------------------------------
const baseLink = {
    name: 'link',
    tunnelTransport: 'tcp',
    tunnelSecurity: 'none',
    tunnelProtocol: 'vless',
    tunnelUuid: '5783a3e7-e373-51cd-8642-c83782b807c5',
    tunnelPort: 10086,
};
const mkLink = (id, extra) => ({ ...baseLink, _id: `64a1b2c3d4e5f6a7b8c9d0${id}`, ...extra });

const bridgeTunnel = link => JSON.parse(generateBridgeConfig(link, portal)).outbounds.find(o => o.tag === 'tunnel');
assert.strictEqual(bridgeTunnel(mkLink('01', {})).settings.address, portal.ip);
assert.strictEqual(bridgeTunnel(mkLink('01', { ipVersion: 4 })).settings.address, portal.ip);
assert.strictEqual(bridgeTunnel(mkLink('01', { ipVersion: 6 })).settings.address, V6_PORTAL);
assert.throws(() => generateBridgeConfig(mkLink('01', { ipVersion: 6 }), v4Only), /no IPv6 address/);

// Relay: IPv6 upstream to the portal, IPv4 downstream from its bridge.
const relayConfig = JSON.parse(generateRelayConfig(
    mkLink('02', { ipVersion: 6 }),
    portal,
    [mkLink('03', { ipVersion: 4, tunnelPort: 10087 })]
));
assert.strictEqual(relayConfig.outbounds.find(o => o.tag === 'tunnel-up').settings.address, V6_PORTAL);
assert.ok(relayConfig.inbounds.every(ib => ib.listen === '0.0.0.0'));

// Forward chain mixing families hop by hop: v4 -> v6 -> v4.
const relay1 = { _id: 'r1', name: 'relay-1', ip: '198.51.100.31', ipv6: '2a02:6b8::31' };
const relay2 = { _id: 'r2', name: 'relay-2', ip: '198.51.100.32', ipv6: '2a02:6b8::32' };
const exit = { _id: 'x1', name: 'exit', ip: '198.51.100.33', ipv6: '' };
const chain = [
    mkLink('11', { mode: 'forward', ipVersion: 4, bridgeNode: relay1 }),
    mkLink('12', { mode: 'forward', ipVersion: 6, bridgeNode: relay2 }),
    mkLink('13', { mode: 'forward', bridgeNode: exit }),
];
const fwdConfig = { inbounds: [{ tag: 'client' }], outbounds: [], routing: { rules: [] } };
applyForwardChain(fwdConfig, chain, 'client');
const fwdAddress = id => fwdConfig.outbounds.find(o => o.tag === `fwd-${chain[id]._id.slice(-8)}`).settings.vnext[0].address;
assert.deepStrictEqual([0, 1, 2].map(fwdAddress), ['198.51.100.31', '2a02:6b8::32', '198.51.100.33']);

// ---- portal sync guard and pre-deploy checks --------------------------------
async function runServiceTests() {
    const marked = [];
    HyNode.findById = () => ({ select: () => ({ lean: async () => ({ xrayVersion: '26.6.1' }) }) });
    CascadeLink.updateMany = async (filter, update) => {
        marked.push({ ids: filter._id.$in.map(String), lastError: update.$set.lastError });
        return { modifiedCount: filter._id.$in.length };
    };
    cascadeService._invalidateTopologyCache = async () => {};

    const node = { _id: 'p1', name: 'portal' };
    const healthy = { forwardLinks: chain.slice(0, 2), reverseLinks: [], forwardHopLinks: [] };
    assert.deepStrictEqual(await cascadeService.filterLinksForNodeXray(node, healthy), healthy);
    assert.strictEqual(marked.length, 0);

    // A bridge that lost its IPv6 drops the whole chain instead of breaking the portal config.
    const broken = mkLink('14', { mode: 'forward', ipVersion: 6, bridgeNode: exit });
    const filtered = await cascadeService.filterLinksForNodeXray(node, {
        forwardLinks: [chain[0], broken],
        reverseLinks: [mkLink('15', { ipVersion: 6 })],
    });
    assert.deepStrictEqual(filtered.forwardLinks, []);
    assert.strictEqual(filtered.reverseLinks.length, 1);
    assert.match(marked.find(m => m.ids.includes(broken._id)).lastError, /Bridge "exit" has no IPv6 address/);

    // Pre-deploy: stub the SSH probe and answer per node.
    const withSsh = n => ({ ...n, ssh: { password: 'x' } });
    const sshPortal = withSsh(portal);
    const sshBridge = withSsh(bridge);
    let probe = {};
    const originalProbe = cascadeService._probeExec;
    cascadeService._probeExec = async (n, command) => {
        const answer = probe[n._id];
        return typeof answer === 'function' ? answer(command) : answer;
    };
    const reverseV6 = mkLink('21', { mode: 'reverse', ipVersion: 6 });

    probe = { p1: `2: eth0    inet6 ${V6_PORTAL}/64 scope global`, b1: 'ROUTE_OK' };
    await cascadeService._assertIpv6Path(reverseV6, sshPortal, sshBridge);

    probe = { p1: '2: eth0    inet6 2a01:4f8:c17:1::77/64 scope global', b1: 'ROUTE_OK' };
    await assert.rejects(cascadeService._assertIpv6Path(reverseV6, sshPortal, sshBridge),
        /Portal "portal" does not have the IPv6 address 2a01:4f8:c17:1::1.*The server has: 2a01:4f8:c17:1::77/);

    probe = { p1: '', b1: 'ROUTE_OK' };
    await assert.rejects(cascadeService._assertIpv6Path(reverseV6, sshPortal, sshBridge), /no public IPv6 at all/);

    probe = { p1: `inet6 ${V6_PORTAL}/64 scope global`, b1: 'NO_ROUTE' };
    await assert.rejects(cascadeService._assertIpv6Path(reverseV6, sshPortal, sshBridge),
        /Bridge "bridge" has no IPv6 route to 2a01:4f8:c17:1::1/);

    // Checks that cannot run are skipped rather than blocking the deploy.
    probe = { p1: 'NO_IP_TOOL', b1: null };
    await cascadeService._assertIpv6Path(reverseV6, sshPortal, sshBridge);

    // Forward: the bridge listens, the portal dials.
    const forwardV6 = mkLink('22', { mode: 'forward', ipVersion: 6 });
    let routeCommand = '';
    probe = { b1: `\tinet6 ${V6_BRIDGE} prefixlen 64`, p1: (cmd) => { routeCommand = cmd; return 'ROUTE_OK'; } };
    await cascadeService._assertIpv6Path(forwardV6, sshPortal, sshBridge);
    assert.match(routeCommand, /ip -6 route get 2a02:6b8::2/);

    await assert.rejects(cascadeService._assertIpv6Path(forwardV6, sshPortal, withSsh(v4Only)), /needs an IPv6 address on the bridge/);
    cascadeService._probeExec = originalProbe;

    // The dial probe never builds a command from anything but a global IPv6 literal and a port.
    for (const [host, port] of [['$(reboot)', 443], ['203.0.113.10', 443], ['fe80::1', 443], [V6_BRIDGE, 0], [V6_BRIDGE, 70000], [V6_BRIDGE, 'abc']]) {
        assert.deepStrictEqual(await cascadeService._dialFromNode(sshPortal, host, port), { reachable: false, latencyMs: null });
    }
    assert.deepStrictEqual(await cascadeService._dialFromNode(portal, V6_BRIDGE, 443), { reachable: false, latencyMs: null });
}

runServiceTests().then(() => {
    console.log('cascade ipv6 tests passed');
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
