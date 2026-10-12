/**
 * Reality Guard contract (no network, no MongoDB).
 *
 * Verifies:
 *   - dest parsing skips forms the panel cannot check (unix, bare port, private),
 *   - inbounds sharing a dest are grouped and checked once,
 *   - the failure counter, threshold, notify mode, cooldown and offline guard,
 *   - the circuit breaker discards a tick where most dests fail at once,
 *   - replacements never reuse a domain already taken by any node,
 *   - a successful rotation writes the new dest and emits the webhook,
 *   - a failed config push reverts the database to the previous dest.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

function makeTls(state) {
    return {
        connect(opts) {
            const socket = new EventEmitter();
            const behaviour = state.tls[opts.servername || opts.host] || { ok: true };
            socket.setTimeout = () => {};
            socket.destroy = () => {};
            socket.getProtocol = () => behaviour.protocol || 'TLSv1.3';
            socket.alpnProtocol = behaviour.alpn === undefined ? 'h2' : behaviour.alpn;
            state.handshakes.push(`${opts.host}:${opts.port}|${opts.servername}`);
            setImmediate(() => {
                if (behaviour.error) {
                    const err = new Error(behaviour.error);
                    err.code = behaviour.error;
                    socket.emit('error', err);
                } else {
                    socket.emit('secureConnect');
                }
            });
            return socket;
        },
    };
}

async function withStubs(state, run) {
    const originalLoad = Module._load;

    const HyNode = {
        find(query) {
            return {
                select: () => ({
                    lean: async () => (query && query.active ? state.nodes : state.allNodes || state.nodes),
                }),
            };
        },
        async findById(id) {
            return state.docs[String(id)] || null;
        },
        async updateOne(filter, update) {
            state.updates.push({ filter, update });
            return { matchedCount: 1, modifiedCount: 1 };
        },
        async bulkWrite(ops) {
            state.bulk.push(ops);
            return {};
        },
    };

    const CascadeLink = {
        find: () => ({ select: () => ({ lean: async () => state.links || [] }) }),
    };

    const sniScanner = {
        isValidIpv4: ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip),
        async scanRange() {
            state.scans++;
            return state.scanResults || [];
        },
    };

    const webhook = {
        EVENTS: {
            NODE_REALITY_DEST_DEAD: 'node.reality_dest_dead',
            NODE_REALITY_DEST_ROTATED: 'node.reality_dest_rotated',
        },
        emit(event, payload) {
            state.webhooks.push({ event, payload });
        },
    };

    const syncService = {
        async updateXrayNodeConfig(node, opts) {
            state.pushes.push({ id: String(node._id), opts });
            if (state.appliedButUnhealthy && opts.report) opts.report.applied = true;
            return state.pushResult;
        },
    };

    const cache = { async invalidateNodes() { state.cacheInvalidations++; } };
    const helpers = { async invalidateNodesCache() { state.fullInvalidations++; } };
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const tls = makeTls(state);

    Module._load = function patchedLoad(request, parent, isMain) {
        const parentFile = normalizePath(parent?.filename);
        if (parentFile.endsWith('/src/services/realityGuardService.js')) {
            if (request === 'tls') return tls;
            if (request === '../models/hyNodeModel') return HyNode;
            if (request === '../models/cascadeLinkModel') return CascadeLink;
            if (request === './sniScanner') return sniScanner;
            if (request === './webhookService') return webhook;
            if (request === './cacheService') return cache;
            if (request === './syncService') return syncService;
            if (request === '../utils/helpers') return helpers;
            if (request === '../utils/logger') return logger;
        }
        return originalLoad(request, parent, isMain);
    };

    const modulePath = require.resolve('../src/services/realityGuardService');
    try {
        delete require.cache[modulePath];
        return await run(require(modulePath));
    } finally {
        Module._load = originalLoad;
        delete require.cache[modulePath];
    }
}

function freshState(overrides = {}) {
    return {
        nodes: [],
        docs: {},
        tls: {},
        handshakes: [],
        updates: [],
        bulk: [],
        webhooks: [],
        pushes: [],
        scans: 0,
        pushResult: true,
        cacheInvalidations: 0,
        fullInvalidations: 0,
        ...overrides,
    };
}

function xrayNode(id, xray, extra = {}) {
    return {
        _id: id,
        name: `node-${id}`,
        ip: '203.0.113.10',
        type: 'xray',
        status: 'online',
        active: true,
        cascadeRole: 'standalone',
        ssh: { password: 'enc' },
        xray: { security: 'reality', realityDest: 'dead.example.com:443', realitySni: ['dead.example.com'], extraInbounds: [], ...xray },
        ...extra,
    };
}

(async () => {
    await withStubs(freshState(), async (svc) => {
        const g = svc._internals;

        // parseDest
        assert.deepStrictEqual(g.parseDest('www.example.com:443'), { host: 'www.example.com', port: 443 });
        assert.deepStrictEqual(g.parseDest('1.2.3.4:8443'), { host: '1.2.3.4', port: 8443 });
        assert.strictEqual(g.parseDest('443'), null, 'bare port is a local listener');
        assert.strictEqual(g.parseDest('/dev/shm/x.sock'), null);
        assert.strictEqual(g.parseDest('127.0.0.1:8443'), null, 'loopback is self-steal');
        assert.strictEqual(g.parseDest('10.0.0.5:443'), null);
        assert.strictEqual(g.parseDest('example.com'), null, 'port is required');
        assert.strictEqual(g.parseDest('bad host:443'), null);

        // hostname filter for certificate-derived values
        assert.ok(g.isValidHostname('cdn.example.org'));
        assert.ok(!g.isValidHostname('*.example.org'));
        assert.ok(!g.isValidHostname('1.2.3.4'));
        assert.ok(!g.isValidHostname('localhost'));
        assert.ok(!g.isValidHostname('a"b.example.com'));

        // grouping: main + extra share a dest, tls extra ignored
        const targets = g.collectRealityTargets({
            security: 'reality',
            realityDest: 'a.example.com:443',
            realitySni: ['a.example.com'],
            extraInbounds: [
                { security: 'reality', realityDest: 'a.example.com:443', realitySni: ['www.a.example.com'] },
                { security: 'tls', realityDest: 'x.example.com:443' },
                { security: 'reality', realityDest: 'b.example.com:443', realitySni: [] },
            ],
        });
        assert.strictEqual(targets.length, 2);
        assert.deepStrictEqual(targets[0].inbounds, ['main', 0]);
        assert.deepStrictEqual(targets[0].snis, ['a.example.com', 'www.a.example.com']);
        assert.deepStrictEqual(targets[1].snis, ['b.example.com'], 'empty SNI falls back to dest host');

        // mode whitelist
        assert.strictEqual(g.normalizeMode('notify'), 'notify');
        assert.strictEqual(g.normalizeMode('<script>'), 'auto');

        // breaker
        assert.ok(!g.breakerTripped(2, 1));
        assert.ok(!g.breakerTripped(10, 3));
        assert.ok(g.breakerTripped(6, 3));

        // evaluateNode state machine
        const now = Date.now();
        const fail = [{ key: 'd:443', dest: 'd:443', reason: 'cert_expired' }];
        const n = guard => ({ status: 'online', xray: { realityGuard: guard } });

        let d = g.evaluateNode(n({ status: 'failing', failCount: 2, lastError: 'x' }), [], now);
        assert.deepStrictEqual(d.set, { status: 'ok', failCount: 0, lastError: '' });

        d = g.evaluateNode(n({}), fail, now);
        assert.strictEqual(d.action, 'none');
        assert.strictEqual(d.set.status, 'failing');
        assert.strictEqual(d.set.failCount, 1);

        d = g.evaluateNode(n({ status: 'failing', failCount: 2 }), fail, now);
        assert.strictEqual(d.action, 'rotate', 'third failure rotates in auto mode');

        d = g.evaluateNode(n({ mode: 'notify', status: 'failing', failCount: 2 }), fail, now);
        assert.strictEqual(d.action, 'notify');
        assert.strictEqual(d.set.status, 'dead');

        d = g.evaluateNode(n({ mode: 'notify', status: 'dead', failCount: 5 }), fail, now);
        assert.strictEqual(d.action, 'none', 'dead state is reported once');

        d = g.evaluateNode(n({ status: 'failing', failCount: 2, lastRotatedAt: new Date(now - 60 * 1000) }), fail, now);
        assert.strictEqual(d.action, 'notify');
        assert.strictEqual(d.cause, 'cooldown');

        d = g.evaluateNode({ status: 'offline', xray: { realityGuard: { failCount: 2 } } }, fail, now);
        assert.strictEqual(d.cause, 'node_offline');

        // uniqueness
        const used = g.collectUsedDomains(
            [{ xray: { realityDest: 'taken.example.com:443', realitySni: ['sni.example.com'], extraInbounds: [{ realityDest: 'extra.example.com:443' }] } }],
            [{ realityDest: 'link.example.com:443', realitySni: ['link-sni.example.com'] }]
        );
        for (const host of ['taken.example.com', 'sni.example.com', 'extra.example.com', 'link.example.com', 'link-sni.example.com']) {
            assert.ok(used.has(host), host);
        }
        const filtered = g.filterScanResults([
            { ip: '203.0.113.20', domain: 'slow.example.com', ping: 90 },
            { ip: '203.0.113.21', domain: 'taken.example.com', ping: 5 },
            { ip: '203.0.113.22', domain: '*.wild.example.com', ping: 6 },
            { ip: '203.0.113.10', domain: 'self.example.com', ping: 1 },
            { ip: '203.0.113.23', domain: 'Fast.Example.com', ping: 10 },
        ], used, '203.0.113.10');
        assert.deepStrictEqual(filtered.map(r => r.domain), ['fast.example.com', 'slow.example.com']);

        // update builder pins the old values and reverts symmetrically
        const replacements = [{
            target: { inbounds: ['main', 1] },
            prev: { main: { dest: 'old:443', sni: ['old'] }, 1: { dest: 'old:443', sni: ['old', 'www.old'] } },
            next: { dest: 'new.example.com:443', sni: ['new.example.com'] },
        }];
        const fwd = g.buildDestUpdate('id1', replacements);
        assert.strictEqual(fwd.filter['xray.realityDest'], 'old:443');
        assert.strictEqual(fwd.set['xray.extraInbounds.1.realityDest'], 'new.example.com:443');
        const back = g.buildDestUpdate('id1', replacements, { revert: true });
        assert.strictEqual(back.filter['xray.extraInbounds.1.realityDest'], 'new.example.com:443');
        assert.deepStrictEqual(back.set['xray.extraInbounds.1.realitySni'], ['old', 'www.old']);

        assert.strictEqual(g.classifyError({ code: 'CERT_HAS_EXPIRED' }), 'cert_expired');
        assert.strictEqual(g.classifyError({ code: 'ENOTFOUND' }), 'dns');
        assert.strictEqual(g.classifyError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'cert_name');
    });

    // checkDest: TLS 1.2 and missing h2 are failures, handshakes are memoized.
    {
        const state = freshState({
            tls: {
                'old.example.com': { protocol: 'TLSv1.2' },
                'noh2.example.com': { alpn: false },
            },
        });
        await withStubs(state, async (svc) => {
            const memo = new Map();
            const t = { host: 'ok.example.com', port: 443, snis: ['ok.example.com'] };
            assert.deepStrictEqual(await svc.checkDest(t, memo), { ok: true });
            await svc.checkDest(t, memo);
            assert.strictEqual(state.handshakes.length, 1, 'memoized');
            assert.strictEqual((await svc.checkDest({ host: 'old.example.com', port: 443, snis: ['old.example.com'] })).reason, 'tls_version');
            assert.strictEqual((await svc.checkDest({ host: 'noh2.example.com', port: 443, snis: ['noh2.example.com'] })).reason, 'no_h2');
        });
    }

    // Breaker: most dests failing at once discards the tick.
    {
        const nodes = ['1', '2', '3', '4'].map(id => xrayNode(id, {
            realityDest: `d${id}.example.com:443`, realitySni: [`d${id}.example.com`],
        }));
        const state = freshState({
            nodes,
            tls: {
                'd1.example.com': { error: 'ECONNREFUSED' },
                'd2.example.com': { error: 'ECONNREFUSED' },
                'd3.example.com': { error: 'ECONNREFUSED' },
            },
        });
        await withStubs(state, async (svc) => {
            await svc.checkAll();
            assert.strictEqual(state.bulk.length, 0, 'no counters written when the breaker trips');
            assert.strictEqual(state.scans, 0);
        });
    }

    // Tick: a single failing dest increments the counter, others stay untouched.
    {
        const nodes = ['1', '2', '3'].map(id => xrayNode(id, {
            realityDest: `d${id}.example.com:443`, realitySni: [`d${id}.example.com`],
        }));
        nodes.push(xrayNode('4', { realityGuard: { mode: 'off', status: 'dead', failCount: 4 } }));
        nodes.push(xrayNode('5', {}, { cascadeRole: 'portal' }));
        const state = freshState({ nodes, tls: { 'd1.example.com': { error: 'CERT_HAS_EXPIRED' } } });
        await withStubs(state, async (svc) => {
            await svc.checkAll();
            const ops = state.bulk[0];
            const byId = new Map(ops.map(op => [String(op.updateOne.filter._id), op.updateOne.update.$set]));
            assert.strictEqual(byId.get('1')['xray.realityGuard.failCount'], 1);
            assert.strictEqual(byId.get('1')['xray.realityGuard.status'], 'failing');
            assert.ok(byId.get('2')['xray.realityGuard.lastCheckAt']);
            assert.strictEqual(byId.get('2')['xray.realityGuard.failCount'], undefined, 'unchanged state is not rewritten');
            assert.strictEqual(byId.get('4')['xray.realityGuard.status'], 'ok', 'off mode clears stale state');
            assert.ok(!byId.has('5'), 'cascade nodes are skipped');
            assert.ok(!state.handshakes.some(h => h.startsWith('dead.example.com')), 'off/cascade dests are not checked');
        });
    }

    // Rotation success.
    {
        const node = xrayNode('n1', {
            realityGuard: { status: 'failing', failCount: 2 },
            extraInbounds: [{ security: 'reality', realityDest: 'dead.example.com:443', realitySni: ['dead.example.com'] }],
        });
        const state = freshState({
            nodes: [node],
            allNodes: [node, xrayNode('other', { realityDest: 'taken.example.com:443', realitySni: ['taken.example.com'] })],
            docs: { n1: node },
            tls: { 'dead.example.com': { error: 'CERT_HAS_EXPIRED' } },
            scanResults: [
                { ip: '203.0.113.30', domain: 'taken.example.com', ping: 3 },
                { ip: '203.0.113.31', domain: 'fresh.example.com', ping: 8 },
            ],
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            assert.strictEqual(state.scans, 1);
            const destUpdate = state.updates.find(u => u.update.$set['xray.realityDest']);
            assert.ok(destUpdate, 'dest written');
            assert.strictEqual(destUpdate.filter['xray.realityDest'], 'dead.example.com:443');
            assert.strictEqual(destUpdate.update.$set['xray.realityDest'], 'fresh.example.com:443');
            assert.strictEqual(destUpdate.update.$set['xray.extraInbounds.0.realityDest'], 'fresh.example.com:443');
            assert.deepStrictEqual(destUpdate.update.$set['xray.realitySni'], ['fresh.example.com']);
            assert.strictEqual(state.pushes.length, 1);
            assert.strictEqual(state.pushes[0].opts.lockHeld, true);
            const rotated = state.webhooks.find(w => w.event === 'node.reality_dest_rotated');
            assert.ok(rotated);
            assert.strictEqual(rotated.payload.newDest, 'fresh.example.com:443');
            assert.strictEqual(rotated.payload.reason, 'cert_expired');
            assert.strictEqual(state.fullInvalidations, 1, 'subscriptions are rebuilt after rotation');
            const guard = state.updates.find(u => u.update.$set['xray.realityGuard.lastRotatedAt']);
            assert.strictEqual(guard.update.$set['xray.realityGuard.status'], 'ok');
        });
    }

    // Rotation rollback when the push fails.
    {
        const node = xrayNode('n2', { realityGuard: { status: 'failing', failCount: 2 } });
        const state = freshState({
            nodes: [node],
            docs: { n2: node },
            pushResult: false,
            tls: { 'dead.example.com': { error: 'ECONNREFUSED' } },
            scanResults: [{ ip: '203.0.113.31', domain: 'fresh.example.com', ping: 8 }],
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            const revert = state.updates.find(u => u.filter['xray.realityDest'] === 'fresh.example.com:443');
            assert.ok(revert, 'database reverted');
            assert.strictEqual(revert.update.$set['xray.realityDest'], 'dead.example.com:443');
            const dead = state.webhooks.find(w => w.event === 'node.reality_dest_dead');
            assert.strictEqual(dead.payload.cause, 'rollback');
            assert.ok(!state.webhooks.some(w => w.event === 'node.reality_dest_rotated'));
        });
    }

    // Config running but agent health unconfirmed: the new dest is kept.
    {
        const node = xrayNode('n4', { realityGuard: { status: 'failing', failCount: 2 } });
        const state = freshState({
            nodes: [node],
            docs: { n4: node },
            pushResult: false,
            appliedButUnhealthy: true,
            tls: { 'dead.example.com': { error: 'ECONNREFUSED' } },
            scanResults: [{ ip: '203.0.113.31', domain: 'fresh.example.com', ping: 8 }],
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            assert.ok(!state.updates.some(u => u.filter['xray.realityDest'] === 'fresh.example.com:443'), 'no revert');
            assert.ok(state.webhooks.some(w => w.event === 'node.reality_dest_rotated'));
            assert.ok(!state.webhooks.some(w => w.event === 'node.reality_dest_dead'));
        });
    }

    // No candidate: status recorded and reported once.
    {
        const node = xrayNode('n3', { realityGuard: { status: 'failing', failCount: 2 } });
        const state = freshState({
            nodes: [node],
            docs: { n3: node },
            tls: { 'dead.example.com': { error: 'ENOTFOUND' } },
            scanResults: [],
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            const guard = state.updates.find(u => u.update.$set['xray.realityGuard.status'] === 'no_candidate');
            assert.ok(guard);
            const dead = state.webhooks.filter(w => w.event === 'node.reality_dest_dead');
            assert.strictEqual(dead.length, 1);
            assert.strictEqual(dead[0].payload.cause, 'no_candidate');
            assert.strictEqual(state.pushes.length, 0);
        });
    }

    console.log('test-reality-guard: OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
