'use strict';

// Cascade configs against current Xray rules: VLESS Reverse Proxy instead of
// the removed `reverse` section, VLESS Encryption on plaintext links, TLS
// without allowInsecure, and per-link core requirements.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const gen = require('../src/services/configGenerator');
const cryptoService = require('../src/services/cryptoService');
const {
    MIN_CASCADE_XRAY_VERSION,
    cascadeProtocol,
    usesLinkVlessEncryption,
    linkXrayRequirement,
} = require('../src/utils/cascadeTransport');

const UUID = '5783a3e7-e373-51cd-8642-c83782b807c5';
const portal = { _id: 'p1', name: 'portal', ip: '45.10.20.30' };
const exit = { _id: 'b1', name: 'exit', ip: '91.200.10.20' };

function link(overrides = {}) {
    return {
        _id: '64d000000000000000000001',
        name: 'l',
        mode: 'forward',
        tunnelUuid: UUID,
        tunnelPort: 10086,
        tunnelProtocol: 'vless',
        tunnelTransport: 'tcp',
        tunnelSecurity: 'none',
        bridgeNode: exit,
        ...overrides,
    };
}

const findDeep = (obj, key, out = []) => {
    if (Array.isArray(obj)) obj.forEach(v => findDeep(v, key, out));
    else if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
            if (k === key) out.push(v);
            findDeep(v, key, out);
        }
    }
    return out;
};

// ---- protocol and requirements ----------------------------------------------
assert.strictEqual(cascadeProtocol(link({ tunnelProtocol: 'vmess' })), 'vmess');
assert.strictEqual(cascadeProtocol(link({ mode: 'reverse', tunnelProtocol: 'vmess' })), 'vless', 'reverse always runs VLESS');
assert.strictEqual(usesLinkVlessEncryption(link()), true);
assert.strictEqual(usesLinkVlessEncryption(link({ tunnelProtocol: 'vmess' })), false);
assert.strictEqual(usesLinkVlessEncryption(link({ tunnelSecurity: 'reality' })), false);

assert.strictEqual(linkXrayRequirement(link({ tunnelSecurity: 'reality' })), null);
assert.strictEqual(linkXrayRequirement(link({ tunnelProtocol: 'vmess' })), null);
assert.deepStrictEqual(linkXrayRequirement(link()), { version: '25.9.5', feature: 'VLESS Encryption' });
assert.deepStrictEqual(linkXrayRequirement(link({ mode: 'reverse', tunnelSecurity: 'tls' })),
    { version: MIN_CASCADE_XRAY_VERSION, feature: 'VLESS Reverse Proxy' });
assert.deepStrictEqual(linkXrayRequirement(link({ mode: 'reverse' })),
    { version: MIN_CASCADE_XRAY_VERSION, feature: 'VLESS Reverse Proxy' }, 'the highest requirement wins');
assert.deepStrictEqual(linkXrayRequirement(link({ mode: 'reverse', tunnelTransport: 'kcp', kcpPassword: 'x' })),
    { version: '26.6.1', feature: 'mKCP' });

// ---- VLESS Encryption on plaintext links ------------------------------------
{
    const fwd = link();
    const hop = JSON.parse(gen.generateForwardHopConfig(fwd));
    const head = { outbounds: [], routing: { rules: [] } };
    gen.applyForwardChain(head, [fwd], ['vless-in']);

    const decryption = hop.inbounds[0].settings.decryption;
    const encryption = head.outbounds[0].settings.vnext[0].users[0].encryption;
    const server = /^mlkem768x25519plus\.native\.600s\.([A-Za-z0-9_-]{43})$/.exec(decryption);
    const client = /^mlkem768x25519plus\.native\.0rtt\.([A-Za-z0-9_-]{43})$/.exec(encryption);
    assert.ok(server, `server decryption: ${decryption}`);
    assert.ok(client, `client encryption: ${encryption}`);
    assert.strictEqual(cryptoService.deriveX25519PublicKey(server[1]), client[1], 'both ends hold one key pair');

    const again = JSON.parse(gen.generateForwardHopConfig(link()));
    assert.strictEqual(again.inbounds[0].settings.decryption, decryption, 'keys are stable across deploys');
    const otherLink = JSON.parse(gen.generateForwardHopConfig(link({ _id: '64d000000000000000000002' })));
    assert.notStrictEqual(otherLink.inbounds[0].settings.decryption, decryption, 'keys differ per link');
    const newUuid = JSON.parse(gen.generateForwardHopConfig(link({ tunnelUuid: 'a6b0c3f3-1b6c-4d3e-9a51-2f6c1c7e0d10' })));
    assert.notStrictEqual(newUuid.inbounds[0].settings.decryption, decryption, 'a new tunnel UUID rotates the key');

    // REALITY links and VMess keep their own protection.
    const reality = link({ tunnelSecurity: 'reality', realityPrivateKey: 'k', realityPublicKey: 'p' });
    assert.strictEqual(JSON.parse(gen.generateForwardHopConfig(reality)).inbounds[0].settings.decryption, 'none');
    const vmessHead = { outbounds: [], routing: { rules: [] } };
    gen.applyForwardChain(vmessHead, [link({ tunnelProtocol: 'vmess' })], ['vless-in']);
    assert.deepStrictEqual(vmessHead.outbounds[0].settings.vnext[0].users[0], { id: UUID, alterId: 0, security: 'auto' });
}

