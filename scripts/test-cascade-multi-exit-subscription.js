'use strict';

// Reverse-cascade portal with several exits: per-exit subscription entries
// reuse the portal inbounds and pick the exit through the UUID route bytes
// (vlessRoute). Covers modes, names, hidden exits, CDN fronts and all formats.

const assert = require('assert');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const cache = require('../src/services/cacheService');
const CascadeLink = require('../src/models/cascadeLinkModel');
const sub = require('../src/routes/subscription');

const PORTAL_ID = '64e000000000000000000001';
const USER_UUID = '5783a3e7-e373-51cd-8642-c83782b807c5';
const user = { userId: 'alice', password: 'secret', xrayUuid: USER_UUID };
const routed = route => `5783a3e7-e373-${route.toString(16).padStart(4, '0')}-8642-c83782b807c5`;

const linkDocs = [
    { _id: 'link-de', portalNode: PORTAL_ID, routeId: 1, status: 'online', subscriptionLabel: '', bridgeNode: { name: 'Frankfurt', flag: '🇩🇪', active: true } },
    { _id: 'link-fi', portalNode: PORTAL_ID, routeId: 2, status: 'deployed', subscriptionLabel: 'Finland fast', bridgeNode: { name: 'Helsinki', flag: '🇫🇮', active: true } },
    { _id: 'link-nl', portalNode: PORTAL_ID, routeId: 3, status: 'offline', subscriptionLabel: '', bridgeNode: { name: 'Amsterdam', flag: '🇳🇱', active: true } },
    { _id: 'link-pl', portalNode: PORTAL_ID, routeId: 4, status: 'online', subscriptionLabel: '', bridgeNode: { name: 'Warsaw', flag: '🇵🇱', active: false } },
    { _id: 'link-gone', portalNode: PORTAL_ID, routeId: 5, status: 'online', subscriptionLabel: '', bridgeNode: null },
];

const queries = [];
let cachedExits = null;
CascadeLink.find = (filter) => {
    queries.push(filter);
    const chain = {
        select: () => chain,
        populate: () => chain,
        sort: () => chain,
        lean: async () => linkDocs,
    };
    return chain;
};
cache.getCascadeExits = async () => cachedExits;
cache.setCascadeExits = async (value) => { cachedExits = JSON.parse(JSON.stringify(value)); };

function portalNode(publishMode, extra = {}) {
    return {
        _id: PORTAL_ID,
        type: 'xray',
        name: 'Moscow',
        flag: '🇷🇺',
        ip: '203.0.113.5',
        domain: 'msk.example.com',
        port: 443,
        active: true,
        status: 'online',
        cascadePortal: publishMode ? { publishMode } : undefined,
        xray: {
            transport: 'tcp',
            security: 'reality',
            flow: 'xtls-rprx-vision',
            realityPublicKey: 'pubkey',
            realitySni: 'www.example.com',
            realityShortIds: ['abcd'],
            extraInbounds: [{ id: 'x1', port: 8443, transport: 'ws', security: 'tls', wsPath: '/ws', label: 'WS' }],
        },
        ...extra,
    };
}

async function attach(nodes, includeDown = false) {
    await sub.attachCascadeExits(nodes, includeDown);
    return nodes;
}

