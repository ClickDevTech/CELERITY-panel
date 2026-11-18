'use strict';

const assert = require('assert');
const Module = require('module');

const ids = Array.from({ length: 8 }, (_, i) => `64f0000000000000000000${String(i + 1).padStart(2, '0')}`);
const SSH = { password: 'encrypted' };

let dbNodes = [];
let dbLinks = [];
let dbForwardLinks = [];
let lastBulkPreviewLinks = null;
const versionCalls = [];
const pendingFinish = new Map();
let inFlight = 0;
let maxInFlight = 0;
let startRejections = new Map();
const syncCalls = [];
let syncBehavior = async () => true;
const dependentQueries = [];
const saves = [];

function readPath(target, dotted) {
    return dotted.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), target);
}

function writePath(target, dotted, value) {
    const parts = dotted.split('.');
    let cur = target;
    for (const part of parts.slice(0, -1)) {
        if (cur[part] == null) cur[part] = {};
        cur = cur[part];
    }
    if (value === undefined) delete cur[parts[parts.length - 1]];
    else cur[parts[parts.length - 1]] = value;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Mongoose-like document over the stored object.
function asDoc(node) {
    if (!node) return null;
    Object.defineProperties(node, {
        toObject: { value: () => JSON.parse(JSON.stringify(node)), configurable: true },
        set: { value: (path, value) => writePath(node, path, JSON.parse(JSON.stringify(value))), configurable: true },
        save: { value: async () => { saves.push(JSON.parse(JSON.stringify(node))); }, configurable: true },
    });
    return node;
}

const HyNode = {
    find(filter) {
        let result = dbNodes;
        if (filter?._id?.$in) {
            const wanted = new Set(filter._id.$in.map(String));
            result = dbNodes.filter(node => wanted.has(String(node._id)));
        } else if (filter?.type === 'cdn') {
            dependentQueries.push(filter);
            const origins = filter['cdn.originNode']?.$in
                ? filter['cdn.originNode'].$in.map(String)
                : [String(filter['cdn.originNode'])];
            result = dbNodes.filter(node => node.type === 'cdn' && origins.includes(String(node.cdn?.originNode)));
        } else if (filter?.type === 'xray') {
            result = dbNodes.filter(node => node.type === 'xray');
        }
        const query = {
            select() { return query; },
            limit() { return query; },
            lean: async () => JSON.parse(JSON.stringify(result)),
        };
        return query;
    },
    findById(id) {
        const load = () => Promise.resolve(asDoc(dbNodes.find(node => String(node._id) === String(id)) || null));
        return { select: () => load(), then: (resolve, reject) => load().then(resolve, reject) };
    },
    async updateOne(filter, update) {
        const node = dbNodes.find(item => String(item._id) === String(filter._id));
        if (!node) return { modifiedCount: 0 };
        let index = null;
        for (const [key, expected] of Object.entries(filter)) {
            if (key === '_id') continue;
            if (key === 'xray.extraInbounds') {
                index = (node.xray.extraInbounds || []).findIndex(inbound =>
                    Object.entries(expected.$elemMatch).every(([k, v]) => same(inbound[k], v)));
                if (index < 0) return { modifiedCount: 0 };
            } else if (!same(readPath(node, key), expected)) {
                return { modifiedCount: 0 };
            }
        }
        const resolve = path => path.replace('$', String(index));
        for (const [path, value] of Object.entries(update.$set || {})) writePath(node, resolve(path), value);
        for (const path of Object.keys(update.$unset || {})) writePath(node, resolve(path), undefined);
        return { modifiedCount: 1 };
    },
};

const panelHelpers = {
    validateXrayFormFields: () => null,
    validateHysteriaFormFields: () => null,
    mergeRealityGuard: () => ({ mode: 'auto', status: 'ok' }),
};
let cacheInvalidations = 0;

const CascadeLink = {
    find(filter) {
        const query = {
            select() { return query; },
            lean: async () => (filter?.mode === 'forward' ? dbForwardLinks : dbLinks),
        };
        return query;
    },
};

const cascadeService = {
    _walkForwardChain(links, startNodeId) {
        const chain = [];
        const seen = new Set();
        let current = String(startNodeId);
        while (!seen.has(current)) {
            seen.add(current);
            const next = links.filter(link => String(link.portalNode) === current);
            if (!next.length) break;
            chain.push(...next);
            current = String(next[next.length - 1].bridgeNode);
        }
        return chain;
    },
};

const xrayVersionService = {
    getKnownRelease: async version => (String(version).replace(/^v/, '') === '26.7.28' ? { version: '26.7.28', tag: 'v26.7.28' } : null),
    bulkPreview(nodes, _release, nodeLinks) {
        lastBulkPreviewLinks = nodeLinks;
        return nodes.map(node => ({
            nodeId: String(node._id),
            ready: !node.skip,
            reason: node.skip || null,
            warnings: [],
        }));
    },
    async startVersionChange(nodeId, version, { onFinish }) {
        versionCalls.push({ nodeId, version });
        const rejection = startRejections.get(nodeId);
        if (rejection) throw rejection;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        pendingFinish.set(nodeId, (state, extra = {}) => {
            inFlight -= 1;
            pendingFinish.delete(nodeId);
            onFinish({ state, error: state === 'error' ? 'boom' : null, currentVersion: '26.3.27', ...extra });
        });
        return { state: 'running' };
    },
    getTaskProgress: nodeId => (pendingFinish.has(nodeId) ? { state: 'running', step: 'download' } : { state: 'idle', step: null }),
};

const syncService = {
    isSyncing: false,
    async updateNodeConfig(node, opts) {
        syncCalls.push({ nodeId: String(node._id), opts });
        return syncBehavior(node, opts);
    },
};

const logs = [];
const stubs = {
    '../models/hyNodeModel': HyNode,
    '../models/cascadeLinkModel': CascadeLink,
    '../utils/logger': {
        info: () => {},
        warn: message => logs.push(message),
        error: message => logs.push(message),
        debug: () => {},
    },
    './xrayVersionService': xrayVersionService,
    './syncService': syncService,
    './cascadeService': cascadeService,
    '../routes/panel/helpers': panelHelpers,
    '../utils/helpers': { invalidateNodesCache: async () => { cacheInvalidations += 1; } },
    '../utils/vlessEncryption': { versionError: () => null },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
};

const service = require('../src/services/bulkActionService');
const nodeSetupLock = require('../src/utils/nodeSetupLock');

async function flush(rounds = 6) {
    for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

function xrayNodes(count, extra = {}) {
    return ids.slice(0, count).map((id, index) => ({
        _id: id, name: `n${index + 1}`, type: 'xray', status: 'online', ssh: SSH, xray: {}, ...extra,
    }));
}

function reset() {
    service._test.reset();
    dbNodes = [];
    dbLinks = [];
    dbForwardLinks = [];
    lastBulkPreviewLinks = null;
    versionCalls.length = 0;
    pendingFinish.clear();
    inFlight = 0;
    maxInFlight = 0;
    startRejections = new Map();
    syncCalls.length = 0;
    syncBehavior = async () => true;
    syncService.isSyncing = false;
    logs.length = 0;
    dependentQueries.length = 0;
    saves.length = 0;
    cacheInvalidations = 0;
    panelHelpers.validateXrayFormFields = () => null;
}

async function finish(nodeId, state, extra) {
    const done = pendingFinish.get(nodeId);
    assert.ok(done, `node ${nodeId} should be running`);
    done(state, extra);
    await flush();
}

async function expectStatus(promise, statusCode, pattern) {
    await assert.rejects(promise, (error) => {
        assert.strictEqual(error.statusCode, statusCode);
        if (pattern) assert.match(error.message, pattern);
        return true;
    });
}

(async () => {
    // Canary goes alone, the rest respect the action's concurrency.
    reset();
    dbNodes = xrayNodes(5);
    let snapshot = await service.start({ action: 'xray_version', nodeIds: ids.slice(0, 5), params: { version: 'v26.7.28' }, actor: 'admin:test' });
    assert.strictEqual(snapshot.state, 'running');
    assert.deepStrictEqual(snapshot.params, { version: '26.7.28' });
    await flush();
    assert.strictEqual(versionCalls.length, 1, 'canary runs alone');
    assert.strictEqual(service.status().items[0].step, 'download');
    await finish(ids[0], 'done');
    assert.strictEqual(versionCalls.length, 3, 'two nodes follow the canary');
    await expectStatus(service.start({ action: 'sync', nodeIds: [ids[0]] }), 409, /already running/);
    await finish(ids[1], 'done');
    await finish(ids[2], 'done');
    await finish(ids[3], 'done');
    await finish(ids[4], 'done');
    snapshot = service.status();
    assert.strictEqual(snapshot.state, 'done');
    assert.strictEqual(snapshot.counts.done, 5);
    assert.strictEqual(maxInFlight, 2);
    assert.strictEqual(snapshot.items[0].details.fromVersion, '26.3.27');
    assert.ok(logs.some(line => /started by admin:test/.test(line)));

    // Two failures stop scheduling; queued nodes are cancelled, in-flight ones finish.
    reset();
    dbNodes = xrayNodes(6);
    await service.start({ action: 'xray_version', nodeIds: ids.slice(0, 6), params: { version: '26.7.28' }, actor: 'a' });
    await flush();
    await finish(ids[0], 'done');
    await finish(ids[1], 'error');
    assert.strictEqual(versionCalls.length, 4);
    await finish(ids[2], 'error', { rollbackSucceeded: true });
    assert.strictEqual(service.status().state, 'stopping');
    await finish(ids[3], 'done');
    snapshot = service.status();
    assert.strictEqual(snapshot.state, 'stopped');
    assert.strictEqual(snapshot.stopReason, 'failures');
    assert.deepStrictEqual(
        { done: snapshot.counts.done, error: snapshot.counts.error, cancelled: snapshot.counts.cancelled },
        { done: 2, error: 2, cancelled: 2 }
    );
    assert.strictEqual(snapshot.items[2].details.rollbackSucceeded, true);
    assert.strictEqual(versionCalls.length, 4);

    // A failed canary stops the whole batch.
    reset();
    dbNodes = xrayNodes(3);
    await service.start({ action: 'xray_version', nodeIds: ids.slice(0, 3), params: { version: '26.7.28' } });
    await flush();
    await finish(ids[0], 'error');
    snapshot = service.status();
    assert.strictEqual(snapshot.state, 'stopped');
    assert.strictEqual(snapshot.stopReason, 'canary');
    assert.strictEqual(snapshot.counts.cancelled, 2);
    assert.strictEqual(versionCalls.length, 1);

    // Cancel lets the running node finish and cancels the rest.
    reset();
    dbNodes = xrayNodes(3);
    await service.start({ action: 'xray_version', nodeIds: ids.slice(0, 3), params: { version: '26.7.28' } });
    await flush();
    assert.strictEqual(service.cancel('admin:test').state, 'stopping');
    await finish(ids[0], 'done');
    snapshot = service.status();
    assert.strictEqual(snapshot.state, 'cancelled');
    assert.strictEqual(snapshot.counts.done, 1);
    assert.strictEqual(snapshot.counts.cancelled, 2);
    assert.throws(() => service.cancel('admin:test'), error => error.statusCode === 409);

    // A node rejected at start (busy/incompatible) is skipped, not a failure,
    // and the next node becomes the canary.
    reset();
    dbNodes = xrayNodes(3);
    startRejections.set(ids[0], Object.assign(new Error('Node is busy: Node setup is running'), { statusCode: 409 }));
    await service.start({ action: 'xray_version', nodeIds: ids.slice(0, 3), params: { version: '26.7.28' } });
    await flush();
    assert.strictEqual(versionCalls.length, 2, 'next node becomes the canary');
    assert.strictEqual(pendingFinish.size, 1);
    await finish(ids[1], 'done');
    await finish(ids[2], 'done');
    snapshot = service.status();
    assert.strictEqual(snapshot.state, 'done');
    assert.strictEqual(snapshot.items[0].state, 'skipped');
    assert.match(snapshot.items[0].error, /busy/);

    // Input validation.
    reset();
    await expectStatus(service.preview({ action: 'rm_rf', nodeIds: [ids[0]] }), 400, /Unknown bulk action/);
    await expectStatus(service.preview({ action: '__proto__', nodeIds: [ids[0]] }), 400, /Unknown bulk action/);
    await expectStatus(service.preview({ action: 'sync', nodeIds: [] }), 400, /at least one/);
    await expectStatus(service.preview({ action: 'sync', nodeIds: 'x' }), 400, /array/);
    await expectStatus(service.preview({ action: 'sync', nodeIds: ['nope'] }), 400, /Invalid node id/);
    await expectStatus(
        service.preview({ action: 'sync', nodeIds: Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(24, '0')) }),
        400,
        /At most 200/
    );
    await expectStatus(service.preview({ action: 'xray_version', nodeIds: [ids[0]], params: { version: '1.0.0' } }), 400, /Unknown Xray release/);
    assert.deepStrictEqual(service.listActions(), [
        { id: 'xray_version', requiresReauth: true },
        { id: 'sync', requiresReauth: false },
        { id: 'config_patch', requiresReauth: true },
    ]);

    // Xray preview: both ends of a link get it, missing nodes are reported.
    reset();
    dbNodes = xrayNodes(2);
    dbNodes[1].skip = 'Node is offline';
    dbLinks = [{ _id: 'l1', portalNode: ids[0], bridgeNode: ids[7], tunnelTransport: 'kcp' }];
    let preview = await service.preview({ action: 'xray_version', nodeIds: [ids[0], ids[1], ids[6], ids[0]], params: { version: '26.7.28' } });
    assert.strictEqual(preview.items.length, 3, 'duplicate ids collapse');
    assert.deepStrictEqual([preview.ready, preview.skipped], [1, 2]);
    assert.strictEqual(preview.items[2].reason, 'Node not found');
    assert.deepStrictEqual(lastBulkPreviewLinks.get(ids[0]).map(l => l._id), ['l1']);
    assert.deepStrictEqual(lastBulkPreviewLinks.get(ids[7]).map(l => l._id), ['l1']);

    // A forward-chain head runs every hop down its chain, once each.
    dbLinks = [];
    dbForwardLinks = [
        { _id: 'f1', portalNode: ids[0], bridgeNode: ids[1], tunnelTransport: 'tcp' },
        { _id: 'f2', portalNode: ids[1], bridgeNode: ids[2], tunnelTransport: 'kcp' },
    ];
    dbNodes = xrayNodes(4);
    await service.preview({ action: 'xray_version', nodeIds: [ids[0], ids[3]], params: { version: '26.7.28' } });
    assert.deepStrictEqual(lastBulkPreviewLinks.get(ids[0]).map(l => l._id), ['f1', 'f2'], 'chain head is checked');
    assert.ok(!lastBulkPreviewLinks.has(ids[3]), 'unrelated node is not');
    dbNodes = xrayNodes(2);
    dbNodes[1].skip = 'Node is offline';

    await expectStatus(service.start({ action: 'xray_version', nodeIds: [ids[1]], params: { version: '26.7.28' } }), 400, /No selected node is ready/);

    // Sync preview reasons and the full-sync guard.
    reset();
    dbNodes = [
        { _id: ids[0], name: 'ok', type: 'hysteria', status: 'online', ssh: SSH },
        { _id: ids[1], name: 'cdn', type: 'cdn', status: 'online', ssh: {} },
        { _id: ids[2], name: 'bare', type: 'hysteria', status: 'online', ssh: {} },
        { _id: ids[3], name: 'agent', type: 'xray', status: 'offline', ssh: {}, xray: { agentToken: 't' } },
        { _id: ids[4], name: 'busy', type: 'xray', status: 'online', ssh: SSH, xray: {} },
        { _id: ids[5], name: 'off', type: 'hysteria', status: 'offline', active: false, ssh: SSH },
        { _id: ids[6], name: 'bridge', type: 'xray', status: 'offline', cascadeRole: 'bridge', ssh: SSH, xray: {} },
    ];
    assert.ok(nodeSetupLock.acquire(ids[4], 'Xray version change'));
    try {
        preview = await service.preview({ action: 'sync', nodeIds: ids.slice(0, 7) });
    } finally {
        nodeSetupLock.release(ids[4]);
    }
    const reasons = preview.items.map(item => item.reason);
    assert.strictEqual(reasons[0], null);
    assert.match(reasons[1], /no remote service/);
    assert.match(reasons[2], /Neither SSH nor agent/);
    assert.strictEqual(reasons[3], null);
    assert.deepStrictEqual(preview.items[3].warnings, ['Node is offline']);
    assert.match(reasons[4], /busy/);
    assert.strictEqual(reasons[5], 'Node is disabled');
    assert.deepStrictEqual(preview.items[6].warnings, [], 'bridges are offline by design');
    assert.ok(preview.items.every(item => !('deferred' in item)), 'deferred stays internal');

    syncService.isSyncing = true;
    preview = await service.preview({ action: 'sync', nodeIds: [ids[0]] });
    assert.strictEqual(preview.ready, 0);
    assert.match(preview.items[0].reason, /full sync/);
    await expectStatus(service.start({ action: 'sync', nodeIds: [ids[0]] }), 409, /full sync/);
    syncService.isSyncing = false;

    // Sync run: false result carries the report reason, busy is a skip.
    reset();
    dbNodes = [
        { _id: ids[0], name: 'a', type: 'hysteria', status: 'online', ssh: SSH },
        { _id: ids[1], name: 'b', type: 'hysteria', status: 'online', ssh: SSH },
        { _id: ids[2], name: 'c', type: 'xray', status: 'online', ssh: SSH, xray: {} },
        { _id: ids[3], name: 'd', type: 'hysteria', status: 'online', ssh: SSH },
    ];
    syncBehavior = async (node, opts) => {
        // Disabled after the preview: the run must not touch it.
        if (String(node._id) === ids[0]) dbNodes[3].active = false;
        if (String(node._id) === ids[1]) {
            opts.report.error = 'Failed to update config';
            return false;
        }
        if (String(node._id) === ids[2]) throw new Error('Node is busy: Xray config sync is running');
        return true;
    };
    await service.start({ action: 'sync', nodeIds: ids.slice(0, 4), actor: 'mcp:test' });
    await flush(20);
    snapshot = service.status();
    assert.strictEqual(snapshot.state, 'done');
    assert.deepStrictEqual(snapshot.items.map(item => item.state), ['done', 'error', 'skipped', 'skipped']);
    assert.strictEqual(snapshot.items[1].error, 'Failed to update config');
    assert.strictEqual(snapshot.items[3].error, 'Node is disabled');
    assert.ok(!syncCalls.some(call => call.nodeId === ids[3]));
    assert.ok(syncCalls.every(call => call.opts && typeof call.opts.report === 'object'));

    // Sync run: offline nodes go last and never act as the canary.
    reset();
    dbNodes = [
        { _id: ids[0], name: 'down', type: 'hysteria', status: 'offline', ssh: SSH },
        { _id: ids[1], name: 'up', type: 'hysteria', status: 'online', ssh: SSH },
        { _id: ids[2], name: 'bridge', type: 'xray', status: 'offline', cascadeRole: 'bridge', ssh: SSH, xray: {} },
    ];
    syncBehavior = async node => String(node._id) !== ids[0];
    await service.start({ action: 'sync', nodeIds: ids.slice(0, 3), actor: 'mcp:test' });
    await flush(20);
    assert.deepStrictEqual(syncCalls.map(call => call.nodeId), [ids[1], ids[2], ids[0]]);
    snapshot = service.status();
    assert.strictEqual(snapshot.state, 'done', 'a failed offline node is not a canary stop');
    assert.deepStrictEqual(snapshot.items.map(item => item.state), ['error', 'done', 'done']);
    assert.ok(snapshot.items.every(item => !('deferred' in item)));

    // config_patch: input is checked against the allowlist before any node.
    reset();
    await expectStatus(service.preview({ action: 'config_patch', nodeIds: [ids[0]], params: { path: 'ssh.password', value: 'x' } }),
        400, /cannot be changed in bulk/);
    await expectStatus(service.preview({ action: 'config_patch', nodeIds: [ids[0]], params: { path: 'xray.alpn', value: 'h2,spdy' } }),
        400, /alpn/);
    assert.deepStrictEqual(service.getAction('config_patch').allFilterFor({ path: 'aclRules' }),
        { type: { $in: ['xray', 'hysteria'] }, active: true });
    assert.throws(() => service.getAction('config_patch').allFilterFor({ path: 'xray.port' }), error => error.statusCode === 400);

    // config_patch preview: per-node verdicts, before/after, one CDN query.
    const tlsXray = (id, name, extra = {}) => ({
        _id: id, name, type: 'xray', status: 'online', ssh: SSH,
        xray: { security: 'tls', transport: 'ws', wsPath: '/ws', alpn: ['h2'], extraInbounds: [] },
        ...extra,
    });
    dbNodes = [
        tlsXray(ids[0], 'tls'),
        { _id: ids[1], name: 'reality', type: 'xray', status: 'online', ssh: SSH, xray: { security: 'reality', alpn: [] } },
        { _id: ids[2], name: 'hy', type: 'hysteria', status: 'online', ssh: SSH },
        tlsXray(ids[3], 'off', { active: false }),
        tlsXray(ids[4], 'bridge', { cascadeRole: 'bridge' }),
        tlsXray(ids[5], 'busy'),
        tlsXray(ids[6], 'down', { status: 'offline' }),
        { _id: ids[7], name: 'front-cdn', type: 'cdn', cdn: { originNode: ids[0], path: '/ws' } },
    ];
    assert.ok(nodeSetupLock.acquire(ids[5], 'Node setup'));
    try {
        preview = await service.preview({ action: 'config_patch', nodeIds: ids.slice(0, 7), params: { path: 'xray.alpn', value: 'h3,h2' } });
    } finally {
        nodeSetupLock.release(ids[5]);
    }
    assert.deepStrictEqual(preview.params, { path: 'xray.alpn', op: 'set', value: ['h3', 'h2'], scope: 'main_extras' });
    const patchReasons = preview.items.map(item => item.reason);
    assert.strictEqual(patchReasons[0], null);
    assert.deepStrictEqual(preview.items[0].changes, [{ inbound: 'main', before: ['h2'], after: ['h3', 'h2'] }]);
    assert.match(patchReasons[1], /security is reality/);
    assert.match(patchReasons[2], /Not available for hysteria/);
    assert.strictEqual(patchReasons[3], 'Node is disabled');
    assert.match(patchReasons[4], /cascade links/);
    assert.match(patchReasons[5], /busy/);
    assert.strictEqual(patchReasons[6], null);
    assert.deepStrictEqual(preview.items[6].warnings, ['Node is offline']);
    assert.strictEqual(dependentQueries.length, 1, 'CDN dependents are loaded in one query');
    assert.ok(Array.isArray(dependentQueries[0]['cdn.originNode'].$in));

    // A path change that would break a CDN front is refused for that node only.
    dependentQueries.length = 0;
    preview = await service.preview({ action: 'config_patch', nodeIds: [ids[0], ids[6]], params: { path: 'xray.wsPath', value: '/new' } });
    assert.match(preview.items[0].reason, /CDN node "front-cdn" depends on this node/);
    assert.strictEqual(preview.items[1].reason, null);
    assert.strictEqual(dependentQueries.length, 1);

    // The panel form rules see the final state.
    panelHelpers.validateXrayFormFields = xray => (xray.wsPath === '/bad' ? 'Main inbound: bad path' : null);
    preview = await service.preview({ action: 'config_patch', nodeIds: [ids[6]], params: { path: 'xray.wsPath', value: '/bad' } });
    assert.strictEqual(preview.items[0].reason, 'Main inbound: bad path');

    // config_patch run: saved, pushed with a report, cache invalidated.
    reset();
    dbNodes = [tlsXray(ids[0], 'a'), tlsXray(ids[1], 'b')];
    snapshot = await service.start({ action: 'config_patch', nodeIds: ids.slice(0, 2), params: { path: 'xray.alpn', value: 'h3' }, actor: 'admin:test' });
    await flush(30);
    snapshot = service.status();
    assert.strictEqual(snapshot.state, 'done');
    assert.deepStrictEqual(snapshot.items.map(item => item.state), ['done', 'done']);
    assert.deepStrictEqual(dbNodes[0].xray.alpn, ['h3']);
    assert.strictEqual(saves.length, 2);
    assert.ok(syncCalls.every(call => typeof call.opts.report === 'object'));
    assert.ok(cacheInvalidations >= 2);
    assert.ok(logs.some(line => /config_patch batch .* started by admin:test: params=\{"path":"xray.alpn"/.test(line)));

    // Failed push: only the patched field goes back, then the old config is pushed.
    reset();
    dbNodes = [tlsXray(ids[0], 'a', { xray: { security: 'tls', transport: 'ws', wsPath: '/ws', alpn: ['h2'], fingerprint: 'chrome', extraInbounds: [
        { id: 'e1', label: 'x', security: 'tls', transport: 'xhttp', alpn: ['http/1.1'], port: 8443 },
    ] } })];
    let pushes = 0;
    syncBehavior = async (node, opts) => {
        pushes += 1;
        if (pushes === 1) {
            // Someone edits an unrelated field while the push runs.
            dbNodes[0].xray.fingerprint = 'firefox';
            opts.report.error = 'xray -test failed';
            return false;
        }
        return true;
    };
    await service.start({ action: 'config_patch', nodeIds: [ids[0]], params: { path: 'xray.alpn', value: 'h3' } });
    await flush(30);
    snapshot = service.status();
    assert.strictEqual(snapshot.items[0].state, 'error');
    assert.strictEqual(snapshot.items[0].error, 'xray -test failed');
    assert.deepStrictEqual(snapshot.items[0].details, { rolledBack: true, configRestored: true });
    assert.deepStrictEqual(dbNodes[0].xray.alpn, ['h2'], 'main inbound restored');
    assert.deepStrictEqual(dbNodes[0].xray.extraInbounds[0].alpn, ['http/1.1'], 'extra inbound restored');
    assert.strictEqual(dbNodes[0].xray.fingerprint, 'firefox', 'the concurrent edit is kept');
    assert.strictEqual(pushes, 2, 'the restored config is pushed');

    // A field changed again in the meantime is not overwritten by the rollback.
    reset();
    dbNodes = [tlsXray(ids[0], 'a')];
    syncBehavior = async (node, opts) => {
        dbNodes[0].xray.alpn = ['http/1.1'];
        opts.report.error = 'restart failed';
        return false;
    };
    await service.start({ action: 'config_patch', nodeIds: [ids[0]], params: { path: 'xray.alpn', value: 'h3' } });
    await flush(30);
    snapshot = service.status();
    assert.deepStrictEqual(dbNodes[0].xray.alpn, ['http/1.1']);
    assert.deepStrictEqual(snapshot.items[0].details, { rolledBack: false, configRestored: false });
    assert.strictEqual(syncCalls.length, 1, 'nothing to restore, no second push');

    // Busy at push time: skipped, the database change is undone, no push retry.
    reset();
    dbNodes = [tlsXray(ids[0], 'a'), tlsXray(ids[1], 'b')];
    syncBehavior = async (node) => {
        if (String(node._id) === ids[0]) throw new Error('Node is busy: Node setup is running');
        return true;
    };
    await service.start({ action: 'config_patch', nodeIds: ids.slice(0, 2), params: { path: 'xray.alpn', value: 'h3' } });
    await flush(30);
    snapshot = service.status();
    assert.deepStrictEqual(snapshot.items.map(item => item.state), ['skipped', 'done']);
    assert.deepStrictEqual(dbNodes[0].xray.alpn, ['h2']);
    assert.strictEqual(syncCalls.filter(call => call.nodeId === ids[0]).length, 1);

    // ACL rules on Hysteria: added before the catch-all, pushed through the lock-aware path.
    reset();
    dbNodes = [
        { _id: ids[0], name: 'hy', type: 'hysteria', status: 'online', ssh: SSH, acl: { enabled: true, type: 'inline' },
            outbounds: [], aclRules: ['reject(geoip:private)', 'direct(all)'] },
        { _id: ids[1], name: 'hy-file', type: 'hysteria', status: 'online', ssh: SSH, acl: { enabled: true, type: 'file' }, aclRules: [] },
    ];
    preview = await service.preview({ action: 'config_patch', nodeIds: ids.slice(0, 2), params: { path: 'aclRules', op: 'add', value: 'reject(geoip:cn)' } });
    assert.deepStrictEqual([preview.ready, preview.skipped], [1, 1]);
    assert.match(preview.items[1].reason, /from a file/);
    await service.start({ action: 'config_patch', nodeIds: ids.slice(0, 2), params: { path: 'aclRules', op: 'add', value: 'reject(geoip:cn)' } });
    await flush(30);
    assert.deepStrictEqual(dbNodes[0].aclRules, ['reject(geoip:cn)', 'reject(geoip:private)', 'direct(all)']);
    assert.strictEqual(dependentQueries.length, 0, 'Hysteria nodes have no CDN dependents');

    // Status is idle before any batch.
    reset();
    assert.deepStrictEqual(service.status(), { state: 'idle' });

    Module._load = originalLoad;
    console.log('bulk action tests passed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