// ---- VLESS Reverse Proxy ----------------------------------------------------
{
    const rev = link({ mode: 'reverse', tunnelProtocol: 'vmess', muxEnabled: true });
    const portalCfg = { inbounds: [], outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } };
    gen.applyReversePortal(portalCfg, [rev], ['vless-in']);
    assert.strictEqual(portalCfg.reverse, undefined, 'legacy reverse section is gone');
    const connector = portalCfg.inbounds.find(i => i.tag === 'bridge-conn-00000001');
    assert.strictEqual(connector.protocol, 'vless');
    assert.deepStrictEqual(connector.settings.clients, [{ id: UUID, reverse: { tag: 'portal-00000001' } }]);
    assert.match(connector.settings.decryption, /^mlkem768x25519plus\./);
    assert.deepStrictEqual(portalCfg.routing.rules, [{ type: 'field', inboundTag: ['vless-in'], outboundTag: 'portal-00000001' }]);

    const bridge = JSON.parse(gen.generateBridgeConfig(rev, portal));
    assert.strictEqual(bridge.reverse, undefined);
    const tunnel = bridge.outbounds.find(o => o.tag === 'tunnel');
    assert.strictEqual(tunnel.protocol, 'vless');
    assert.strictEqual(tunnel.mux, undefined, 'reverse connections are multiplexed by the core');
    assert.deepStrictEqual(Object.keys(tunnel.settings).sort(), ['address', 'encryption', 'id', 'port', 'reverse']);
    assert.deepStrictEqual(tunnel.settings.reverse, { tag: 'bridge' });
    assert.strictEqual(tunnel.settings.address, portal.ip);
    assert.ok(bridge.routing.rules.some(r => r.inboundTag?.[0] === 'bridge' && r.outboundTag === 'freedom'));
    assert.strictEqual(findDeep(bridge, 'domain').length, 0, 'no tunnel-domain rules');

    const down = link({ _id: '64d000000000000000000003', mode: 'reverse', tunnelSecurity: 'reality', realityPrivateKey: 'k' });
    const relay = JSON.parse(gen.generateRelayConfig(rev, portal, [down]));
    assert.strictEqual(relay.reverse, undefined);
    assert.deepStrictEqual(relay.outbounds[0].settings.reverse, { tag: 'bridge-up' });
    assert.deepStrictEqual(relay.inbounds[0].settings.clients[0].reverse, { tag: 'portal-down-00000003' });
    assert.strictEqual(relay.inbounds[0].settings.decryption, 'none');
    assert.ok(relay.routing.rules.some(r => r.inboundTag?.[0] === 'bridge-up' && r.outboundTag === 'portal-down-00000003'));
}

// ---- TLS with the panel certificate -----------------------------------------
{
    const tls = link({ tunnelSecurity: 'tls' });
    assert.throws(() => gen.buildCascadeTunnelStreamSettings(tls, { server: true }), err => err.code === 'PANEL_CERT_UNAVAILABLE');

    const certDir = path.join(__dirname, '..', 'greenlock.d', 'live', process.env.PANEL_DOMAIN);
    const { statSync, readFileSync } = fs;
    const fake = { 'fullchain.pem': '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n', 'privkey.pem': '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n' };
    const pick = p => (String(p).startsWith(certDir) ? fake[path.basename(String(p))] : undefined);
    fs.statSync = (p, ...rest) => (pick(p) !== undefined ? { mtimeMs: 1 } : statSync(p, ...rest));
    fs.readFileSync = (p, ...rest) => (pick(p) !== undefined ? pick(p) : readFileSync(p, ...rest));
    try {
        gen.invalidatePanelCertCache();
        const server = gen.buildCascadeTunnelStreamSettings(tls, { server: true });
        assert.deepStrictEqual(server.tlsSettings.certificates[0].certificate,
            ['-----BEGIN CERTIFICATE-----', 'AAA', '-----END CERTIFICATE-----']);
        const client = gen.buildCascadeTunnelStreamSettings(tls);
        assert.deepStrictEqual(client.tlsSettings, { serverName: process.env.PANEL_DOMAIN });

        const configs = [
            gen.generateBridgeConfig(link({ mode: 'reverse', tunnelSecurity: 'tls' }), portal),
            gen.generateForwardHopConfig(tls),
        ].map(JSON.parse);
        assert.strictEqual(findDeep(configs, 'allowInsecure').length, 0, 'allowInsecure is never emitted');
        assert.strictEqual(findDeep(configs, 'certificateFile').length, 0, 'no node-local cert files');
    } finally {
        fs.statSync = statSync;
        fs.readFileSync = readFileSync;
        gen.invalidatePanelCertCache();
    }
}

