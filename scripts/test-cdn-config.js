const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    mergeCdnConfig,
    normalizeCdnConfig,
    validateCdnOrigin,
    checkCdnDependents,
    collectCdnDependentUsers,
    cdnOriginSyncNeeded,
    cdnOriginIdsForSync,
    CDN_ORIGIN_CANDIDATE_SELECT,
} = require('../src/utils/cdnConfig');
const {
    normalizeFingerprintPool,
    pickFingerprint,
} = require('../src/utils/fingerprints');

const originId = '64b000000000000000000001';

{
    const result = normalizeCdnConfig({
        originNode: originId,
        domain: 'cdn.example.com',
        security: 'tls',
    });
    assert.ifError(result.error);
    assert.strictEqual(result.value.sni, 'cdn.example.com');
    assert.strictEqual(result.value.host, 'cdn.example.com');
    assert.deepStrictEqual(result.value.edges, []);
}

{
    const result = normalizeCdnConfig({
        originNode: originId,
        domain: 'cdn.example.com',
        fingerprint: 'firefox',
        fingerprintPool: ['safari', 'invalid', 'chrome', 'safari'],
    });
    assert.ifError(result.error);
    assert.strictEqual(result.value.fingerprint, 'firefox');
    assert.deepStrictEqual(result.value.fingerprintPool, ['safari', 'chrome']);
    assert.deepStrictEqual(normalizeFingerprintPool('edge, chrome, edge'), ['edge', 'chrome']);
    assert.strictEqual(pickFingerprint('firefox', ['safari', 'chrome'], () => 0.99), 'chrome');
}

{
    const result = normalizeCdnConfig({
        originNode: originId,
        domain: 'cdn.example.com',
        alpn: 'h3, h2',
    });
    assert.ifError(result.error);
    assert.deepStrictEqual(result.value.alpn, ['h3', 'h2']);
}

{
    const result = normalizeCdnConfig({
        originNode: originId,
        domain: 'cdn.example.com',
        alpn: 'h4, h2',
    });
    assert.match(result.error, /CDN ALPN must contain only/);
}

{
    const result = normalizeCdnConfig({
        originNode: originId,
        edges: [{ id: 'edge-1', address: '203.0.113.10' }],
        sni: 'cdn.example.com',
    });
    assert.ifError(result.error);
    assert.strictEqual(result.value.domain, '');
    assert.strictEqual(result.value.security, 'tls');
    assert.strictEqual(result.value.allowInsecure, false);
    assert.strictEqual(result.value.edges[0].address, '203.0.113.10');
}

{
    const result = normalizeCdnConfig({
        originNode: originId,
        domain: 'cdn.example.com',
        security: 'none',
    });
    assert.match(result.error, /must be TLS/);
}

{
    const result = normalizeCdnConfig({
        originNode: originId,
        domain: 'cdn.example.com',
        allowInsecure: true,
    });
    assert.match(result.error, /cannot skip certificate verification/);
}

{
    const result = normalizeCdnConfig({
        originNode: originId,
        edges: [{ id: 'edge-1', address: '2001:db8::10' }],
        security: 'tls',
    });
    assert.match(result.error, /SNI is required/);
}

{
    const result = normalizeCdnConfig({ originNode: originId });
    assert.match(result.error, /domain or at least one enabled edge/i);
}

// A config whose only edge is switched off publishes nothing at all, so it is
// refused at save time rather than disappearing from subscriptions later.
{
    const result = normalizeCdnConfig({
        originNode: originId,
        edges: [{ id: 'edge-1', address: '203.0.113.10', enabled: false }],
    });
    assert.match(result.error, /domain or at least one enabled edge/i);
}

{
    const result = normalizeCdnConfig({
        originNode: originId,
        domain: 'cdn.example.com',
        path: '/api/"injected',
    });
    assert.match(result.error, /unsupported characters/);
}

for (const port of [0, '0', '443junk', 65536, '1.5']) {
    const result = normalizeCdnConfig({
        originNode: originId,
        domain: 'cdn.example.com',
        port,
    });
    assert.match(result.error, /port/i, `expected CDN port ${JSON.stringify(port)} to be rejected`);
}
assert.strictEqual(normalizeCdnConfig({
    originNode: originId,
    domain: 'cdn.example.com',
    port: '8443',
}).value.port, 8443);

