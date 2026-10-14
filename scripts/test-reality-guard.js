/**
 * Reality Guard contract (no network, no MongoDB, no SSH).
 *
 * Verifies:
 *   - dest parsing skips forms the panel cannot check (unix, bare port, private),
 *   - inbounds sharing a dest are grouped and checked once,
 *   - missing H2 is a warning, not a failure,
 *   - the failure counter, threshold, notify mode, cooldown and offline guard,
 *   - the panel never declares a dest dead alone: the node confirms it first,
 *     and a dest the node reaches is left alone for NODE_CONFIRM_TTL_MS,
 *   - the node check script only carries validated values and its output is
 *     classified correctly,
 *   - the circuit breaker discards a tick where most dests fail at once,
 *   - portal nodes are guarded, bridge and relay nodes are not,
 *   - replacements come from the reserve list first, then from the /24 scan,
 *     never reuse a domain already taken by any node and never edit the list,
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

/**
 * Filtered openssl output the node script would print for one pair.
 * Behaviour: { error: 'connect'|'tls'|'dns', exit, verify, alpn }.
 */
function opensslOutput(b) {
    if (b.exit === 124) return '';
    if (b.error === 'connect') return 'connect:errno=111';
    if (b.error === 'dns') return 'BIO_lookup_ex:system lib\nName or service not known';
    if (b.error === 'tls') return 'New, (NONE), Cipher is (NONE)';
    return [
        'New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384',
        `Verify return code: ${b.verify ?? 0} (x)`,
        b.alpn === false ? 'No ALPN negotiated' : 'ALPN protocol: h2',
    ].join('\n');
}

