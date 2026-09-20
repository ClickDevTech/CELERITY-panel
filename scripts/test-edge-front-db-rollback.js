'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
let persisted = null;
let invalidations = 0;

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeDocument(initial) {
    const doc = clone(initial);
    doc.toObject = function toObject() {
        const plain = { ...this };
        delete plain.toObject;
        delete plain.save;
        return clone(plain);
    };
    doc.save = async function save() {
        persisted = this.toObject();
        return this;
    };
    return doc;
}

let document = null;
const HyNode = {
    findById() {
        return {
            select() {
                return Promise.resolve(document);
            },
        };
    },
    async updateOne(filter, update) {
        if (!persisted) persisted = document.toObject();
        for (const [path, value] of Object.entries(update.$set || {})) {
            const parts = path.split('.');
            let target = persisted;
            for (const part of parts.slice(0, -1)) target = target[part] ||= {};
            target[parts.at(-1)] = clone(value);
        }
        for (const path of Object.keys(update.$unset || {})) {
            const parts = path.split('.');
            let target = persisted;
            for (const part of parts.slice(0, -1)) target = target?.[part];
            if (target) delete target[parts.at(-1)];
        }
        return { acknowledged: true };
    },
};

Module._load = function patchedLoad(request, parent, isMain) {
    const parentFile = String(parent?.filename || '').replace(/\\/g, '/');
    if (parentFile.endsWith('/src/services/edgeFront/provisionService.js')) {
        if (request === '../../models/hyNodeModel') return HyNode;
        if (request === '../../utils/helpers') {
            return { invalidateNodesCache: async () => { invalidations++; } };
        }
        if (request === '../../utils/logger') {
            return { info() {}, warn() {}, error() {} };
        }
        if (request === '../nodeSetup') return {};
    }
    return originalLoad.call(this, request, parent, isMain);
};

async function run() {
    try {
        delete require.cache[require.resolve('../src/services/edgeFront/provisionService')];
        const {
            buildDesiredState,
            prepareFrontForSync,
            promotePendingFront,
            rollbackFrontDatabaseState,
        } =
            require('../src/services/edgeFront/provisionService');

        const previous = {
            ip: '203.0.113.10',
            port: 6443,
            domain: 'node.example.com',
            status: 'online',
            lastError: '',
            xray: {
                listen: '0.0.0.0',
                transport: 'xhttp',
                security: 'tls',
                xhttpPath: '/old',
                front: {
                    enabled: false,
                    publicPort: 443,
                    inboundIds: [],
                    appliedFingerprint: '',
                    status: 'disabled',
                },
            },
        };
        document = makeDocument({
            _id: 'node-1',
            type: 'xray',
            ip: '203.0.113.20',
            port: 8443,
            domain: 'node.example.com',
            status: 'syncing',
            lastError: '',
            xray: {
                listen: '127.0.0.1',
                transport: 'xhttp',
                security: 'none',
                manualKey: 'CURRENT-SECRET',
                xhttpPath: '/new',
                front: {
                    enabled: true,
                    publicPort: 443,
                    inboundIds: ['main'],
                    appliedFingerprint: '',
                    status: 'pending',
                    rollbackSnapshot: previous,
                },
            },
        });
        persisted = null;
        invalidations = 0;

        assert.strictEqual(
            await rollbackFrontDatabaseState('node-1', 'injected Caddy failure'),
            true
        );
        assert.strictEqual(persisted.ip, '203.0.113.10');
        assert.strictEqual(persisted.port, 6443);
        assert.strictEqual(persisted.status, 'online');
        assert.strictEqual(persisted.xray.listen, '0.0.0.0');
        assert.strictEqual(persisted.xray.security, 'tls');
        assert.strictEqual(persisted.xray.xhttpPath, '/old');
        assert.strictEqual(persisted.xray.manualKey, 'CURRENT-SECRET',
            'a secret omitted from a REST/MCP snapshot survives rollback');
        assert.strictEqual(persisted.xray.front.enabled, false);
        assert.strictEqual(persisted.xray.front.status, 'error');
        assert.strictEqual(persisted.xray.front.lastError, 'injected Caddy failure');
        assert.ok(!persisted.xray.front.rollbackSnapshot);
        assert.strictEqual(invalidations, 1, 'subscription caches are invalidated after rollback');

        const previousActive = {
            ip: '203.0.113.10',
            port: 8443,
            domain: 'node.example.com',
            status: 'online',
            lastError: '',
            xray: {
                listen: '127.0.0.1',
                transport: 'xhttp',
                security: 'none',
                xhttpPath: '/old-active',
                front: {
                    enabled: true,
                    publicPort: 443,
                    inboundIds: ['main'],
                    appliedFingerprint: 'old-release',
                    status: 'active',
                },
            },
        };
        document = makeDocument({
            _id: 'node-1',
            type: 'xray',
            ip: '203.0.113.10',
            port: 8443,
            domain: 'node.example.com',
            status: 'syncing',
            xray: {
                listen: '127.0.0.1',
                transport: 'xhttp',
                security: 'none',
                xhttpPath: '/new-pending',
                front: {
                    enabled: true,
                    publicPort: 443,
                    inboundIds: ['main'],
                    appliedFingerprint: 'old-release',
                    status: 'pending',
                    rollbackSnapshot: previousActive,
                },
            },
        });
        persisted = null;

        await rollbackFrontDatabaseState('node-1', 'replacement failed');
        assert.strictEqual(persisted.xray.xhttpPath, '/old-active');
        assert.strictEqual(persisted.xray.front.enabled, true);
        assert.strictEqual(persisted.xray.front.status, 'active');
        assert.strictEqual(persisted.xray.front.appliedFingerprint, 'old-release');
        assert.strictEqual(persisted.xray.front.lastError, 'replacement failed');

        const unchanged = {
            _id: 'node-1',
            type: 'xray',
            name: 'unchanged-front',
            ip: '203.0.113.10',
            domain: 'node.example.com',
            port: 8443,
            status: 'online',
            xray: {
                listen: '127.0.0.1',
                transport: 'xhttp',
                security: 'none',
                xhttpPath: '/front',
                tlsSource: 'manual',
                manualCert: 'CERT',
                manualKey: 'KEY',
                extraInbounds: [],
                front: {
                    enabled: true,
                    publicPort: 443,
                    siteMode: 'nginx',
                    inboundIds: ['main'],
                    status: 'pending',
                    appliedFingerprint: '',
                    rollbackSnapshot: previousActive,
                },
            },
        };
        unchanged.xray.front.appliedFingerprint = buildDesiredState(unchanged).fingerprint;
        document = makeDocument(unchanged);
        persisted = null;
        invalidations = 0;

        const unchangedResult = await prepareFrontForSync('node-1', { deferPublication: true });
        assert.strictEqual(unchangedResult.skipped, 'up-to-date');
        assert.strictEqual(unchangedResult.publishAfterSync, true);
        assert.strictEqual(persisted, null,
            'front remains pending while the matching Xray config is still in flight');
        assert.strictEqual(await promotePendingFront('node-1'), true);
        assert.strictEqual(persisted.xray.front.status, 'active',
            'an unchanged committed release becomes publishable again without remote work');
        assert.ok(!persisted.xray.front.rollbackSnapshot);
        assert.strictEqual(invalidations, 1,
            'subscription cache is invalidated when a pending front returns to active');

        console.log('edge front database rollback tests passed');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/services/edgeFront/provisionService')];
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
