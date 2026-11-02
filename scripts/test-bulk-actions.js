'use strict';

const assert = require('assert');
const Module = require('module');

const ids = Array.from({ length: 8 }, (_, i) => `64f0000000000000000000${String(i + 1).padStart(2, '0')}`);
const SSH = { password: 'encrypted' };

let dbNodes = [];
let dbLinks = [];
let dbForwardLinks = [];
let lastBulkPreviewKcp = null;
const versionCalls = [];
const pendingFinish = new Map();
let inFlight = 0;
let maxInFlight = 0;
let startRejections = new Map();
const syncCalls = [];
let syncBehavior = async () => true;

const HyNode = {
    find(filter) {
        let result = dbNodes;
        if (filter?._id?.$in) {
            const wanted = new Set(filter._id.$in.map(String));
            result = dbNodes.filter(node => wanted.has(String(node._id)));
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
    findById: async id => dbNodes.find(node => String(node._id) === String(id)) || null,
};

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
    bulkPreview(nodes, _release, kcpNodeIds) {
        lastBulkPreviewKcp = kcpNodeIds;
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
    lastBulkPreviewKcp = null;
    versionCalls.length = 0;
    pendingFinish.clear();
    inFlight = 0;
    maxInFlight = 0;
    startRejections = new Map();
    syncCalls.length = 0;
    syncBehavior = async () => true;
    syncService.isSyncing = false;
    logs.length = 0;
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
    ]);

    // Xray preview: mKCP link ends are passed on, missing nodes are reported.
    reset();
    dbNodes = xrayNodes(2);
    dbNodes[1].skip = 'Node is offline';
    dbLinks = [{ portalNode: ids[0], bridgeNode: ids[7], tunnelTransport: 'kcp' }];
    let preview = await service.preview({ action: 'xray_version', nodeIds: [ids[0], ids[1], ids[6], ids[0]], params: { version: '26.7.28' } });
    assert.strictEqual(preview.items.length, 3, 'duplicate ids collapse');
    assert.deepStrictEqual([preview.ready, preview.skipped], [1, 2]);
    assert.strictEqual(preview.items[2].reason, 'Node not found');
    assert.ok(lastBulkPreviewKcp.has(ids[0]) && lastBulkPreviewKcp.has(ids[7]));

    // A forward-chain head needs mKCP when any hop down its chain uses it.
    dbLinks = [];
    dbForwardLinks = [
        { portalNode: ids[0], bridgeNode: ids[1], tunnelTransport: 'tcp' },
        { portalNode: ids[1], bridgeNode: ids[2], tunnelTransport: 'kcp' },
    ];
    dbNodes = xrayNodes(4);
    await service.preview({ action: 'xray_version', nodeIds: [ids[0], ids[3]], params: { version: '26.7.28' } });
    assert.ok(lastBulkPreviewKcp.has(ids[0]), 'chain head is checked');
    assert.ok(!lastBulkPreviewKcp.has(ids[3]), 'unrelated node is not');
    dbForwardLinks[1].tunnelTransport = 'tcp';
    await service.preview({ action: 'xray_version', nodeIds: [ids[0]], params: { version: '26.7.28' } });
    assert.strictEqual(lastBulkPreviewKcp.size, 0);
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
    ];
    assert.ok(nodeSetupLock.acquire(ids[4], 'Xray version change'));
    try {
        preview = await service.preview({ action: 'sync', nodeIds: ids.slice(0, 6) });
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