(async () => {
    // ---- single (default): nothing changes and no query is made --------------
    {
        const node = portalNode(null);
        await attach([node]);
        assert.strictEqual(node._cascadeExits, undefined);
        assert.strictEqual(queries.length, 0, 'portals that do not publish exits cost no query');
        const inbounds = sub.getXrayPublishedInbounds(node);
        assert.deepStrictEqual(inbounds.map(i => i.vlessRoute), [undefined, undefined]);
        assert.strictEqual(sub.uuidForInbound(user, inbounds[0]), USER_UUID, 'legacy UUID is untouched');
        const uri = sub.vlessURIForInbound(user, node, inbounds[0]);
        assert.ok(uri.startsWith(`vless://${USER_UUID}@`), uri);
    }

    // ---- both: balanced entries (route 0) plus working exits ----------------
    const both = portalNode('both');
    await attach([both]);
    assert.strictEqual(queries.length, 1);
    assert.deepStrictEqual(queries[0], {
        mode: { $ne: 'forward' },
        active: true,
        publishInSubscription: { $ne: false },
        routeId: { $type: 'number' },
    });
    assert.deepStrictEqual(both._cascadeExits.map(e => e.linkId), ['link-de', 'link-fi'],
        'offline exits, inactive bridges and deleted bridges are hidden');

    const bothInbounds = sub.getXrayPublishedInbounds(both);
    assert.deepStrictEqual(bothInbounds.map(i => `${i.vlessRoute}:${i.port}`),
        ['0:443', '0:8443', '1:443', '1:8443', '2:443', '2:8443'], 'balanced first, then exit-major');
    assert.deepStrictEqual(bothInbounds.map(i => sub.uuidForInbound(user, i)),
        [routed(0), routed(0), routed(1), routed(1), routed(2), routed(2)]);
    assert.deepStrictEqual(bothInbounds.map(i => sub.xrayInboundName(both, i)), [
        '🇷🇺 Moscow',
        '🇷🇺 Moscow (WS)',
        '🇩🇪 Moscow → Frankfurt',
        '🇩🇪 Moscow → Frankfurt (WS)',
        'Finland fast',
        'Finland fast (WS)',
    ]);
    assert.ok(bothInbounds.every(i => i.address === 'msk.example.com'), 'every entry points at the portal');

    // A second subscription request is served from the cache.
    await attach([portalNode('both')]);
    assert.strictEqual(queries.length, 1, 'exits are cached');

    // ---- perExit: only exits ------------------------------------------------
    const perExit = portalNode('perExit');
    await attach([perExit]);
    const perExitInbounds = sub.getXrayPublishedInbounds(perExit);
    assert.deepStrictEqual(perExitInbounds.map(i => i.vlessRoute), [1, 1, 2, 2]);

    // With every exit down, perExit falls back to the balanced entry rather
    // than dropping the node from the subscription.
    const lonely = portalNode('perExit');
    lonely._cascadeExits = [];
    assert.deepStrictEqual(sub.getXrayPublishedInbounds(lonely).map(i => i.vlessRoute), [undefined, undefined]);

    // ---- probes see every exit ----------------------------------------------
    const probeView = portalNode('perExit');
    await attach([probeView], true);
    assert.deepStrictEqual(probeView._cascadeExits.map(e => e.routeId), [1, 2, 3, 4]);

    // ---- every format carries the routed UUID -------------------------------
    {
        const exitInbound = perExitInbounds[0];
        const uri = sub.vlessURIForInbound(user, perExit, exitInbound);
        assert.ok(uri.startsWith(`vless://${routed(1)}@msk.example.com:443?`), uri);
        assert.ok(uri.endsWith('#' + encodeURIComponent('🇩🇪 Moscow → Frankfurt')), uri);

        const clash = sub.clashVlessProxyForInbound(user, perExit, exitInbound);
        assert.strictEqual(clash.name, '🇩🇪 Moscow → Frankfurt');
        assert.ok(clash.proxy.includes(`uuid: "${routed(1)}"`), clash.proxy);

        const singbox = sub.singboxVlessOutboundForInbound(user, perExit, exitInbound);
        assert.strictEqual(singbox.tag, '🇩🇪 Moscow → Frankfurt');
        assert.strictEqual(singbox.outbound.uuid, routed(1));

        const v2ray = sub.v2rayOutboundsForNode(user, perExit);
        const v2rayIds = v2ray.map(({ outbound }) => outbound.settings.vnext[0].users[0].id);
        assert.deepStrictEqual(v2rayIds, [routed(1), routed(1), routed(2), routed(2)]);
        assert.strictEqual(new Set(v2ray.map(o => o.displayName)).size, 4, 'labels stay unique');

        const profiles = sub.xrayJSON(user, [perExit], null);
        const profileIds = profiles.map(p => p.outbounds.find(o => o.tag === 'proxy').settings.vnext[0].users[0].id);
        assert.deepStrictEqual(profileIds, [routed(1), routed(1), routed(2), routed(2)]);

        const singboxJson = sub.singboxJSON(user, [perExit], null);
        const singboxCfg = typeof singboxJson === 'string' ? JSON.parse(singboxJson) : singboxJson;
        const vlessOut = singboxCfg.outbounds.filter(o => o.type === 'vless');
        assert.deepStrictEqual(vlessOut.map(o => o.uuid), [routed(1), routed(1), routed(2), routed(2)]);

        const yaml = sub.clashYAML(user, [perExit], null);
        assert.strictEqual(yaml.split(routed(1)).length - 1, 2, 'Clash YAML has both Frankfurt entries');
        assert.strictEqual(yaml.split(routed(2)).length - 1, 2, 'Clash YAML has both Finland entries');
        assert.ok(!yaml.includes(USER_UUID), 'raw UUID would bypass the exit selection');
    }

    // ---- a CDN in front of the portal expands per exit too ------------------
    {
        const origin = portalNode('both');
        const cdn = {
            _id: '64e000000000000000000002',
            type: 'cdn',
            name: 'Front',
            flag: '🌐',
            _resolvedOrigin: origin,
            cdn: { originNode: PORTAL_ID, originInboundId: 'x1', domain: 'cdn.example.com', port: 443, security: 'tls', edges: [] },
        };
        await attach([cdn]);
        const cdnInbounds = sub.getXrayPublishedInbounds(cdn);
        assert.deepStrictEqual(cdnInbounds.map(i => i.vlessRoute), [0, 1, 2]);
        assert.ok(cdnInbounds.every(i => i.address === 'cdn.example.com'));
        assert.deepStrictEqual(cdnInbounds.map(i => sub.xrayInboundName(cdn, i)),
            ['🌐 Front', '🇩🇪 Front → Frankfurt', 'Finland fast']);
        const uri = sub.vlessURIForInbound(user, cdn, cdnInbounds[1]);
        assert.ok(uri.startsWith(`vless://${routed(1)}@cdn.example.com:443?`), uri);
    }

    // ---- malformed UUIDs never fall back to the default route ---------------
    assert.strictEqual(sub.uuidForInbound({ xrayUuid: 'not-a-uuid' }, perExitInbounds[0]), null);
    assert.strictEqual(sub.uuidForInbound({}, perExitInbounds[0]), null);

    console.log('cascade multi-exit subscription tests passed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