// ---- per-node filter with a target version ----------------------------------
const HyNode = require('../src/models/hyNodeModel');
const CascadeLink = require('../src/models/cascadeLinkModel');
const cascadeService = require('../src/services/cascadeService');

async function runFilterTests() {
    const marked = [];
    let storedQueries = 0;
    HyNode.findById = () => {
        storedQueries++;
        return { select: () => ({ lean: async () => ({ xrayVersion: '25.8.3' }) }) };
    };
    CascadeLink.updateMany = async (filter, update) => {
        marked.push({ ids: filter._id.$in.map(String), lastError: update.$set.lastError });
        return { modifiedCount: filter._id.$in.length };
    };
    cascadeService._invalidateTopologyCache = async () => {};
    const node = { _id: 'n1', name: 'node' };
    const groups = () => ({
        reverseLinks: [link({ _id: 'r1', mode: 'reverse' })],
        forwardLinks: [link({ _id: 'f1', tunnelSecurity: 'reality' }), link({ _id: 'f2' })],
        forwardHopLinks: [link({ _id: 'h1', tunnelSecurity: 'reality' })],
    });

    // Stored 25.8.3: reverse needs 25.9.11 and the chain needs VLESS Encryption.
    const old = await cascadeService.filterLinksForNodeXray(node, groups());
    assert.deepStrictEqual([old.reverseLinks, old.forwardLinks], [[], []]);
    assert.deepStrictEqual(old.forwardHopLinks.map(l => l._id), ['h1']);
    assert.deepStrictEqual(marked.map(m => m.ids.sort()), [['r1'], ['f1', 'f2']]);
    assert.match(marked[0].lastError, /VLESS Reverse Proxy requires Xray >= 25\.9\.11, node runs 25\.8\.3/);
    assert.match(marked[1].lastError, /VLESS Encryption requires Xray >= 25\.9\.5/);

    // A target version is used as is and a dry run writes nothing.
    marked.length = 0;
    storedQueries = 0;
    const target = await cascadeService.filterLinksForNodeXray(node, groups(), { version: '26.10.31', dryRun: true });
    assert.strictEqual(target.reverseLinks.length + target.forwardLinks.length + target.forwardHopLinks.length, 4);
    assert.strictEqual(storedQueries, 0);
    const dry = await cascadeService.filterLinksForNodeXray(node, groups(), { version: '25.9.5', dryRun: true });
    assert.deepStrictEqual(dry.reverseLinks, []);
    assert.strictEqual(dry.forwardLinks.length, 2);
    assert.strictEqual(marked.length, 0);

    // Unknown versions only block mKCP.
    assert.strictEqual(cascadeService.linkVersionError(link({ mode: 'reverse' }), node, ''), null);
    assert.match(cascadeService.linkVersionError(link({ tunnelTransport: 'kcp' }), node, ''), /Cannot detect/);
}

// ---- links deployed by an older panel are redeployed on both ends -----------
async function runOutdatedLinkTests() {
    const { CASCADE_CONFIG_FORMAT } = require('../src/utils/cascadeTransport');
    const originals = {
        find: CascadeLink.find,
        chain: cascadeService._getForwardChainLinks,
        deployLink: cascadeService.deployLink,
    };
    const queries = [];
    const deployed = [];
    try {
        CascadeLink.find = (filter) => {
            queries.push(filter);
            return { populate: async () => [link({ _id: 'old-rev', mode: 'reverse', status: 'online' })] };
        };
        cascadeService._getForwardChainLinks = async () => [
            link({ _id: 'old-hop', status: 'deployed' }),
            link({ _id: 'new-hop', status: 'online', configFormat: CASCADE_CONFIG_FORMAT }),
            link({ _id: 'pending-hop', status: 'pending' }),
            link({ _id: 'old-rev', mode: 'reverse', status: 'online' }),
        ];
        cascadeService.deployLink = async (l) => {
            deployed.push(l._id);
            return l._id === 'old-hop' ? { success: false, error: 'bridge unreachable' } : { success: true };
        };

        const errors = await cascadeService.redeployOutdatedLinks({ _id: 'n1', name: 'portal' });
        assert.deepStrictEqual(deployed, ['old-rev', 'old-hop'], 'each outdated link once, current and pending ones skipped');
        assert.deepStrictEqual(errors, ['l: bridge unreachable']);
        assert.deepStrictEqual(queries[0].configFormat, { $ne: CASCADE_CONFIG_FORMAT });
        assert.deepStrictEqual(queries[0].status, { $in: ['deployed', 'online', 'offline'] });
    } finally {
        CascadeLink.find = originals.find;
        cascadeService._getForwardChainLinks = originals.chain;
        cascadeService.deployLink = originals.deployLink;
    }
}

runFilterTests()
    .then(runOutdatedLinkTests)
    .then(() => {
        console.log('cascade xray compat tests passed');
        process.exit(0);
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
