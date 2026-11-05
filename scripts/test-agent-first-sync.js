'use strict';

const assert = require('assert');
const Module = require('module');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const originalLoad = Module._load;

const emptyQuery = {
    populate: async () => [],
    then(resolve) { return Promise.resolve(resolve([])); },
};

const HyNode = {
    updateOne: async () => ({ acknowledged: true }),
    findById: async () => null,
    findOneAndUpdate: async () => null,
};

class FakeSSH {
    async connect() {}
    disconnect() {}
    async uploadContent() {}
    async exec() { return { code: 0, stdout: '' }; }
}

const front = {
    async rollbackFrontDatabaseState() {},
    async clearFrontRollbackState() {},
    async discardPreparedFront() {},
};

Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../models/hyNodeModel') return HyNode;
    if (request === '../models/hyUserModel') return {};
    if (request === '../models/settingsModel') return {};
    if (request === './nodeSSH') return FakeSSH;
    if (request === './configGenerator') {
        return {
            generateXrayConfig: () => JSON.stringify({ routing: { rules: [] } }),
            ensurePrivateIpBlock: () => {},
        };
    }
    if (request === '../models/cascadeLinkModel') return { find: () => emptyQuery };
    if (request === './edgeFront/provisionService') return front;
    if (request === './cacheService') return {};
    if (request === '../utils/helpers') {
        return {
            invalidateNodesCache: async () => {},
            invalidateUserCache: async () => {},
        };
    }
    if (request === './webhookService') return { EVENTS: {}, emit: () => {} };
    if (request === './nodeSetup') {
        return {
            getPanelCertificates: () => null,
            isSameVpsAsPanel: () => false,
            XRAY_PERMS_SNIPPET: '# xray-perms-snippet',
            reloadCcAgent: async () => {},
        };
    }
    return originalLoad(request, parent, isMain);
};

const NEVER = '0001-01-01T00:00:00Z';

function node(overrides = {}) {
    return {
        _id: `node-${Math.random()}`,
        name: 'first-sync-test',
        ip: '127.0.0.1',
        type: 'xray',
        active: true,
        port: 443,
        ssh: { password: 'test' },
        xray: {
            agentToken: 'token',
            inboundTag: 'vless-in',
            security: 'reality',
            transport: 'tcp',
            extraInbounds: [],
            front: { enabled: false },
        },
        ...overrides,
    };
}

const users = [
    { userId: 'alice', xrayUuid: 'uuid-a' },
    { userId: 'bob', xrayUuid: 'uuid-b' },
    { userId: 'no-uuid', xrayUuid: '' },
];
const expectedPayload = [
    { id: 'uuid-a', email: 'alice', flow: 'xtls-rprx-vision' },
    { id: 'uuid-b', email: 'bob', flow: 'xtls-rprx-vision' },
];

async function run() {
    const lockPath = require.resolve('../src/utils/nodeSetupLock');
    try {
        delete require.cache[require.resolve('../src/services/syncService')];
        const sync = require('../src/services/syncService');
        const nodeSetupLock = require(lockPath);
        sync._getUsersForNode = async () => users;
        sync.checkXrayAgentHealth = async () => ({ online: true });

        let calls = [];
        let syncBodies = [];
        let infoData = {};
        let agentError = null;
        sync._agentRequest = async (_node, method, path, body) => {
            calls.push(`${method} ${path}`);
            if (agentError && path === '/sync') throw agentError;
            if (path === '/sync') syncBodies.push(body);
            return { status: 200, data: path === '/info' ? infoData : {} };
        };

        // Flow only applies to tcp + reality/tls; users without a UUID are skipped.
        assert.deepStrictEqual(sync._agentUserPayload(node(), users), expectedPayload);
        assert.deepStrictEqual(
            sync._agentUserPayload(node({ xray: { ...node().xray, transport: 'xhttp' } }), users),
            expectedPayload.map(u => ({ ...u, flow: '' }))
        );

        // pushUsersToAgent waits for the agent, then sends the full list once.
        calls = [];
        syncBodies = [];
        assert.strictEqual(await sync.pushUsersToAgent(node()), 2);
        assert.deepStrictEqual(calls, ['GET /health', 'POST /sync']);
        assert.deepStrictEqual(syncBodies, [{ users: expectedPayload }]);

        // An agent that rejects the list fails the push.
        agentError = new Error('[Agent] POST /sync returned HTTP 500: boom');
        await assert.rejects(sync.pushUsersToAgent(node()), /HTTP 500/);
        agentError = null;

        // A full sync sends the same payload as before the refactor.
        calls = [];
        syncBodies = [];
        assert.strictEqual(await sync.updateXrayNodeConfig(node()), true);
        assert.deepStrictEqual(syncBodies, [{ users: expectedPayload }]);

        let pushes = [];
        sync.schedulePush = (nodeId) => { pushes.push(String(nodeId)); };

        // A never-synced agent gets exactly one full sync per cooldown window.
        const unsynced = node();
        assert.strictEqual(sync._healUnsyncedAgent(unsynced, NEVER), true);
        assert.strictEqual(sync._healUnsyncedAgent(unsynced, NEVER), false);
        assert.deepStrictEqual(pushes, [String(unsynced._id)]);

        const cooldownKey = String(unsynced._id);
        sync.agentResyncAt.set(cooldownKey, Date.now() - 11 * 60 * 1000);
        assert.strictEqual(sync._healUnsyncedAgent(unsynced, NEVER), true);
        assert.strictEqual(pushes.length, 2);

        // Synced, unknown or missing last_sync values do nothing.
        pushes = [];
        assert.strictEqual(sync._healUnsyncedAgent(node(), new Date().toISOString()), false);
        assert.strictEqual(sync._healUnsyncedAgent(node(), undefined), false);
        assert.strictEqual(sync._healUnsyncedAgent(node(), 'not-a-date'), false);

        // Bridges and nodes held by another operation are skipped.
        assert.strictEqual(sync._healUnsyncedAgent(node({ cascadeRole: 'bridge' }), NEVER), false);
        const busy = node();
        assert.ok(nodeSetupLock.acquire(busy._id, 'Node setup'));
        try {
            assert.strictEqual(sync._healUnsyncedAgent(busy, NEVER), false);
        } finally {
            nodeSetupLock.release(busy._id);
        }
        assert.deepStrictEqual(pushes, []);

        // The minute health check wires last_sync from GET /info into the heal.
        const healthNode = node();
        infoData = { agent_version: '1.4.0', xray_version: '26.10.31', last_sync: NEVER };
        await sync.getXrayOnlineUsers(healthNode);
        assert.deepStrictEqual(pushes, [String(healthNode._id)]);

        pushes = [];
        infoData = { agent_version: '1.4.0', xray_version: '26.10.31', last_sync: new Date().toISOString() };
        await sync.getXrayOnlineUsers(node());
        assert.deepStrictEqual(pushes, []);

        console.log('agent first sync tests passed');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/services/syncService')];
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