function makeNodeSSH(state) {
    return class FakeNodeSSH {
        constructor(node) {
            this.node = node;
        }

        async connect() {
            state.sshSessions++;
            if (state.sshConnectError) throw new Error('ssh down');
        }

        async exec(script) {
            state.nodeScripts.push(script);
            if (state.noOpenssl) return { code: 0, stdout: '@@RG_NO_OPENSSL\n', stderr: '' };
            let out = '';
            for (const m of script.matchAll(/^rg_check (\d+) '([^']+)' '([^']+)' (\w+) &$/gm)) {
                const [, id, connect, sni] = m;
                const b = state.nodeTls[sni] || {};
                state.nodeChecks.push(`${connect}|${sni}`);
                out += `@@RG ${id} ${b.exit ?? 0}\n${opensslOutput(b)}\n@@RG_END\n`;
            }
            return { code: 0, stdout: out, stderr: '' };
        }

        disconnect() {
            state.sshClosed++;
        }
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
    const NodeSSH = makeNodeSSH(state);

    Module._load = function patchedLoad(request, parent, isMain) {
        const parentFile = normalizePath(parent?.filename);
        if (parentFile.endsWith('/src/services/realityGuardService.js')) {
            if (request === 'tls') return tls;
            if (request === '../models/hyNodeModel') return HyNode;
            if (request === '../models/cascadeLinkModel') return CascadeLink;
            if (request === './nodeSSH') return NodeSSH;
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
        nodeTls: {},
        handshakes: [],
        nodeScripts: [],
        nodeChecks: [],
        sshSessions: 0,
        sshClosed: 0,
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

function guardSets(state) {
    return state.updates.map(u => u.update.$set).filter(Boolean);
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

        // reserve list normalization
        assert.deepStrictEqual(
            svc.normalizeReserveSnis(' WWW.Example.com\nwww.example.com, 1.2.3.4; bad host\ncdn.example.org:443\n*.wild.example.com\nlast.example.net.'),
            ['www.example.com', 'cdn.example.org', 'last.example.net']
        );
        const many = Array.from({ length: 30 }, (_, i) => `s${i}.example.com`);
        assert.strictEqual(svc.normalizeReserveSnis(many).length, svc.MAX_RESERVE_SNIS);
        assert.deepStrictEqual(svc.normalizeReserveSnis(undefined), []);

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

        // guarded roles
        assert.ok(g.isGuardedXray({ type: 'xray' }));
        assert.ok(g.isGuardedXray({ type: 'xray', cascadeRole: 'standalone' }));
        assert.ok(g.isGuardedXray({ type: 'xray', cascadeRole: 'portal' }));
        assert.ok(!g.isGuardedXray({ type: 'xray', cascadeRole: 'bridge' }));
        assert.ok(!g.isGuardedXray({ type: 'xray', cascadeRole: 'relay' }));
        assert.ok(!g.isGuardedXray({ type: 'hysteria' }));

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
        assert.strictEqual(d.action, 'confirm', 'third failure asks the node');
        assert.strictEqual(d.set.status, undefined, 'status is decided after the node check');

        d = g.evaluateNode(n({ mode: 'notify', status: 'failing', failCount: 2 }), fail, now);
        assert.strictEqual(d.action, 'confirm', 'notify mode is confirmed too, so no false alert is sent');

        d = g.evaluateNode(n({ mode: 'notify', status: 'dead', failCount: 5 }), fail, now);
        assert.strictEqual(d.action, 'none', 'dead state is reported once');

        d = g.evaluateNode(n({ status: 'no_candidate', failCount: 5 }), fail, now);
        assert.strictEqual(d.action, 'confirm', 'auto mode keeps retrying a reported node');

        d = g.evaluateNode(n({ status: 'dead', failCount: 5, lastRotatedAt: new Date(now - 60 * 1000) }), fail, now);
        assert.strictEqual(d.action, 'none', 'no retries during the cooldown');

        d = g.evaluateNode({ status: 'offline', xray: { realityGuard: { failCount: 2 } } }, fail, now);
        assert.strictEqual(d.action, 'notify');
        assert.strictEqual(d.cause, 'node_offline');

        d = g.evaluateNode(n({ status: 'ok', failCount: 0, nodeConfirmedAt: new Date(now - 60 * 1000) }), fail, now);
        assert.strictEqual(d.action, 'none', 'node confirmed recently: not counted');
        assert.strictEqual(d.set.failCount, undefined);
        assert.strictEqual(d.set.lastError, 'd:443: panel_unreachable');

        d = g.evaluateNode(n({ failCount: 2, nodeConfirmedAt: new Date(now - g.NODE_CONFIRM_TTL_MS - 1000) }), fail, now);
        assert.strictEqual(d.action, 'confirm', 'expired confirmation counts again');

        // decideAfterConfirm
        assert.strictEqual(g.decideAfterConfirm(n({ status: 'failing' }), now).action, 'rotate');
        d = g.decideAfterConfirm(n({ mode: 'notify', status: 'failing' }), now);
        assert.strictEqual(d.action, 'notify');
        assert.strictEqual(d.set.status, 'dead');
        d = g.decideAfterConfirm(n({ status: 'failing', lastRotatedAt: new Date(now - 60 * 1000) }), now);
        assert.strictEqual(d.cause, 'cooldown');
        assert.strictEqual(g.decideAfterConfirm(n({ mode: 'notify', status: 'dead' }), now).action, 'none');

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

        // reserve candidates: list order, used and recently failed domains skipped
        const reserveGuard = {
            reserveSnis: ['taken.example.com', 'recent.example.com', 'old.example.com', 'ok.example.com'],
            reserveFailed: [
                { domain: 'recent.example.com', at: new Date(now - 60 * 1000), reason: 'timeout' },
                { domain: 'old.example.com', at: new Date(now - g.RESERVE_FAIL_SKIP_MS - 1000), reason: 'timeout' },
                { domain: 'gone.example.com', at: new Date(now - 60 * 1000), reason: 'dns' },
            ],
        };
        assert.deepStrictEqual(g.pickReserveCandidates(reserveGuard, used, now), ['old.example.com', 'ok.example.com']);
        const mergedFailed = g.mergeReserveFailed(reserveGuard, new Map([
            ['old.example.com', { ok: true }],
            ['ok.example.com', { ok: false, reason: 'cert_name' }],
        ]), now);
        assert.deepStrictEqual(mergedFailed.map(f => f.domain).sort(), ['ok.example.com', 'recent.example.com'],
            'passed, expired and removed domains are dropped');

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

        // node check script: only validated values reach the shell
        const script = g.buildNodeCheckScript([
            { host: 'ok.example.com', port: 443, sni: 'ok.example.com' },
            { host: 'evil.example.com', port: 443, sni: "x'; rm -rf / #.example.com" },
            { host: '$(reboot).example.com', port: 443, sni: 'a.example.com' },
            { host: 'ok.example.com', port: 70000, sni: 'ok.example.com' },
            { host: '2001:db8::1', port: 443, sni: 'v6.example.com' },
            { host: '198.51.100.7', port: 443, sni: '198.51.100.7' },
        ]);
        assert.ok(script.startsWith("command -v openssl >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1"),
            'both tools are required before any check runs');
        assert.ok(script.includes("rg_check 0 'ok.example.com:443' 'ok.example.com' host &"));
        assert.ok(script.includes("rg_check 4 '[2001:db8::1]:443' 'v6.example.com' host &"));
        assert.ok(script.includes("rg_check 5 '198.51.100.7:443' '198.51.100.7' ip &"));
        assert.ok(!script.includes('rm -rf') && !script.includes('reboot') && !script.includes('70000'));
        assert.strictEqual(g.buildNodeCheckScript([{ host: 'a b', port: 443, sni: 'x' }]), null);

        // node check output classification
        assert.deepStrictEqual(g.classifyNodeCheck(0, opensslOutput({})), { ok: true });
        assert.deepStrictEqual(g.classifyNodeCheck(0, opensslOutput({ alpn: false })), { ok: true, warn: 'no_h2' });
        assert.strictEqual(g.classifyNodeCheck(0, opensslOutput({ verify: 62 })).reason, 'cert_name');
        assert.strictEqual(g.classifyNodeCheck(0, opensslOutput({ verify: 10 })).reason, 'cert_expired');
        assert.strictEqual(g.classifyNodeCheck(0, opensslOutput({ verify: 20 })).reason, 'cert_invalid');
        assert.strictEqual(g.classifyNodeCheck(124, '').reason, 'timeout');
        assert.strictEqual(g.classifyNodeCheck(1, opensslOutput({ error: 'connect' })).reason, 'connect');
        assert.strictEqual(g.classifyNodeCheck(1, opensslOutput({ error: 'dns' })).reason, 'dns');
        assert.strictEqual(g.classifyNodeCheck(1, opensslOutput({ error: 'tls' })).reason, 'tls');
        assert.strictEqual(g.classifyNodeCheck(0, 'Protocol  : TLSv1.3\nVerify return code: 0 (ok)\nALPN protocol: h2').ok, true);
        assert.strictEqual(g.parseNodeCheckOutput('@@RG_NO_OPENSSL\n'), null, 'no openssl on the node');
        assert.strictEqual(g.parseNodeCheckOutput('@@RG 0 127\nsh: timeout: not found\n@@RG_END\n'), null,
            'exit 127 means the check never ran');
        assert.strictEqual(g.parseNodeCheckOutput('@@RG 0 1\ns_client: Unknown option: -tls1_3\ns_client: Use -help for summary.\n@@RG_END\n'), null,
            'openssl without TLS 1.3 options cannot check');
        const parsedOut = g.parseNodeCheckOutput(`@@RG 1 0\n${opensslOutput({ verify: 62 })}\n@@RG_END\n@@RG 0 0\n${opensslOutput({})}\n@@RG_END\n`);
        assert.deepStrictEqual(parsedOut.get(0), { ok: true });
        assert.strictEqual(parsedOut.get(1).reason, 'cert_name');
    });

    // checkDest: TLS 1.2 fails, missing h2 is a warning, handshakes are memoized.
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
            assert.deepStrictEqual(
                await svc.checkDest({ host: 'noh2.example.com', port: 443, snis: ['noh2.example.com'] }),
                { ok: true, warnings: [{ sni: 'noh2.example.com', warn: 'no_h2' }] }
            );
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
            assert.strictEqual(state.sshSessions, 0);
        });
    }

    // Tick: a single failing dest increments the counter, others stay untouched;
    // portal is guarded, bridge/relay are not; the h2 warning is recorded.
    {
        const nodes = ['1', '2', '3'].map(id => xrayNode(id, {
            realityDest: `d${id}.example.com:443`, realitySni: [`d${id}.example.com`],
        }));
        nodes.push(xrayNode('4', { realityGuard: { mode: 'off', status: 'dead', failCount: 4 } }));
        nodes.push(xrayNode('5', { realityDest: 'd5.example.com:443', realitySni: ['d5.example.com'] }, { cascadeRole: 'portal' }));
        nodes.push(xrayNode('6', {}, { cascadeRole: 'bridge' }));
        nodes.push(xrayNode('7', {}, { cascadeRole: 'relay' }));
        const state = freshState({
            nodes,
            tls: { 'd1.example.com': { error: 'CERT_HAS_EXPIRED' }, 'd5.example.com': { alpn: false } },
        });
        await withStubs(state, async (svc) => {
            await svc.checkAll();
            const ops = state.bulk[0];
            const byId = new Map(ops.map(op => [String(op.updateOne.filter._id), op.updateOne.update.$set]));
            assert.strictEqual(byId.get('1')['xray.realityGuard.failCount'], 1);
            assert.strictEqual(byId.get('1')['xray.realityGuard.status'], 'failing');
            assert.ok(byId.get('2')['xray.realityGuard.lastCheckAt']);
            assert.strictEqual(byId.get('2')['xray.realityGuard.failCount'], undefined, 'unchanged state is not rewritten');
            assert.strictEqual(byId.get('2')['xray.realityGuard.warning'], undefined, 'no warning, nothing written');
            assert.strictEqual(byId.get('4')['xray.realityGuard.status'], 'ok', 'off mode clears stale state');
            assert.ok(byId.has('5'), 'portal nodes are guarded');
            assert.strictEqual(byId.get('5')['xray.realityGuard.warning'], 'd5.example.com: no_h2');
            assert.strictEqual(byId.get('5')['xray.realityGuard.failCount'], undefined, 'missing h2 is not a failure');
            assert.ok(!byId.has('6') && !byId.has('7'), 'bridge and relay nodes are skipped');
            assert.ok(!state.handshakes.some(h => h.startsWith('dead.example.com')), 'off/bridge/relay dests are not checked');
            assert.strictEqual(state.sshSessions, 0, 'no SSH below the threshold');
        });
    }

    // Node reaches the dest: no rotation, no alert, confirmation stored.
    {
        const node = xrayNode('c1', { realityGuard: { status: 'failing', failCount: 2 } });
        const state = freshState({
            nodes: [node],
            docs: { c1: node },
            tls: { 'dead.example.com': { error: 'ECONNREFUSED' } },
            nodeTls: { 'dead.example.com': { alpn: false } },
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            assert.strictEqual(state.sshSessions, 1);
            assert.strictEqual(state.sshClosed, 1, 'session closed');
            assert.strictEqual(state.nodeScripts.length, 1, 'one exec per incident');
            assert.strictEqual(state.scans, 0);
            assert.strictEqual(state.pushes.length, 0);
            assert.strictEqual(state.webhooks.length, 0);
            const set = guardSets(state).find(s => s['xray.realityGuard.nodeConfirmedAt']);
            assert.ok(set, 'confirmation stored');
            assert.strictEqual(set['xray.realityGuard.status'], 'ok');
            assert.strictEqual(set['xray.realityGuard.failCount'], 0);
            assert.strictEqual(set['xray.realityGuard.lastError'], 'dead.example.com:443: panel_unreachable');
            assert.strictEqual(set['xray.realityGuard.warning'], 'dead.example.com: no_h2');
        });
    }

    // Within the confirmation TTL the panel failure is not counted and no SSH is opened.
    {
        const node = xrayNode('c2', { realityGuard: { status: 'ok', failCount: 0, nodeConfirmedAt: new Date() } });
        const state = freshState({
            nodes: [node],
            docs: { c2: node },
            tls: { 'dead.example.com': { error: 'ECONNREFUSED' } },
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            const $set = state.bulk[0][0].updateOne.update.$set;
            assert.strictEqual($set['xray.realityGuard.failCount'], undefined);
            assert.strictEqual($set['xray.realityGuard.lastError'], 'dead.example.com:443: panel_unreachable');
            assert.strictEqual(state.sshSessions, 0);
        });
    }

    // Notify mode: the alert is sent only after the node confirmed the failure.
    {
        const node = xrayNode('m1', { realityGuard: { mode: 'notify', status: 'failing', failCount: 2 } });
        const state = freshState({
            nodes: [node],
            docs: { m1: node },
            tls: { 'dead.example.com': { error: 'ECONNREFUSED' } },
            nodeTls: { 'dead.example.com': { verify: 62 } },
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            const dead = state.webhooks.filter(w => w.event === 'node.reality_dest_dead');
            assert.strictEqual(dead.length, 1);
            assert.strictEqual(dead[0].payload.cause, 'notify_mode');
            assert.strictEqual(dead[0].payload.reason, 'cert_name', 'the node verdict is reported');
            assert.strictEqual(state.scans, 0);
            assert.ok(guardSets(state).some(s => s['xray.realityGuard.status'] === 'dead'));
        });
    }

    // Rotation success via the /24 scan; candidates verified from the node.
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
            nodeTls: { 'dead.example.com': { verify: 10 } },
            scanResults: [
                { ip: '203.0.113.30', domain: 'taken.example.com', ping: 3 },
                { ip: '203.0.113.31', domain: 'fresh.example.com', ping: 8 },
            ],
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            assert.strictEqual(state.scans, 1);
            assert.strictEqual(state.sshSessions, 1, 'confirmation and candidate checks share one session');
            assert.ok(state.nodeChecks.includes('fresh.example.com:443|fresh.example.com'), 'candidate verified from the node');
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
            assert.strictEqual(guard.update.$set['xray.realityGuard.nodeConfirmedAt'], null);
        });
    }

    // Reserve list first: used, recently failed and node-rejected entries are
    // skipped, the list itself is never written, no scan is needed.
    {
        const now = Date.now();
        const node = xrayNode('r1', {
            realityGuard: {
                status: 'failing',
                failCount: 2,
                reserveSnis: ['taken.example.com', 'skip.example.com', 'bad.example.com', 'good.example.com', 'good2.example.com'],
                reserveFailed: [{ domain: 'skip.example.com', at: new Date(now - 60 * 1000), reason: 'timeout' }],
            },
        });
        const state = freshState({
            nodes: [node],
            allNodes: [node, xrayNode('other', { realityDest: 'taken.example.com:443', realitySni: ['taken.example.com'] })],
            docs: { r1: node },
            tls: { 'dead.example.com': { error: 'ECONNREFUSED' } },
            nodeTls: { 'dead.example.com': { error: 'connect' }, 'bad.example.com': { verify: 62 } },
            scanResults: [{ ip: '203.0.113.31', domain: 'fresh.example.com', ping: 8 }],
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick(now);
            assert.strictEqual(state.scans, 0, 'no scan when the reserve list has a working address');
            assert.ok(!state.nodeChecks.some(c => c.includes('taken.example.com')), 'used domain not checked');
            assert.ok(!state.nodeChecks.some(c => c.includes('skip.example.com')), 'recently failed domain not checked');
            const destUpdate = state.updates.find(u => u.update.$set['xray.realityDest']);
            assert.strictEqual(destUpdate.update.$set['xray.realityDest'], 'good.example.com:443', 'first working entry wins');
            assert.ok(!guardSets(state).some(s => 'xray.realityGuard.reserveSnis' in s), 'the reserve list is never written');
            const guard = guardSets(state).find(s => s['xray.realityGuard.lastRotatedAt']);
            const failedDomains = guard['xray.realityGuard.reserveFailed'].map(f => f.domain).sort();
            assert.deepStrictEqual(failedDomains, ['bad.example.com', 'skip.example.com']);
            assert.strictEqual(guard['xray.realityGuard.reserveFailed'].find(f => f.domain === 'bad.example.com').reason, 'cert_name');
        });
    }

    // Reserve list exhausted: the /24 scan is the fallback.
    {
        const node = xrayNode('r2', {
            realityGuard: { status: 'failing', failCount: 2, reserveSnis: ['bad.example.com'] },
        });
        const state = freshState({
            nodes: [node],
            docs: { r2: node },
            tls: { 'dead.example.com': { error: 'ECONNREFUSED' } },
            nodeTls: { 'dead.example.com': { error: 'connect' }, 'bad.example.com': { error: 'connect' } },
            scanResults: [{ ip: '203.0.113.31', domain: 'fresh.example.com', ping: 8 }],
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            assert.strictEqual(state.scans, 1);
            const destUpdate = state.updates.find(u => u.update.$set['xray.realityDest']);
            assert.strictEqual(destUpdate.update.$set['xray.realityDest'], 'fresh.example.com:443');
        });
    }

    // No openssl on the node: the panel verdict is used and noted.
    {
        const node = xrayNode('o1', { realityGuard: { status: 'failing', failCount: 2 } });
        const state = freshState({
            nodes: [node],
            docs: { o1: node },
            noOpenssl: true,
            tls: { 'dead.example.com': { error: 'ECONNREFUSED' } },
            scanResults: [{ ip: '203.0.113.31', domain: 'fresh.example.com', ping: 8 }],
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            assert.ok(guardSets(state).some(s => String(s['xray.realityGuard.lastError'] || '').includes('node_check_unavailable')));
            const destUpdate = state.updates.find(u => u.update.$set['xray.realityDest']);
            assert.strictEqual(destUpdate.update.$set['xray.realityDest'], 'fresh.example.com:443', 'candidates checked from the panel');
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
            nodeTls: { 'dead.example.com': { error: 'connect' } },
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
            nodeTls: { 'dead.example.com': { error: 'connect' } },
            scanResults: [{ ip: '203.0.113.31', domain: 'fresh.example.com', ping: 8 }],
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            assert.ok(!state.updates.some(u => u.filter['xray.realityDest'] === 'fresh.example.com:443'), 'no revert');
            assert.ok(state.webhooks.some(w => w.event === 'node.reality_dest_rotated'));
            assert.ok(!state.webhooks.some(w => w.event === 'node.reality_dest_dead'));
        });
    }

    // No candidate: status recorded, reported once with the rejected candidates,
    // and a reported node is retried no more than once per interval.
    {
        const node = xrayNode('n3', { realityGuard: { status: 'failing', failCount: 2, reserveSnis: ['bad.example.com'] } });
        const state = freshState({
            nodes: [node],
            docs: { n3: node },
            tls: { 'dead.example.com': { error: 'ENOTFOUND' } },
            nodeTls: { 'dead.example.com': { error: 'dns' }, 'bad.example.com': { verify: 62 } },
            scanResults: [],
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            const guard = state.updates.find(u => u.update.$set['xray.realityGuard.status'] === 'no_candidate');
            assert.ok(guard);
            const dead = state.webhooks.filter(w => w.event === 'node.reality_dest_dead');
            assert.strictEqual(dead.length, 1);
            assert.strictEqual(dead[0].payload.cause, 'no_candidate');
            assert.deepStrictEqual(dead[0].payload.candidates, [{ domain: 'bad.example.com', reason: 'cert_name' }]);
            assert.strictEqual(state.pushes.length, 0);

            node.xray.realityGuard = { ...node.xray.realityGuard, status: 'no_candidate', failCount: 3 };
            await svc._internals.tick();
            assert.strictEqual(state.sshSessions, 1, 'retry waits for the interval');
        });
    }

    // A crashed attempt is retried no sooner than the interval, even while
    // the node is still only "failing".
    {
        const node = xrayNode('n5', { realityGuard: { status: 'failing', failCount: 2 } });
        const state = freshState({
            nodes: [node],
            docs: { n5: node },
            tls: { 'dead.example.com': { error: 'ECONNREFUSED' } },
        });
        await withStubs(state, async (svc) => {
            const g = svc._internals;
            const now = Date.now();
            g._lastAttemptAt.set('n5', now - 60 * 1000);
            await g.tick(now);
            assert.strictEqual(state.sshSessions, 0, 'recent attempt is not retried');

            g._lastAttemptAt.set('n5', now - g.RETRY_INTERVAL_MS - 1000);
            await g.tick(now);
            assert.strictEqual(state.sshSessions, 1, 'retried once the interval has passed');
        });
    }

    // No SSH credentials: the panel verdict stands and the node is reported.
    {
        const node = xrayNode('s1', { realityGuard: { status: 'failing', failCount: 2 } }, { ssh: {} });
        const state = freshState({
            nodes: [node],
            docs: { s1: node },
            tls: { 'dead.example.com': { error: 'ECONNREFUSED' } },
        });
        await withStubs(state, async (svc) => {
            await svc._internals.tick();
            assert.strictEqual(state.sshSessions, 0);
            const dead = state.webhooks.filter(w => w.event === 'node.reality_dest_dead');
            assert.strictEqual(dead.length, 1);
            assert.strictEqual(dead[0].payload.cause, 'no_ssh');
        });
    }

    console.log('test-reality-guard: OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
