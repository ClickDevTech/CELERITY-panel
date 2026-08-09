/**
 * Probe manifest contract (no MongoDB).
 *
 * The manifest is what lets a probe map subscription outbounds back to panel
 * entities. Verifies:
 *   - every inbound carries the sing-box tag the subscription will publish,
 *     computed through the very same subscription helpers (not a copy),
 *   - Xray extra inbounds keep their stable id while the primary one is 'main',
 *   - virtual nodes are exposed as a group plus the list of their leaves,
 *   - disabled checklist resources are not handed to probes,
 *   - the subscription URL asks for the sing-box format.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

const NODES = [
    {
        _id: 'node-xray',
        name: 'Frankfurt',
        flag: '🇩🇪',
        type: 'xray',
        ip: '10.0.0.1',
        domain: 'de.example.com',
        port: 443,
        xray: { inboundTag: 'vless-in' },
    },
    {
        _id: 'node-hy',
        name: 'Amsterdam',
        flag: '🇳🇱',
        type: 'hysteria',
        ip: '10.0.0.2',
        port: 8443,
    },
    {
        _id: 'node-virtual',
        name: 'Auto EU',
        flag: '🇪🇺',
        type: 'virtual',
        virtual: { selectMode: 'manual', sources: ['node-xray', 'node-hy'] },
    },
];

const SETTINGS = {
    probes: {
        enabled: true,
        transportIntervalSec: 300,
        targetsIntervalSec: 3600,
        reportIntervalSec: 900,
        speedTest: { enabled: true, maxBytes: 1024, maxSeconds: 5, dailyBudgetBytes: 4096 },
        targets: [
            { id: 'google', url: 'https://www.google.com/generate_204', enabled: true },
            { id: 'disabled-one', url: 'https://example.com', enabled: false },
        ],
        retentionDays: 30,
    },
};

async function withStubs(run) {
    const originalLoad = Module._load;

    const HyNode = {
        find() {
            return {
                select() {
                    return { lean: async () => NODES };
                },
            };
        },
    };

    // Minimal stand-ins for the subscription helpers. The point of the test is
    // that the manifest goes through them at all: the tag it publishes must be
    // produced by the same code path as the subscription itself.
    const subscription = {
        getNodeConfigs(node) {
            return node.type === 'hysteria'
                ? [{ name: 'Main', host: node.ip, port: node.port }]
                : [];
        },
        getXrayPublishedInbounds(node) {
            return node.type === 'xray'
                ? [
                    { port: 443, nameSuffix: '', extraId: null, inboundTag: 'vless-in', transport: 'tcp', security: 'reality' },
                    { port: 8443, nameSuffix: 'ws:8443', extraId: 'extra-uuid', inboundTag: 'vless-ws', transport: 'ws', security: 'tls' },
                ]
                : [];
        },
        xrayInboundName(node, inbound) {
            const base = `${node.flag || ''} ${node.name}`.trim();
            return inbound.nameSuffix ? `${base} (${inbound.nameSuffix})` : base;
        },
    };

    Module._load = function patchedLoad(request, parent, isMain) {
        const parentFile = normalizePath(parent?.filename);
        if (parentFile.endsWith('/src/services/probes/manifestService.js')) {
            if (request === '../../models/hyNodeModel') return HyNode;
            if (request === '../../models/serverGroupModel') return {};
            if (request === '../../routes/subscription') return subscription;
            if (request === '../../../config') {
                return { BASE_URL: 'https://panel.example.com', PANEL_DOMAIN: 'panel.example.com' };
            }
            if (request === '../../utils/helpers') {
                return { getSettings: async () => SETTINGS };
            }
        }
        return originalLoad(request, parent, isMain);
    };

    try {
        delete require.cache[require.resolve('../src/services/probes/manifestService')];
        const manifestService = require('../src/services/probes/manifestService');
        return await run(manifestService);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/services/probes/manifestService')];
    }
}

(async () => {
    await withStubs(async (manifestService) => {
        const manifest = await manifestService.buildManifest(
            { _id: 'probe-1', name: 'Moscow' },
            'sub-token-123'
        );

        assert.strictEqual(
            manifest.subscriptionUrl,
            'https://panel.example.com/api/files/sub-token-123?format=singbox',
            'probe pulls the real subscription in sing-box format'
        );
        assert.strictEqual(manifest.ingestUrl, 'https://panel.example.com/api/probe/ingest');

        const xray = manifest.nodes.find((n) => n.nodeId === 'node-xray');
        assert.ok(xray, 'xray node present');
        assert.strictEqual(xray.inbounds.length, 2, 'both published inbounds are checkable');

        const [main, extra] = xray.inbounds;
        assert.strictEqual(main.inboundId, 'main', 'primary inbound uses the stable "main" id');
        assert.strictEqual(main.expectedTag, '🇩🇪 Frankfurt', 'tag matches the subscription name');
        assert.strictEqual(extra.inboundId, 'extra-uuid', 'extra inbound keeps its own id');
        assert.strictEqual(extra.expectedTag, '🇩🇪 Frankfurt (ws:8443)', 'extra inbound tag matches');
        assert.strictEqual(extra.inboundTag, 'vless-ws', 'xray inbound tag carried for diagnostics');

        const hysteria = manifest.nodes.find((n) => n.nodeId === 'node-hy');
        assert.strictEqual(hysteria.inbounds[0].inboundId, 'hysteria');
        assert.strictEqual(hysteria.inbounds[0].expectedTag, '🇳🇱 Amsterdam Main');

        const virtual = manifest.nodes.find((n) => n.nodeId === 'node-virtual');
        assert.ok(virtual.isGroup, 'virtual node is exposed as a group');
        assert.strictEqual(virtual.inbounds[0].inboundId, 'group');
        assert.deepStrictEqual(
            virtual.leafNodeIds.sort(),
            ['node-hy', 'node-xray'],
            'group carries its leaves so a balancer choice can be attributed'
        );

        assert.strictEqual(manifest.targets.length, 1, 'disabled resources are not shipped');
        assert.strictEqual(manifest.targets[0].id, 'google');

        assert.strictEqual(manifest.intervals.transportSec, 300);
        assert.strictEqual(manifest.speedTest.dailyBudgetBytes, 4096);
    });

    // The manifest is only trustworthy while the subscription actually exports
    // the helpers it predicts tags with.
    const subscriptionSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'routes', 'subscription.js'),
        'utf8'
    );
    for (const helper of ['getNodeConfigs', 'getXrayPublishedInbounds', 'xrayInboundName']) {
        assert.ok(
            subscriptionSource.includes(`module.exports.${helper} =`),
            `subscription must export ${helper} for the probe manifest`
        );
    }

    console.log('test-probe-manifest: OK');
})().catch((e) => {
    console.error('test-probe-manifest FAILED:', e);
    process.exit(1);
});
