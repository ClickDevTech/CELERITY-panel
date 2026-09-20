'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
const updates = [];
const sshCommands = [];
let scenario = {};

const emptyQuery = {
    populate: async () => [],
    then(resolve) { return Promise.resolve(resolve([])); },
};

const HyNode = {
    updateOne: async (filter, update) => {
        updates.push({ filter, update });
        return { acknowledged: true };
    },
    findById: async () => null,
    findOneAndUpdate: async () => null,
};

class FakeSSH {
    async connect() {}
    disconnect() {}
    async uploadContent() {
        scenario.uploads = (scenario.uploads || 0) + 1;
    }
    async exec(command) {
        sshCommands.push(command);
        if (command.includes('run -test')) return { code: 0, stdout: '' };
        if (command === 'systemctl restart xray' && scenario.restartFails) {
            return { code: 1, stderr: 'injected restart failure' };
        }
        if (command.includes('config.json.prev') && command.includes('systemctl restart xray')) {
            scenario.xrayRollback = true;
        }
        return { code: 0, stdout: '' };
    }
}

const front = {
    async prepareFrontForSync() {
        if (scenario.preflightFails) {
            scenario.dbRollback = true;
            return { error: 'injected validation failure' };
        }
        if (scenario.unchangedFront) {
            return { skipped: 'up-to-date', publishAfterSync: true };
        }
        return scenario.frontEnabled
            ? { prepared: { requestId: 'prepared' } }
            : { skipped: 'disabled' };
    },
    async activateFrontForSync() {
        scenario.activated = true;
        if (scenario.activationFails) scenario.dbRollback = true;
        return scenario.activationFails
            ? { error: 'injected Caddy restart/smoke failure' }
            : { changed: true };
    },
    async discardPreparedFront() {
        scenario.discarded = true;
    },
    async setFrontSuspended(node, suspended) {
        scenario.suspends = [...(scenario.suspends || []), suspended];
    },
    async completeFrontDisable() {
        scenario.disableCompleted = true;
        if (scenario.disableFails) throw new Error('injected disable failure');
    },
    async rollbackFrontDatabaseState() {
        scenario.dbRollback = true;
    },
    async clearFrontRollbackState() {
        scenario.dbRollbackCleared = true;
    },
    async promotePendingFront() {
        scenario.frontPromoted = true;
        return true;
    },
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
        };
    }
    return originalLoad(request, parent, isMain);
};

function node(frontEnabled = true) {
    return {
        _id: `fault-${Math.random()}`,
        name: 'fault-test',
        ip: '127.0.0.1',
        type: 'xray',
        active: true,
        port: frontEnabled ? 8443 : 443,
        ssh: { password: 'test' },
        xray: {
            listen: frontEnabled ? '127.0.0.1' : '0.0.0.0',
            transport: 'xhttp',
            security: frontEnabled ? 'none' : 'tls',
            tlsSource: 'manual',
            manualCert: 'CERT',
            manualKey: 'KEY',
            inboundTag: 'vless-in',
            extraInbounds: [],
            front: {
                enabled: frontEnabled,
                appliedFingerprint: frontEnabled ? '' : 'active-front',
            },
        },
    };
}

async function run() {
    try {
        delete require.cache[require.resolve('../src/services/syncService')];
        const sync = require('../src/services/syncService');
        sync._getUsersForNode = async () => [];
        sync.checkXrayAgentHealth = async () => ({ online: true });

        scenario = { frontEnabled: true, preflightFails: true };
        assert.strictEqual(await sync.updateXrayNodeConfig(node()), false);
        assert.strictEqual(scenario.uploads || 0, 0, 'validation failure must precede Xray upload');
        assert.strictEqual(scenario.dbRollback, true, 'preflight failure restores MongoDB state');

        scenario = { frontEnabled: true, restartFails: true };
        assert.strictEqual(await sync.updateXrayNodeConfig(node()), false);
        assert.strictEqual(scenario.xrayRollback, true, 'Xray restart failure restores config.json.prev');
        assert.strictEqual(scenario.discarded, true, 'failed cutover discards only its staged release');
        assert.strictEqual(scenario.dbRollback, true, 'Xray restart failure restores MongoDB state');

        scenario = { frontEnabled: true, activationFails: true };
        assert.strictEqual(await sync.updateXrayNodeConfig(node()), false);
        assert.strictEqual(scenario.activated, true);
        assert.strictEqual(scenario.xrayRollback, true, 'Caddy restart/smoke failure restores public Xray');
        assert.strictEqual(scenario.dbRollback, true, 'Caddy failure restores MongoDB state');

        scenario = { frontEnabled: true, unchangedFront: true };
        assert.strictEqual(await sync.updateXrayNodeConfig(node()), true);
        assert.strictEqual(scenario.frontPromoted, true,
            'an unchanged Caddy release is published only after Xray restart succeeds');

        scenario = { frontEnabled: false, disableFails: true };
        assert.strictEqual(await sync.updateXrayNodeConfig(node(false)), false);
        assert.deepStrictEqual(scenario.suspends, [true, false],
            'disable failure resumes the previous Caddy after restoring Xray');
        assert.strictEqual(scenario.xrayRollback, true);
        assert.strictEqual(scenario.dbRollback, true, 'disable failure restores MongoDB state');

        console.log('edge front cutover fault tests passed');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/services/syncService')];
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
