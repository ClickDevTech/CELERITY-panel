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
    // Xray 26.5.9+ drops reverse traffic that no freedom rule allows; private targets stay blocked.
    const freedom = bridge.outbounds.find(o => o.protocol === 'freedom');
    assert.deepStrictEqual(freedom.settings.finalRules, [{ action: 'block', ip: ['geoip:private'] }, { action: 'allow' }]);
    // Older cores have no freedom rules: the routing block must come before the tunnel rule.
    assert.deepStrictEqual(bridge.routing.rules[0], { type: 'field', ip: ['geoip:private'], outboundTag: 'blackhole' });
    const hopRules = JSON.parse(gen.generateForwardHopConfig(link())).routing.rules;
    assert.deepStrictEqual(hopRules[0], { type: 'field', ip: ['geoip:private'], outboundTag: 'blackhole' });

    const down = link({ _id: '64d000000000000000000003', mode: 'reverse', tunnelSecurity: 'reality', realityPrivateKey: 'k' });
    const relay = JSON.parse(gen.generateRelayConfig(rev, portal, [down]));
    assert.strictEqual(relay.reverse, undefined);
    assert.deepStrictEqual(relay.outbounds[0].settings.reverse, { tag: 'bridge-up' });
    assert.deepStrictEqual(relay.inbounds[0].settings.clients[0].reverse, { tag: 'portal-down-00000003' });
    assert.strictEqual(relay.inbounds[0].settings.decryption, 'none');
    assert.ok(relay.routing.rules.some(r => r.inboundTag?.[0] === 'bridge-up' && r.outboundTag === 'portal-down-00000003'));
}

