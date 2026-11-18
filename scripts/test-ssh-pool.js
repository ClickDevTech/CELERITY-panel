/**
 * SSH pool endpoint checks (no network).
 *
 * Verifies:
 *   - a pooled connection is reused while the node still points at the same
 *     host, port, user and credentials, including partial projections,
 *   - changing the IP or the key drops the pooled connection and reconnects
 *     to the new endpoint,
 *   - an IP change during a pending handshake starts a new handshake to the
 *     new host, and the stale handshake is neither pooled nor retried.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

const clients = [];

class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.config = null;
        this.ended = false;
        this._sock = { writable: false };
        clients.push(this);
    }

    connect(config) {
        this.config = config;
    }

    ready() {
        this._sock.writable = true;
        this.emit('ready');
    }

    end() {
        if (this.ended) return;
        this.ended = true;
        this._sock.writable = false;
        setImmediate(() => this.emit('close'));
    }
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (normalizePath(parent?.filename).endsWith('/src/services/sshPoolService.js')) {
        if (request === 'ssh2') return { Client: FakeClient };
        if (request === '../utils/logger') return quietLogger;
        if (request === './cryptoService') return { decryptSafe: v => v, decryptPrivateKey: v => v };
    }
    return originalLoad(request, parent, isMain);
};

const pool = require('../src/services/sshPoolService');
pool.settingsLoaded = true;
pool.config.maxRetries = 1;

function node(overrides = {}) {
    return {
        _id: 'n1',
        name: 'node-1',
        ip: '203.0.113.10',
        ssh: { port: 22, username: 'root', privateKey: 'enc-key-1', password: '' },
        ...overrides,
    };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
    try {
        // Same endpoint: one handshake, reused afterwards.
        const first = pool.getConnection(node());
        assert.strictEqual(clients.length, 1);
        clients[0].ready();
        const c1 = await first;
        assert.strictEqual(await pool.getConnection(node()), c1, 'same endpoint reuses the connection');
        assert.strictEqual(clients.length, 1);

        // Partial projection (no ip/ssh fields loaded) is not a change.
        assert.strictEqual(await pool.getConnection({ _id: 'n1', name: 'node-1' }), c1,
            'missing fields are not compared');
        assert.strictEqual(await pool.getConnection({ _id: 'n1', ip: '203.0.113.10' }), c1);
        assert.strictEqual(clients.length, 1);

        // IP change: the old connection is dropped, the new host is used.
        const moved = pool.getConnection(node({ ip: '198.51.100.7' }));
        assert.strictEqual(clients.length, 2, 'IP change opens a new connection');
        assert.strictEqual(clients[0].ended, true, 'old connection is closed');
        assert.strictEqual(clients[1].config.host, '198.51.100.7');
        clients[1].ready();
        const c2 = await moved;
        await tick();
        assert.strictEqual(await pool.getConnection(node({ ip: '198.51.100.7' })), c2,
            'late close of the old connection does not evict the new one');

        // Key change on the same host reconnects too.
        const rekeyed = pool.getConnection(node({
            ip: '198.51.100.7',
            ssh: { port: 22, username: 'root', privateKey: 'enc-key-2', password: '' },
        }));
        assert.strictEqual(clients.length, 3, 'credential change opens a new connection');
        assert.strictEqual(clients[2].config.privateKey, 'enc-key-2');
        clients[2].ready();
        await rekeyed;

        // Port and user changes are endpoint changes as well.
        const portChanged = pool.getConnection(node({
            ip: '198.51.100.7',
            ssh: { port: 2222, username: 'root', privateKey: 'enc-key-2', password: '' },
        }));
        assert.strictEqual(clients.length, 4);
        assert.strictEqual(clients[3].config.port, 2222);
        clients[3].ready();
        await portChanged;

        // IP change during a pending handshake.
        pool.closeAll();
        const pendingOld = pool.getConnection(node({ _id: 'n2' }));
        const oldClient = clients[clients.length - 1];
        const joined = pool.getConnection(node({ _id: 'n2' }));
        assert.strictEqual(clients[clients.length - 1], oldClient, 'same endpoint joins the pending handshake');
        const pendingNew = pool.getConnection(node({ _id: 'n2', ip: '192.0.2.44' }));
        const newClient = clients[clients.length - 1];
        assert.notStrictEqual(newClient, oldClient, 'new handshake for the new host');
        assert.strictEqual(newClient.config.host, '192.0.2.44');
        assert.strictEqual(oldClient.ended, true, 'stale handshake is aborted');

        // The stale handshake completing late must not take over the pool slot.
        oldClient.ready();
        await pendingOld.catch(() => {});
        await joined.catch(() => {});
        newClient.ready();
        const fresh = await pendingNew;
        assert.strictEqual(pool.connections.get('n2').client, fresh);
        assert.strictEqual(pool.connections.get('n2').endpoint.host, '192.0.2.44');

        // A superseded attempt that errors must not retry with the old endpoint.
        pool.closeAll();
        const before = clients.length;
        const staleAttempt = pool.getConnection(node({ _id: 'n3' }));
        const staleClient = clients[clients.length - 1];
        const current = pool.getConnection(node({ _id: 'n3', ip: '192.0.2.99' }));
        const currentClient = clients[clients.length - 1];
        staleClient.emit('error', new Error('connection reset'));
        await assert.rejects(staleAttempt, /connection reset/);
        await new Promise(resolve => setTimeout(resolve, 600));
        assert.strictEqual(clients.length, before + 2, 'no retry for a superseded attempt');
        currentClient.ready();
        await current;
        assert.strictEqual(pool.connections.get('n3').endpoint.host, '192.0.2.99');

        console.log('test-ssh-pool: OK');
    } finally {
        pool.closeAll();
        Module._load = originalLoad;
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
