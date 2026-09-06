const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
const requestedScopes = [];

const db = new Map();
const updates = [];
let invalidateCount = 0;
let runtimeStopCalls = [];
let runtimeStartCalls = [];
let xraySyncCalls = [];
let runtimeStopResult = { success: true, attempted: true, service: 'xray', active: false };
let runtimeStartResult = { success: true, attempted: true, service: 'hysteria-server', active: true };
let xraySyncResult = true;

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function applySet(target, values) {
    const copy = clone(target);
    for (const [key, value] of Object.entries(values || {})) {
        const parts = key.split('.');
        let ref = copy;
        while (parts.length > 1) {
            const part = parts.shift();
            ref[part] = ref[part] || {};
            ref = ref[part];
        }
        ref[parts[0]] = value;
    }
    return copy;
}

const HyNode = {
    findById: async (id) => clone(db.get(id) || null),
    // Used by the CDN-dependency guard on disable; mirrors the Mongoose chain.
    find: (filter) => ({
        select: () => ({
            lean: async () => [...db.values()].filter(node => node.type === 'cdn'
                && String(node.cdn?.originNode || '') === String(filter?.['cdn.originNode'] || '')).map(clone),
        }),
    }),
    findByIdAndUpdate: async (id, update, options) => {
        updates.push({ method: 'findByIdAndUpdate', id, update: clone(update), options });
        const node = db.get(id);
        if (!node) return null;
        const next = applySet(node, update.$set || {});
        db.set(id, next);
        return clone(options?.new ? next : node);
    },
    updateOne: async (filter, update) => {
        const id = String(filter._id);
        updates.push({ method: 'updateOne', filter: clone(filter), update: clone(update) });
        const node = db.get(id);
        if (!node) return { matchedCount: 0, modifiedCount: 0 };
        db.set(id, applySet(node, update.$set || {}));
        return { matchedCount: 1, modifiedCount: 1 };
    },
};

const stubs = {
    '../models/hyNodeModel': HyNode,
    '../models/hyUserModel': {},
    '../models/serverGroupModel': {},
    '../services/cryptoService': {},
    '../services/nodeSetup': {
        stopNodeRuntime: async (node) => {
            runtimeStopCalls.push(clone(node));
            return clone(runtimeStopResult);
        },
        startNodeRuntime: async (node) => {
            runtimeStartCalls.push(clone(node));
            return clone(runtimeStartResult);
        },
    },
    '../services/syncService': {
        updateNodeConfig: async (node) => {
            xraySyncCalls.push(clone(node));
            return xraySyncResult;
        },
        schedulePush: () => {
            throw new Error('schedulePush must not be called by active toggles');
        },
        maybePushCdnOrigins: () => {},
    },
    '../utils/logger': {
        info: () => {},
        warn: () => {},
        error: () => {},
    },
    '../middleware/auth': {
        requireScope: (scope) => {
            requestedScopes.push(scope);
            return (_req, _res, next) => next();
        },
    },
    '../utils/helpers': {
        invalidateNodesCache: async () => {
            invalidateCount += 1;
        },
    },
};

Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) {
        return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
};

const router = require('../src/routes/nodes');
Module._load = originalLoad;

function findRoute(path) {
    const layer = router.stack.find(item => item.route?.path === path && item.route?.methods?.post);
    assert(layer, `POST ${path} route exists`);
    return layer.route.stack.map(item => item.handle);
}

async function runRoute(path, id) {
    const handlers = findRoute(path);
    const req = { params: { id } };
    const res = {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };

    let index = 0;
    const next = async () => {
        const handler = handlers[index++];
        if (handler) {
            await handler(req, res, next);
        }
    };
    await next();
    return res;
}

function reset() {
    db.clear();
    updates.length = 0;
    invalidateCount = 0;
    runtimeStopCalls = [];
    runtimeStartCalls = [];
    xraySyncCalls = [];
    runtimeStopResult = { success: true, attempted: true, service: 'xray', active: false };
    runtimeStartResult = { success: true, attempted: true, service: 'hysteria-server', active: true };
    xraySyncResult = true;
}