// ---- several exits on one portal (vlessRoute) -------------------------------
{
    const {
        uuidWithRoute,
        pickFreeRouteId,
        sanitizeLinkPublishInput,
        sanitizePortalSettingsInput,
        sanitizeSubscriptionLabel,
        normalizePortalSettings,
        PORTAL_DEFAULTS,
    } = require('../src/utils/cascadePublish');
    const { MIN_VLESS_ROUTE_XRAY_VERSION } = require('../src/utils/cascadeTransport');
    const { compareVersions } = require('../src/services/xrayVersionService');
    assert.ok(compareVersions(MIN_VLESS_ROUTE_XRAY_VERSION, MIN_CASCADE_XRAY_VERSION) <= 0, 'reverse links already cover vlessRoute');

    const rev = (n, extra = {}) => link({
        _id: `64d00000000000000000000${n}`,
        mode: 'reverse',
        tunnelSecurity: 'reality',
        realityPrivateKey: 'k',
        routeId: n,
        ...extra,
    });
    const freshPortal = () => ({ inbounds: [], outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } });
    const tags = ['vless-in', 'vless-extra-8443'];

    // Portals stored before the settings existed get the defaults.
    const legacy = freshPortal();
    gen.applyReversePortal(legacy, [rev(1), rev(2)], tags);
    const explicitDefaults = freshPortal();
    gen.applyReversePortal(explicitDefaults, [rev(1), rev(2)], tags, { ...PORTAL_DEFAULTS });
    assert.deepStrictEqual(explicitDefaults, legacy);
    // random + fallbackTag needs an observatory, without one Xray refuses to start.
    assert.deepStrictEqual(legacy.routing.balancers, [{
        tag: 'cascade-balancer',
        selector: ['portal-00000001', 'portal-00000002'],
        strategy: { type: 'random' },
    }]);
    const randomBlock = freshPortal();
    gen.applyReversePortal(randomBlock, [rev(1), rev(2)], tags, { fallback: 'block' });
    assert.strictEqual(randomBlock.routing.balancers[0].fallbackTag, undefined);
    assert.deepStrictEqual(legacy.routing.rules, [{ type: 'field', inboundTag: tags, balancerTag: 'cascade-balancer' }]);
    assert.strictEqual(findDeep(legacy, 'vlessRoute').length, 0, 'single mode adds no exit rules');
    assert.strictEqual(legacy.observatory, undefined);
    assert.strictEqual(legacy.burstObservatory, undefined);

    // perExit: explicit exits first, then geo, then the balancer.
    const geo = rev(3, { geoRouting: { enabled: true, domains: ['netflix'], geoip: [] } });
    const hidden = rev(4, { publishInSubscription: false });
    const noRoute = rev(5, { routeId: null });
    const multi = freshPortal();
    gen.applyReversePortal(multi, [rev(1), rev(2), geo, hidden, noRoute], tags, { publishMode: 'both' });
    const ruleKinds = multi.routing.rules.map(r => r.vlessRoute ? `route:${r.vlessRoute}` : r.domain ? 'geo' : r.balancerTag ? 'balancer' : r.outboundTag);
    assert.deepStrictEqual(ruleKinds, ['route:1', 'route:2', 'route:3', 'geo', 'balancer']);
    assert.deepStrictEqual(multi.routing.rules[0], { type: 'field', inboundTag: tags, vlessRoute: '1', outboundTag: 'portal-00000001' });
    assert.strictEqual(multi.routing.rules[2].outboundTag, 'portal-00000003', 'geo exits are selectable too');
    assert.deepStrictEqual(multi.routing.balancers[0].selector,
        ['portal-00000001', 'portal-00000002', 'portal-00000004', 'portal-00000005'],
        'hidden exits and exits without a route still serve the shared entry');
    assert.strictEqual(multi.inbounds.length, 5, 'every exit keeps its bridge connector');

    // includeInBalancer=false removes the exit from the shared entry only.
    const partial = freshPortal();
    gen.applyReversePortal(partial, [rev(1), rev(2, { includeInBalancer: false })], tags, { publishMode: 'perExit' });
    assert.strictEqual(partial.routing.balancers, undefined, 'one remaining exit needs no balancer');
    assert.deepStrictEqual(partial.routing.rules.map(r => r.vlessRoute || r.outboundTag),
        ['1', '2', 'portal-00000001']);

    // Nothing left for the shared entry: the fallback is explicit.
    const none = freshPortal();
    gen.applyReversePortal(none, [rev(1, { includeInBalancer: false })], tags, { publishMode: 'perExit', fallback: 'block' });
    assert.deepStrictEqual(none.routing.rules.at(-1), { type: 'field', inboundTag: tags, outboundTag: 'block' });
    assert.deepStrictEqual(none.outbounds.at(-1), { protocol: 'blackhole', tag: 'block' });

    // block fallback reuses an existing blackhole outbound.
    const blocked = freshPortal();
    blocked.outbounds.push({ tag: 'deny', protocol: 'blackhole' });
    gen.applyReversePortal(blocked, [rev(1), rev(2)], tags, { fallback: 'block', balancerStrategy: 'leastPing' });
    assert.strictEqual(blocked.routing.balancers[0].fallbackTag, 'deny');
    assert.strictEqual(blocked.outbounds.filter(o => o.protocol === 'blackhole').length, 1);

    // leastPing -> observatory, leastLoad -> burstObservatory, merged with existing selectors.
    const ping = freshPortal();
    ping.observatory = { subjectSelector: ['proxy-'], probeUrl: 'https://old.example/', probeInterval: '5m' };
    gen.applyReversePortal(ping, [rev(1), rev(2)], tags, { balancerStrategy: 'leastPing', probeInterval: '30s' });
    assert.deepStrictEqual(ping.routing.balancers[0].strategy, { type: 'leastPing' });
    assert.strictEqual(ping.routing.balancers[0].fallbackTag, 'direct');
    assert.deepStrictEqual(ping.observatory, {
        subjectSelector: ['proxy-', 'portal-00000001', 'portal-00000002'],
        probeUrl: PORTAL_DEFAULTS.probeUrl,
        probeInterval: '30s',
        enableConcurrency: true,
    });
    const load = freshPortal();
    gen.applyReversePortal(load, [rev(1), rev(2)], tags, { balancerStrategy: 'leastLoad' });
    assert.deepStrictEqual(load.routing.balancers[0].strategy, { type: 'leastLoad' });
    assert.deepStrictEqual(load.burstObservatory.subjectSelector, ['portal-00000001', 'portal-00000002']);
    assert.deepStrictEqual(load.burstObservatory.pingConfig,
        { destination: PORTAL_DEFAULTS.probeUrl, interval: '1m', sampling: 3, timeout: '5s' });
    assert.strictEqual(load.observatory, undefined);

    // Corrupted stored settings never reach the config.
    assert.deepStrictEqual(normalizePortalSettings({ publishMode: 'x', balancerStrategy: 'roundRobin', fallback: 'leak', probeUrl: 'javascript:alert(1)', probeInterval: '1d' }),
        { ...PORTAL_DEFAULTS });

    // UUID route bytes.
    assert.strictEqual(uuidWithRoute(UUID, 3), '5783a3e7-e373-0003-8642-c83782b807c5');
    assert.strictEqual(uuidWithRoute(UUID.toUpperCase(), 4095), '5783a3e7-e373-0fff-8642-c83782b807c5');
    assert.strictEqual(uuidWithRoute(UUID, 0), '5783a3e7-e373-0000-8642-c83782b807c5');
    assert.strictEqual(uuidWithRoute('not-a-uuid', 1), null);
    assert.strictEqual(uuidWithRoute(UUID, 70000), null);
    assert.strictEqual(pickFreeRouteId([1, 2, 4]), 3);
    assert.strictEqual(pickFreeRouteId([]), 1);
    assert.strictEqual(pickFreeRouteId(Array.from({ length: 4095 }, (_, i) => i + 1)), null);

    // Untrusted input.
    assert.deepStrictEqual(sanitizeLinkPublishInput({ publishInSubscription: 'false', includeInBalancer: true, routeId: 7, subscriptionLabel: ' DE\u0000\n exit ' }).fields,
        { publishInSubscription: false, includeInBalancer: true, subscriptionLabel: 'DE exit' }, 'routeId is never accepted');
    assert.match(sanitizeLinkPublishInput({ includeInBalancer: 'maybe' }).error, /boolean/);
    assert.match(sanitizeLinkPublishInput({ subscriptionLabel: { $gt: '' } }).error, /string/);
    assert.strictEqual(sanitizeSubscriptionLabel('x'.repeat(100)).length, 64);
    assert.strictEqual(sanitizeSubscriptionLabel('x'.repeat(63) + '🇩🇪'), 'x'.repeat(63), 'an emoji is never cut in half');
    assert.strictEqual(sanitizeSubscriptionLabel('DE \uD83C exit'), 'DE exit', 'lone surrogates are dropped');
    assert.deepStrictEqual(sanitizePortalSettingsInput({ publishMode: 'both', probeInterval: ' 30s ', other: 1 }),
        { fields: { publishMode: 'both', probeInterval: '30s' }, error: null });
    assert.match(sanitizePortalSettingsInput({ balancerStrategy: 'roundRobin' }).error, /balancerStrategy/);
    assert.match(sanitizePortalSettingsInput({ probeUrl: 'file:///etc/passwd' }).error, /probeUrl/);
    assert.match(sanitizePortalSettingsInput({ probeInterval: '1d' }).error, /probeInterval/);
    assert.match(sanitizePortalSettingsInput([]).error, /object/);
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

