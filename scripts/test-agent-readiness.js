'use strict';

const assert = require('assert');
const Module = require('module');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const originalLoad = Module._load;
const sshCommands = [];
let reloads = 0;

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
    async exec(command) {
        sshCommands.push(command);
        return { code: 0, stdout: '' };
    }
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
            reloadCcAgent: async () => { reloads++; },
        };
    }
    return originalLoad(request, parent, isMain);
};

function networkError(code) {
    const error = new Error(`connect ${code} 127.0.0.1:62080`);
    error.code = code;
    return error;
}

function node({ withSsh = true } = {}) {
    return {
        _id: `agent-${Math.random()}`,
        name: 'agent-test',
        ip: '127.0.0.1',
        type: 'xray',
        active: true,
        port: 443,
        ssh: withSsh ? { password: 'test' } : {},
        xray: {
            agentToken: 'token',
            inboundTag: 'vless-in',
            extraInbounds: [],
            front: { enabled: false },
        },
    };
}

async function run() {
    try {
        delete require.cache[require.resolve('../src/services/syncService')];
        const sync = require('../src/services/syncService');
        sync._getUsersForNode = async () => [];
        sync.checkXrayAgentHealth = async () => ({ online: true });

        let calls = [];
        let script = [];
        sync._agentRequest = async (_node, method, path) => {
            calls.push(`${method} ${path}`);
            const step = script.shift();
            if (step instanceof Error) throw step;
            return { status: 200, data: {} };
        };

        // A refused port right after the agent restart is waited out, then
        // POST /restart is sent exactly once.
        calls = [];
        script = [networkError('ECONNREFUSED'), networkError('ECONNREFUSED')];
        reloads = 0;
        const report = {};
        assert.strictEqual(await sync.updateXrayNodeConfig(node(), { report }), true);
        assert.strictEqual(reloads, 1);
        assert.deepStrictEqual(calls.slice(0, 4), [
            'GET /health', 'GET /health', 'GET /health', 'POST /restart',
        ]);
        assert.strictEqual(calls.filter(c => c === 'POST /restart').length, 1);
        assert.strictEqual(report.error, undefined);

        // HTTP-level failures (bad token) are not retried.
        calls = [];
        script = [new Error('[Agent] Unauthorized — check agentToken for node agent-test')];
        await assert.rejects(sync._waitForAgentReady(node()), /Unauthorized/);
        assert.deepStrictEqual(calls, ['GET /health']);

        // An agent that never comes up fails with an explicit reason.
        calls = [];
        script = Array.from({ length: 50 }, () => networkError('ECONNREFUSED'));
        await assert.rejects(
            sync._waitForAgentReady(node(), { budgetMs: 400 }),
            error => error.code === 'AGENT_NOT_READY' && /not reachable within/.test(error.message)
        );
        assert.ok(calls.length >= 2 && calls.every(c => c === 'GET /health'));

        // When readiness fails, the sync reports why and never sends /restart.
        const originalWait = sync._waitForAgentReady;
        const originalDiagnose = sync._diagnoseAgentPort;
        try {
            sync._waitForAgentReady = async () => {
                const error = new Error('cc-agent not reachable within 8s (ECONNREFUSED)');
                error.code = 'AGENT_NOT_READY';
                throw error;
            };
            sync._diagnoseAgentPort = async () => 'cc-agent is not listening on port 62080 on the node';
            calls = [];
            script = [];
            const failed = {};
            assert.strictEqual(await sync.updateXrayNodeConfig(node(), { report: failed }), false);
            assert.ok(!calls.includes('POST /restart'));
            assert.match(failed.error, /^Xray restart failed: cc-agent not reachable within 8s/);
            assert.match(failed.error, /not listening on port 62080/);
        } finally {
            sync._waitForAgentReady = originalWait;
            sync._diagnoseAgentPort = originalDiagnose;
        }

        // Without an agent reload (no SSH upload) the probe is skipped.
        calls = [];
        script = [];
        reloads = 0;
        assert.strictEqual(await sync.updateXrayNodeConfig(node({ withSsh: false })), true);
        assert.strictEqual(reloads, 0);
        assert.ok(!calls.includes('GET /health'));
        assert.strictEqual(calls[0], 'POST /restart');

        // The port diagnosis distinguishes a dead agent from a blocked port.
        sshCommands.length = 0;
        FakeSSH.prototype.exec = async function exec(command) {
            sshCommands.push(command);
            return { code: 0, stdout: 'LISTEN 0 4096 *:62080 *:*\n' };
        };
        assert.match(await sync._diagnoseAgentPort(node()), /listening on the node but unreachable/);
        assert.ok(sshCommands[0].includes('sport = :62080'));
        FakeSSH.prototype.exec = async function exec(command) {
            sshCommands.push(command);
            return { code: 0, stdout: '' };
        };
        assert.match(await sync._diagnoseAgentPort(node()), /not listening on port 62080/);
        assert.strictEqual(await sync._diagnoseAgentPort(node({ withSsh: false })), '');

        console.log('agent readiness tests passed');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/services/syncService')];
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