(async () => {
    assert(findRoute('/:id/enable'));
    assert(findRoute('/:id/disable'));
    assert(requestedScopes.includes('nodes:write'), 'enable/disable require nodes:write');

    reset();
    db.set('xray-1', {
        _id: 'xray-1',
        name: 'Xray Alpha',
        type: 'xray',
        active: true,
        status: 'online',
        onlineUsers: 7,
        ssh: { password: 'encrypted' },
    });
    runtimeStopResult = { success: false, attempted: true, service: 'xray', active: true, error: 'ssh failed' };
    let res = await runRoute('/:id/disable', 'xray-1');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.warning, 'ssh failed');
    assert.strictEqual(res.body.runtime.service, 'xray');
    assert.strictEqual(runtimeStopCalls.length, 1);
    assert.strictEqual(db.get('xray-1').active, false);
    assert.strictEqual(db.get('xray-1').status, 'offline');
    assert.strictEqual(db.get('xray-1').onlineUsers, 0);
    assert.strictEqual(invalidateCount, 1);

    reset();
    db.set('hysteria-1', {
        _id: 'hysteria-1',
        name: 'Hysteria Alpha',
        type: 'hysteria',
        active: false,
        status: 'offline',
        onlineUsers: 0,
        ssh: { privateKey: 'encrypted' },
    });
    runtimeStartResult = { success: true, attempted: true, service: 'hysteria-server', active: true };
    res = await runRoute('/:id/enable', 'hysteria-1');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.node.active, true);
    assert.strictEqual(res.body.node.status, 'online');
    assert.strictEqual(runtimeStartCalls.length, 1);
    assert.strictEqual(db.get('hysteria-1').active, true);
    assert.strictEqual(db.get('hysteria-1').lastError, '');
    assert.strictEqual(invalidateCount, 1);

    reset();
    db.set('xray-agent-1', {
        _id: 'xray-agent-1',
        name: 'Xray Agent',
        type: 'xray',
        active: false,
        status: 'offline',
        onlineUsers: 0,
        xray: { agentToken: 'token' },
        ssh: { password: 'encrypted' },
    });
    xraySyncResult = true;
    res = await runRoute('/:id/enable', 'xray-agent-1');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(xraySyncCalls.length, 1);
    assert.strictEqual(runtimeStartCalls.length, 0);
    assert.strictEqual(db.get('xray-agent-1').active, true);
    assert.strictEqual(db.get('xray-agent-1').status, 'online');

    reset();
    db.set('xray-agent-2', {
        _id: 'xray-agent-2',
        name: 'Xray Agent Failed',
        type: 'xray',
        active: false,
        status: 'error',
        onlineUsers: 3,
        xray: { agentToken: 'token' },
    });
    xraySyncResult = false;
    res = await runRoute('/:id/enable', 'xray-agent-2');
    assert.strictEqual(res.statusCode, 500);
    assert.match(res.body.error, /startup/i);
    assert.strictEqual(db.get('xray-agent-2').active, false);
    assert.strictEqual(db.get('xray-agent-2').status, 'offline');
    assert.strictEqual(db.get('xray-agent-2').onlineUsers, 0);
    assert.match(db.get('xray-agent-2').lastError, /startup/i);
    assert.strictEqual(invalidateCount, 1);

    reset();
    db.set('virtual-1', {
        _id: 'virtual-1',
        name: 'Virtual Alpha',
        type: 'virtual',
        active: false,
        status: 'offline',
        onlineUsers: 0,
    });
    res = await runRoute('/:id/enable', 'virtual-1');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(runtimeStartCalls.length, 0);
    assert.strictEqual(xraySyncCalls.length, 0);
    assert.strictEqual(db.get('virtual-1').active, true);

    res = await runRoute('/:id/disable', 'virtual-1');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(runtimeStopCalls.length, 0);
    assert.strictEqual(db.get('virtual-1').active, false);
    assert.strictEqual(db.get('virtual-1').status, 'offline');

    // Disabling an origin would drop its CDN fronts from every subscription.
    reset();
    db.set('xray-origin', {
        _id: 'xray-origin',
        name: 'Xray Origin',
        type: 'xray',
        active: true,
        status: 'online',
        onlineUsers: 0,
        xray: { transport: 'xhttp', security: 'tls', xhttpPath: '/api' },
        ssh: { password: 'encrypted' },
    });
    db.set('cdn-front', {
        _id: 'cdn-front',
        name: 'CDN Front',
        type: 'cdn',
        active: true,
        cdn: { originNode: 'xray-origin', path: '/api/events.php', security: 'tls' },
    });
    res = await runRoute('/:id/disable', 'xray-origin');
    assert.strictEqual(res.statusCode, 409);
    assert.match(res.body.error, /CDN node "CDN Front"/);
    assert.strictEqual(db.get('xray-origin').active, true);
    assert.strictEqual(runtimeStopCalls.length, 0);

    reset();
    res = await runRoute('/:id/enable', 'missing-node');
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'Node not found' });
    assert.strictEqual(invalidateCount, 0);

    console.log('node active API tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