// ---- portal publication: cache scope and pending redeploys ------------------
async function runPortalPublicationTests() {
    const originals = {
        findById: HyNode.findById,
        updateOne: HyNode.updateOne,
        countDocuments: CascadeLink.countDocuments,
        invalidate: cascadeService.invalidatePublication,
        ensure: cascadeService.ensureRouteIds,
        push: cascadeService._pushPortalConfig,
    };
    const flags = [];
    let invalidations = 0;
    let pushes = 0;
    let pushError = null;
    let stored = { _id: 'p1', name: 'portal', type: 'xray', cascadePortal: { publishMode: 'single', redeployPending: true } };
    try {
        HyNode.findById = async () => stored;
        HyNode.updateOne = async (filter, update) => {
            flags.push(update.$set['cascadePortal.redeployPending']);
            return {};
        };
        CascadeLink.countDocuments = async () => 1;
        cascadeService.invalidatePublication = async () => { invalidations++; };
        cascadeService.ensureRouteIds = async () => {};
        cascadeService._pushPortalConfig = async () => {
            pushes++;
            if (pushError) throw pushError;
        };

        // Health-check flips only drop subscriptions of portals that publish exits.
        const rev = link({ _id: 'x1', mode: 'reverse' });
        const batch = { exitsChanged: false };
        await cascadeService._onExitStatusChange(rev, { cascadePortal: { publishMode: 'single' } }, 'online', 'offline', batch);
        assert.strictEqual(batch.exitsChanged, false, 'single portals keep subscriptions cached');
        await cascadeService._onExitStatusChange(rev, { cascadePortal: { publishMode: 'perExit' } }, 'online', 'offline', batch);
        assert.strictEqual(batch.exitsChanged, true);
        await cascadeService._onExitStatusChange(rev, { cascadePortal: { publishMode: 'both' } }, 'offline', 'error', null);
        assert.strictEqual(invalidations, 0, 'an exit that stays hidden changes nothing');

        // A pending push is applied by a save that changes nothing.
        const applied = await cascadeService.updatePortalSettings('p1', {});
        assert.deepStrictEqual([applied.redeployed, applied.redeployPending, pushes], [true, false, 1]);
        assert.deepStrictEqual(flags, [false], 'the flag is cleared before the links are read');

        // A failed push leaves the portal marked for the next save.
        flags.length = 0;
        pushError = new Error('ssh timeout');
        const failed = await cascadeService.updatePortalSettings('p1', {}, { forceRedeploy: true });
        assert.deepStrictEqual([failed.redeployed, failed.redeployPending, failed.error], [false, true, 'ssh timeout']);
        assert.deepStrictEqual(flags, [false, true]);

        // Nothing pending and nothing changed: the portal is left alone.
        stored = { ...stored, cascadePortal: { publishMode: 'single' } };
        pushes = 0;
        const idle = await cascadeService.updatePortalSettings('p1', {});
        assert.deepStrictEqual([idle.redeployed, idle.redeployPending, pushes], [false, false, 0]);
    } finally {
        HyNode.findById = originals.findById;
        HyNode.updateOne = originals.updateOne;
        CascadeLink.countDocuments = originals.countDocuments;
        cascadeService.invalidatePublication = originals.invalidate;
        cascadeService.ensureRouteIds = originals.ensure;
        cascadeService._pushPortalConfig = originals.push;
    }
}

runFilterTests()
    .then(runOutdatedLinkTests)
    .then(runPortalPublicationTests)
    .then(() => {
        console.log('cascade xray compat tests passed');
        process.exit(0);
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