assert.deepStrictEqual(
    mergeCdnConfig(
        { originNode: originId, domain: 'cdn.example.com', port: 443 },
        { port: 8443 }
    ),
    { originNode: originId, domain: 'cdn.example.com', port: 8443 }
);

async function originModel(origin) {
    return {
        findById() {
            return {
                select() {
                    return { lean: async () => origin };
                },
            };
        },
    };
}

(async () => {
    const xhttpOrigin = {
        type: 'xray',
        xray: {
            transport: 'xhttp',
            security: 'none',
            xhttpPath: '/api',
            extraInbounds: [],
        },
    };
    // With the default (path) placements the server reads the segment after its
    // own prefix as the session ID, so only an identical path works — a longer
    // one turns "events.php" into the session ID of every client at once.
    for (const path of ['/api', '/api/']) {
        const sameAsOrigin = await validateCdnOrigin(
            { originNode: originId, path },
            await originModel(xhttpOrigin)
        );
        assert.ifError(sameAsOrigin.error);
    }

    const extendedPath = await validateCdnOrigin(
        { originNode: originId, path: '/api/events.php' },
        await originModel(xhttpOrigin)
    );
    assert.match(extendedPath.error, /must equal the origin path/);

    const wrongPath = await validateCdnOrigin(
        { originNode: originId, path: '/other' },
        await originModel(xhttpOrigin)
    );
    assert.ok(wrongPath.error);

    // Once the markers move off the path, the path is a plain prefix again and
    // the front may publish something that looks like an ordinary web resource.
    const headerOrigin = {
        type: 'xray',
        xray: {
            ...xhttpOrigin.xray,
            xhttpSessionPlacement: 'header',
            xhttpSeqPlacement: 'header',
        },
    };
    const extendedWithHeaders = await validateCdnOrigin(
        { originNode: originId, path: '/api/events.php' },
        await originModel(headerOrigin)
    );
    assert.ifError(extendedWithHeaders.error);
    const outsidePrefix = await validateCdnOrigin(
        { originNode: originId, path: '/other/events.php' },
        await originModel(headerOrigin)
    );
    assert.match(outsidePrefix.error, /must start with the origin path/);

    // A WebSocket inbound matches its path exactly, so the two must be equal.
    const wsOrigin = {
        type: 'xray',
        xray: { transport: 'ws', security: 'tls', wsPath: '/ws', extraInbounds: [] },
    };
    const wsMismatch = await validateCdnOrigin(
        { originNode: originId, path: '/ws/extra' },
        await originModel(wsOrigin)
    );
    assert.match(wsMismatch.error, /equal the origin WebSocket path/);
    const wsMatch = await validateCdnOrigin(
        { originNode: originId, path: '/ws' },
        await originModel(wsOrigin)
    );
    assert.ifError(wsMatch.error);

    // No client path means the front republishes the origin path, which is
    // exactly what the default placements require.
    const missingPath = await validateCdnOrigin(
        { originNode: originId },
        await originModel(xhttpOrigin)
    );
    assert.ifError(missingPath.error);

    const reality = await validateCdnOrigin(
        { originNode: originId },
        await originModel({ type: 'xray', xray: { transport: 'grpc', security: 'reality' } })
    );
    assert.match(reality.error, /Reality cannot/);

    // A disabled origin is dropped from every subscription, taking its fronts
    // with it, so it cannot be picked in the first place.
    const disabledOrigin = await validateCdnOrigin(
        { originNode: originId, path: '/api/events.php' },
        await originModel({ ...xhttpOrigin, name: 'Origin', active: false })
    );
    assert.match(disabledOrigin.error, /disabled/);

    // Converting an Xray node into a CDN must not let it front itself.
    const selfReference = await validateCdnOrigin(
        { originNode: originId, path: '/api/events.php' },
        await originModel(xhttpOrigin),
        { selfId: originId }
    );
    assert.match(selfReference.error, /cannot be the CDN node itself/);

    // ---- Editing an origin that CDN fronts point at ----
    const dependentsModel = {
        find() {
            return {
                select() {
                    return {
                        lean: async () => [{
                            name: 'Front',
                            cdn: { originNode: originId, path: '/api' },
                        }],
                    };
                },
            };
        },
    };
    const brokenByTypeChange = await checkCdnDependents(
        originId,
        { type: 'hysteria', xray: {} },
        dependentsModel
    );
    assert.match(brokenByTypeChange, /CDN node "Front" depends on this node/);

    const brokenByTransportChange = await checkCdnDependents(
        originId,
        { type: 'xray', xray: { transport: 'tcp', security: 'reality' } },
        dependentsModel
    );
    assert.match(brokenByTransportChange, /XHTTP, WebSocket, or gRPC/);

    const brokenByDisabling = await checkCdnDependents(
        originId,
        { ...xhttpOrigin, name: 'Origin', active: false },
        dependentsModel
    );
    assert.match(brokenByDisabling, /disabled/);

    const stillFine = await checkCdnDependents(originId, xhttpOrigin, dependentsModel);
    assert.strictEqual(stillFine, null);

    const getHeaderOrigin = {
        type: 'xray',
        xray: {
            transport: 'xhttp',
            security: 'none',
            xhttpPath: '/cdn/',
            xhttpMode: 'packet-up',
            xhttpUplinkHTTPMethod: 'GET',
            xhttpUplinkDataPlacement: 'header',
            xhttpUplinkDataKey: 'X-Data',
            xhttpSessionPlacement: 'query',
            xhttpSeqPlacement: 'query',
        },
    };
    const brokenMode = await validateCdnOrigin(
        { originNode: originId, path: '/cdn/events.php', xhttpMode: 'stream-up' },
        await originModel(getHeaderOrigin)
    );
    assert.match(brokenMode.error, /packet-up mode/);
    const matchingMode = await validateCdnOrigin(
        { originNode: originId, path: '/cdn/events.php', xhttpMode: 'packet-up' },
        await originModel(getHeaderOrigin)
    );
    assert.ifError(matchingMode.error);

    const front = {
        type: 'cdn',
        active: true,
        groups: ['g1'],
        cdn: { originNode: originId },
    };
    assert.strictEqual(cdnOriginSyncNeeded(null, front), true);
    assert.strictEqual(cdnOriginSyncNeeded(front, null), true);
    assert.strictEqual(cdnOriginSyncNeeded(front, { ...front, cdn: { originNode: originId, domain: 'cdn.example.com' } }), false);
    assert.strictEqual(cdnOriginSyncNeeded(front, { ...front, groups: ['g2'] }), true);
    assert.strictEqual(cdnOriginSyncNeeded(front, { ...front, active: false }), true);
    assert.deepStrictEqual(cdnOriginIdsForSync(front, { type: 'cdn', cdn: { originNode: originId } }), [originId]);

    // A hidden origin (no groups) must still receive users who only see the CDN.
    const cdnGroup = '64b0000000000000000000aa';
    const cdnNodeId = '64b0000000000000000000bb';
    const groupUser = { userId: 'cdn-group-user', groups: [cdnGroup], nodes: [] };
    const assignedUser = { userId: 'cdn-assigned-user', groups: [], nodes: [cdnNodeId] };
    const otherUser = { userId: 'other-user', groups: ['other'], nodes: [] };
    const frontsModel = {
        find() {
            return {
                select() {
                    return {
                        lean: async () => [{ _id: cdnNodeId, groups: [cdnGroup] }],
                    };
                },
            };
        },
    };
    const usersModel = {
        find(query) {
            return {
                lean: async () => {
                    if (query.nodes && query.nodes.$in) {
                        return [assignedUser];
                    }
                    if (query.groups && query.groups.$in) {
                        const wanted = query.groups.$in.map(String);
                        return [groupUser, otherUser].filter(user =>
                            user.groups.some(group => wanted.includes(String(group)))
                        );
                    }
                    return [];
                },
            };
        },
    };
    const projected = await collectCdnDependentUsers(originId, frontsModel, usersModel);
    assert.deepStrictEqual(projected.map(user => user.userId).sort(), [
        'cdn-assigned-user',
        'cdn-group-user',
    ]);

    const noFrontsModel = {
        find() {
            return { select() { return { lean: async () => [] }; } };
        },
    };
    assert.deepStrictEqual(await collectCdnDependentUsers(originId, noFrontsModel, usersModel), []);

    for (const field of [
        'xray.xhttpPath',
        'xray.wsPath',
        'xray.xhttpSessionPlacement',
        'xray.xhttpSeqPlacement',
        'xray.xhttpUplinkHTTPMethod',
        'xray.extraInbounds.xhttpPath',
        'xray.extraInbounds.wsPath',
        'xray.extraInbounds.xhttpSessionPlacement',
        'xray.extraInbounds.xhttpSeqPlacement',
        'xray.extraInbounds.xhttpUplinkHTTPMethod',
    ]) {
        assert.match(CDN_ORIGIN_CANDIDATE_SELECT, new RegExp(field.replace('.', '\\.')));
    }
    const panelSource = fs.readFileSync(path.join(__dirname, '../src/routes/panel/nodes.js'), 'utf8');
    assert.equal(
        panelSource.includes('CDN_ORIGIN_CANDIDATE_SELECT'),
        true,
        'node form must load CDN origin path/placement fields'
    );
    const cdnTemplate = fs.readFileSync(path.join(__dirname, '../views/partials/node-form/cdn.ejs'), 'utf8');
    const xrayTemplate = fs.readFileSync(path.join(__dirname, '../views/partials/node-form/xray.ejs'), 'utf8');
    const fingerprintTemplate = fs.readFileSync(path.join(__dirname, '../views/partials/node-form/fingerprint-picker.ejs'), 'utf8');
    assert.match(cdnTemplate, /include\('fingerprint-picker'/);
    assert.match(xrayTemplate, /include\('fingerprint-picker'/);
    assert.match(fingerprintTemplate, /data-fingerprint-picker/);
    assert.match(cdnTemplate, /cdnConnectionCard/);
    assert.match(cdnTemplate, /data-compatible/);

    // ---- Publication: edges expand into one entry each, with a domain fallback ----
    const { getXrayPublishedInbounds } = require('../src/routes/subscription');
    const origin = {
        _id: originId,
        type: 'xray',
        name: 'Origin',
        domain: 'origin.example.com',
        port: 443,
        xray: { transport: 'xhttp', security: 'tls', xhttpPath: '/api', extraInbounds: [] },
    };
    const cdnNode = (edges) => ({
        type: 'cdn',
        name: 'Front',
        _resolvedOrigin: origin,
        cdn: { originNode: originId, domain: 'cdn.example.com', port: 443, security: 'tls', edges },
    });

    const twoEdges = getXrayPublishedInbounds(cdnNode([
        { id: 'e1', label: 'Moscow', address: '203.0.113.10', enabled: true },
        { id: 'e2', label: '', address: '203.0.113.11', enabled: true },
    ]));
    assert.strictEqual(twoEdges.length, 2);
    assert.deepStrictEqual(twoEdges.map(i => i.address), ['203.0.113.10', '203.0.113.11']);
    assert.strictEqual(twoEdges[0].nameSuffix, 'Moscow');
    // An unlabelled edge must never leak its address into the client-visible name.
    assert.strictEqual(twoEdges[1].nameSuffix, 'Edge 2');

    const previousRandom = Math.random;
    Math.random = () => 0.99;
    const pooled = getXrayPublishedInbounds({
        ...cdnNode([
            { id: 'e1', address: '203.0.113.10', enabled: true },
            { id: 'e2', address: '203.0.113.11', enabled: true },
        ]),
        cdn: {
            ...cdnNode([]).cdn,
            fingerprint: 'firefox',
            fingerprintPool: ['safari', 'chrome'],
            edges: [
                { id: 'e1', address: '203.0.113.10', enabled: true },
                { id: 'e2', address: '203.0.113.11', enabled: true },
            ],
        },
    });
    Math.random = previousRandom;
    assert.deepStrictEqual(pooled.map(inbound => inbound.fingerprint), ['chrome', 'chrome']);

    const allDisabled = getXrayPublishedInbounds(cdnNode([
        { id: 'e1', label: 'Moscow', address: '203.0.113.10', enabled: false },
    ]));
    assert.strictEqual(allDisabled.length, 1);
    assert.strictEqual(allDisabled[0].address, 'cdn.example.com');
    assert.strictEqual(allDisabled[0].nameSuffix, '');

    const noEdges = getXrayPublishedInbounds(cdnNode([]));
    assert.strictEqual(noEdges.length, 1);
    assert.strictEqual(noEdges[0].address, 'cdn.example.com');

    console.log('CDN config tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
