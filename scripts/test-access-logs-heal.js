/**
 * Access-logs self-heal tests.
 *
 * The health check feeds every answering node through healNodeIfDrifted. These
 * tests drive the real provisionService against an in-memory node store and
 * check that drifted nodes are reconciled, failures surface as `error`, busy
 * nodes are retried, and cooldowns stop restart loops.
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const store = new Map();
let settings;
let pushes = [];
let pushBehavior = () => true;

function setPath(target, dotted, value) {
    const parts = dotted.split('.');
    let cur = target;
    for (const part of parts.slice(0, -1)) {
        if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
        cur = cur[part];
    }
    cur[parts[parts.length - 1]] = value;
}

function snapshot(id) {
    return JSON.parse(JSON.stringify(store.get(String(id))));
}

const fakeHyNode = {
    async updateOne(filter, update) {
        const doc = store.get(String(filter._id));
        if (!doc) return { matchedCount: 0 };
        for (const [key, value] of Object.entries(update.$set || {})) setPath(doc, key, value);
        return { matchedCount: 1 };
    },
    findById(id) {
        const load = () => Promise.resolve(store.has(String(id)) ? snapshot(id) : null);
        return {
            select: () => load(),
            then: (resolve, reject) => load().then(resolve, reject),
        };
    },
};

const fakeCredentialService = {
    async ensureIngestToken(node) {
        setPath(store.get(String(node._id)), 'xray.accessLogs.ingestTokenHash', 'hash-' + node._id);
        return { token: 'token-' + node._id };
    },
    async revokeIngestToken(nodeId) {
        setPath(store.get(String(nodeId)), 'xray.accessLogs.ingestTokenHash', '');
    },
};

const fakeSyncService = {
    async updateXrayNodeConfig(node, options = {}) {
        pushes.push(String(node._id));
        return pushBehavior(node, options);
    },
};

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
const provisionFile = path.resolve(__dirname, '../src/services/accessLogs/provisionService.js');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.filename === provisionFile) {
        if (request === '../../models/hyNodeModel') return fakeHyNode;
        if (request === './credentialService') return fakeCredentialService;
        if (request === '../syncService') return fakeSyncService;
        if (request === '../../utils/helpers') return { getSettings: async () => settings };
        if (request === '../../utils/logger') return quietLogger;
        if (request === '../../../config') return { BASE_URL: 'https://panel.example.com' };
        if (request === '../configGenerator') return { XRAY_ACCESS_LOG_PATH: '/var/log/xray/access.log' };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const provision = require('../src/services/accessLogs/provisionService');
const nodeSetupLock = require('../src/utils/nodeSetupLock');

let nextId = 1;
function addNode(overrides = {}) {
    const id = `node${nextId++}`;
    const doc = {
        _id: id,
        name: id,
        type: 'xray',
        cascadeRole: 'standalone',
        agentVersion: '1.4.2',
        ssh: { privateKey: 'key', password: '' },
        xray: { accessLogs: { enabled: false, status: 'disabled', appliedFingerprint: '', ingestTokenHash: '' } },
        ...overrides,
    };
    store.set(id, doc);
    return id;
}

const MINUTE = 60 * 1000;
let now = Date.now();
const realNow = Date.now;
Date.now = () => now;

async function heal(id, agentVersion = '1.4.2') {
    await provision.healNodeIfDrifted(snapshot(id), agentVersion);
}

function status(id) {
    return store.get(id).xray.accessLogs;
}

async function run() {
    settings = { accessLogs: { enabled: true, nodeScope: 'all', nodeIds: [] } };

    // --- pure drift detection ---------------------------------------------
    {
        const drift = provision.accessLogsDrift;
        const base = { _id: 'x', type: 'xray', cascadeRole: 'standalone' };
        const al = (fields) => ({ ...base, xray: { accessLogs: fields } });
        assert.strictEqual(drift(al({ enabled: false, status: 'disabled' }), settings, '1.4.0'), 'should be enabled');
        assert.strictEqual(drift(al({ enabled: true, status: 'active' }), settings, '1.4.0'), null);
        assert.strictEqual(drift(al({ enabled: false, status: 'disabled' }), settings, '1.3.9'), 'agent outdated');
        assert.strictEqual(drift(al({ enabled: false, status: 'agent-outdated' }), settings, '1.3.9'), null);
        assert.strictEqual(drift(al({ enabled: false, status: 'agent-outdated' }), settings, '1.4.0'), 'should be enabled');
        assert.strictEqual(drift(al({ enabled: true, status: 'error' }), settings, '1.4.0'), 'status error');
        assert.strictEqual(drift(al({ enabled: true, status: 'pending', lastReconcileAt: new Date(now) }), settings, '1.4.0', now), null);
        assert.strictEqual(drift(al({ enabled: true, status: 'pending', lastReconcileAt: new Date(now - 16 * MINUTE) }), settings, '1.4.0', now), 'stuck in pending');
        assert.strictEqual(drift({ ...base, cascadeRole: 'bridge', xray: { accessLogs: { enabled: false } } }, settings, '1.4.0'), null, 'bridges never ship');
        assert.strictEqual(drift({ ...base, cascadeRole: 'bridge', xray: { accessLogs: { enabled: true } } }, settings, '1.4.0'), 'should be disabled');
        const off = { accessLogs: { enabled: false } };
        assert.strictEqual(drift(al({ enabled: true, status: 'active' }), off, '1.4.0'), 'should be disabled');
        assert.strictEqual(drift(al({ enabled: false, status: 'disabled' }), off, '1.4.0'), null);
        const selected = { accessLogs: { enabled: true, nodeScope: 'selected', nodeIds: ['other'] } };
        assert.strictEqual(drift(al({ enabled: false, status: 'disabled' }), selected, '1.4.0'), null);
    }

    // --- a node added after the settings save gets enabled ---------------
    {
        const id = addNode();
        pushes = [];
        await heal(id);
        assert.deepStrictEqual(pushes, [id], 'drifted node is pushed');
        assert.strictEqual(status(id).enabled, true);
        assert.strictEqual(status(id).status, 'active');

        // In sync now: nothing happens even after the cooldown.
        now += 11 * MINUTE;
        pushes = [];
        await heal(id);
        assert.deepStrictEqual(pushes, [], 'healthy node is left alone');
    }

    // --- cooldown blocks a second attempt soon after the first -----------
    {
        const id = addNode();
        await heal(id);
        setPath(store.get(id), 'xray.accessLogs.enabled', false);
        setPath(store.get(id), 'xray.accessLogs.status', 'disabled');
        pushes = [];
        now += 5 * MINUTE;
        await heal(id);
        assert.deepStrictEqual(pushes, [], 'second heal within cooldown is skipped');
        now += 6 * MINUTE;
        await heal(id);
        assert.deepStrictEqual(pushes, [id], 'heal resumes after cooldown');
    }

    // --- outdated agent is marked, then picked up after the upgrade ------
    {
        const id = addNode({ agentVersion: '1.3.0' });
        pushes = [];
        await heal(id, '1.3.0');
        assert.deepStrictEqual(pushes, [], 'outdated agent never gets a push');
        assert.strictEqual(status(id).status, 'agent-outdated');

        now += 11 * MINUTE;
        await heal(id, '1.3.0');
        assert.deepStrictEqual(pushes, [], 'already marked outdated: no drift');

        // The stored agentVersion is still stale; the version from /info wins.
        await heal(id, '1.4.0');
        assert.deepStrictEqual(pushes, [id], 'upgraded agent is enabled');
        assert.strictEqual(status(id).status, 'active');
        assert.strictEqual(status(id).enabled, true);
    }

    // --- failed push surfaces as error and backs off for an hour ---------
    {
        const id = addNode();
        pushBehavior = (node, options) => {
            options.report.error = 'xray -test failed';
            return false;
        };
        pushes = [];
        await heal(id);
        assert.deepStrictEqual(pushes, [id]);
        assert.strictEqual(status(id).status, 'error', 'false from updateXrayNodeConfig is an error');
        assert.strictEqual(status(id).lastError, 'xray -test failed');

        pushBehavior = () => true;
        now += 30 * MINUTE;
        await heal(id);
        assert.deepStrictEqual(pushes, [id], 'error cooldown holds for an hour');
        now += 31 * MINUTE;
        await heal(id);
        assert.deepStrictEqual(pushes, [id, id], 'error is retried after the cooldown');
        assert.strictEqual(status(id).status, 'active');
    }

    // --- busy node: no push, no state change, retried next minute --------
    {
        const id = addNode();
        nodeSetupLock.acquire(id, 'setup');
        pushes = [];
        await heal(id);
        assert.deepStrictEqual(pushes, []);
        assert.strictEqual(status(id).status, 'disabled', 'busy node keeps its state');
        nodeSetupLock.release(id);

        now += MINUTE;
        await heal(id);
        assert.deepStrictEqual(pushes, [id], 'busy node is retried without waiting for the cooldown');

        // Lock taken between the check and the push.
        const raced = addNode();
        pushBehavior = () => { throw new Error('Node is busy: setup'); };
        await heal(raced);
        assert.strictEqual(status(raced).status, 'disabled', 'busy push restores the previous status');
        assert.strictEqual(status(raced).enabled, false, 'busy push restores the previous flag');
        pushBehavior = () => true;
        now += MINUTE;
        await heal(raced);
        assert.strictEqual(status(raced).status, 'active');
    }

    // --- node without SSH cannot write an Xray log ------------------------
    {
        const id = addNode({ ssh: { privateKey: '', password: '' } });
        pushes = [];
        await heal(id);
        assert.deepStrictEqual(pushes, [], 'agent-only node is never pushed');
        assert.strictEqual(status(id).status, 'error');
        assert.strictEqual(status(id).enabled, false);
        assert.match(status(id).lastError, /SSH/);
    }

    // --- global switch turned off: enabled node is disabled --------------
    {
        const id = addNode();
        await heal(id);
        assert.strictEqual(status(id).status, 'active');
        settings = { accessLogs: { enabled: false } };
        now += 11 * MINUTE;
        pushes = [];
        await heal(id);
        assert.deepStrictEqual(pushes, [id]);
        assert.strictEqual(status(id).enabled, false);
        assert.strictEqual(status(id).status, 'disabled');
        assert.strictEqual(status(id).ingestTokenHash, '', 'token is revoked');
        settings = { accessLogs: { enabled: true, nodeScope: 'all', nodeIds: [] } };
    }

    // --- non-Xray nodes are ignored ---------------------------------------
    {
        const id = addNode({ type: 'hysteria' });
        pushes = [];
        await heal(id);
        assert.deepStrictEqual(pushes, []);
    }

    console.log('access logs heal tests passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        Date.now = realNow;
        Module._load = originalLoad;
    });
