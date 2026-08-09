/**
 * Shape of the panel history endpoint (real Express, stubbed models).
 *
 * The history view is the only place an operator can ask "what actually
 * happened from this vantage point", so the contract it hands the browser is
 * worth pinning down.
 *
 * Verifies:
 *   - windows land on a fixed time grid and a silent stretch stays a hole
 *     instead of closing ranks,
 *   - every measured field survives the trip, including the failure taxonomy,
 *   - speed measurements ignore windows that carry none, so a round-robin
 *     sample is not averaged into the floor,
 *   - nodes come back worst first,
 *   - a read that hits the document limit says so and starts the axis where
 *     the data actually begins.
 */

const assert = require('assert');
const http = require('http');
const Module = require('module');

const DOC_LIMIT = 6000;

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

function get(port, path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) { /* non-JSON body */ }
                resolve({ status: res.statusCode, body: parsed, raw: data });
            });
        }).on('error', reject);
    });
}

function codes(overrides = {}) {
    return {
        netUnreachable: 0,
        handshakeFailed: 0,
        authRejected: 0,
        tunnelNoData: 0,
        degraded: 0,
        coreDown: 0,
        ...overrides,
    };
}

function query(rows) {
    // Mirrors the model statics: newest first, capped, handed back oldest first.
    const chain = {
        select() { return chain; },
        lean() { return Promise.resolve(rows); },
        sort() { return chain; },
        limit() { return chain; },
    };
    return chain;
}

async function withRoute(state, run) {
    const originalLoad = Module._load;

    const ProbeResult = {
        async getHistory() { return state.transport; },
    };
    const ProbeTargetResult = {
        async getHistory() { return state.targets; },
    };
    const HyNode = {
        find() { return query(state.nodes); },
        countDocuments() { return Promise.resolve(state.nodes.length); },
    };
    const Probe = {
        countDocuments() { return Promise.resolve(1); },
        listProbes() { return Promise.resolve([]); },
    };

    const manifestService = {
        INBOUND_MAIN: 'main',
        INBOUND_HYSTERIA: 'hysteria',
        INBOUND_GROUP: 'group',
        describeNodeInbounds(node) {
            return (state.inboundsByNode[String(node._id)] || []);
        },
    };

    const helpers = {
        async getSettings() { return state.settings; },
    };

    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    Module._load = function patchedLoad(request_, parent, isMain) {
        const parentFile = normalizePath(parent?.filename);
        if (parentFile.endsWith('/src/routes/panel/probes.js')) {
            if (request_ === './helpers') return { render() {} };
            if (request_ === '../../utils/logger') return logger;
            if (request_ === '../../models/probeModel') return Probe;
            if (request_ === '../../models/hyNodeModel') return HyNode;
            if (request_ === '../../models/probeResultModel') return ProbeResult;
            if (request_ === '../../models/probeTargetResultModel') return ProbeTargetResult;
            if (request_ === '../../services/probes/enrollService') return {};
            if (request_ === '../../services/probes/manifestService') return manifestService;
            if (request_ === '../../utils/helpers') return helpers;
        }
        return originalLoad(request_, parent, isMain);
    };

    let server;
    try {
        delete require.cache[require.resolve('../src/routes/panel/probes')];
        const router = require('../src/routes/panel/probes');

        const express = require('express');
        const app = express();
        app.use('/panel', router);

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        return await run(server.address().port);
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/routes/panel/probes')];
    }
}

const PROBE_ID = '65b0000000000000000000a1';
const NODE_A = '65b0000000000000000000b1';
const NODE_B = '65b0000000000000000000b2';

(async () => {
    const now = Date.now();
    const step = 900000;
    const slots = 24;
    const gridStart = now - slots * step;
    // Half a slot in, so the few milliseconds between this clock read and the
    // one inside the route cannot move a row into a neighbouring segment.
    const at = (index) => new Date(gridStart + index * step + step / 2);

    const state = {
        settings: {
            probes: {
                enabled: true,
                reportIntervalSec: 900,
                speedTest: { enabled: true },
                targets: [{ id: 'openai', url: 'https://chat.openai.com', label: 'OpenAI' }],
            },
        },
        nodes: [
            { _id: NODE_A, name: 'Amsterdam', type: 'xray', flag: '🇳🇱' },
            { _id: NODE_B, name: 'Berlin', type: 'xray', flag: '🇩🇪' },
        ],
        inboundsByNode: {
            [NODE_A]: [{ inboundId: 'main', label: 'Reality', protocol: 'vless', port: 443, security: 'reality', transport: 'tcp' }],
            [NODE_B]: [{ inboundId: 'main', label: '', protocol: 'vless', port: 8443, security: 'reality', transport: 'tcp' }],
        },
        transport: [
            // Healthy node, one throughput sample and one window with none.
            {
                nodeId: NODE_A, inboundId: 'main', inboundTag: 'vless-in', ts: at(0),
                attempts: 3, ok: 3, codes: codes(),
                latencyP50: 80, latencyP95: 120, handshakeMs: 40, ttfbMs: 90,
                speedBps: 0, speedSamples: 0, exitIp: '203.0.113.7', lastCode: '',
            },
            {
                nodeId: NODE_A, inboundId: 'main', inboundTag: 'vless-in', ts: at(2),
                attempts: 3, ok: 3, codes: codes(),
                latencyP50: 100, latencyP95: 140, handshakeMs: 50, ttfbMs: 110,
                speedBps: 12500000, speedBpsMax: 12500000, speedSamples: 1,
                exitIp: '203.0.113.7', lastCode: '',
            },
            {
                nodeId: NODE_A, inboundId: 'main', inboundTag: 'vless-in', ts: at(23),
                attempts: 3, ok: 3, codes: codes(),
                latencyP50: 90, latencyP95: 130, handshakeMs: 45, ttfbMs: 100,
                speedBps: 25000000, speedBpsMax: 30000000, speedSamples: 1, speedCapped: true,
                exitIp: '203.0.113.7', lastCode: '',
            },
            // Broken node: refused credentials, which is a sync problem.
            {
                nodeId: NODE_B, inboundId: 'main', inboundTag: 'vless-in', ts: at(1),
                attempts: 4, ok: 0, codes: codes({ authRejected: 4 }),
                latencyP50: 0, latencyP95: 0, handshakeMs: 0, ttfbMs: 0,
                speedBps: 0, speedSamples: 0, exitIp: '', lastCode: 'auth_rejected',
            },
        ],
        targets: [
            {
                nodeId: NODE_A, targetId: 'openai', ts: at(2),
                attempts: 1, ok: 0, blocked: 1, httpStatus: 403,
                latencyMs: 300, lastError: 'blocked with status 403',
            },
        ],
    };

    await withRoute(state, async (port) => {
        const bad = await get(port, '/panel/probes/api/not-an-id/history?hours=6');
        assert.strictEqual(bad.status, 400, 'a malformed probe id never reaches a query');

        const res = await get(port, `/panel/probes/api/${PROBE_ID}/history?hours=6`);
        assert.strictEqual(res.status, 200, 'the history is served');

        const data = res.body;

        // ── Grid ─────────────────────────────────────────────────────────
        assert.strictEqual(data.bucket, 'raw', 'six hours is served from shipped windows');
        assert.strictEqual(data.stepMs, step, 'the slot matches the report interval');
        assert.strictEqual(data.slots, slots, 'the range is divided into whole slots');
        assert.strictEqual(data.truncated, false, 'a small read is not truncated');

        const amsterdam = data.nodes.find((n) => n.nodeId === NODE_A);
        const berlin = data.nodes.find((n) => n.nodeId === NODE_B);
        assert.ok(amsterdam && berlin, 'both nodes are present');

        const inbound = amsterdam.inbounds[0];
        assert.strictEqual(inbound.points.length, slots, 'the series spans the whole grid');
        assert.ok(inbound.points[0], 'the first reported window is placed');
        assert.strictEqual(inbound.points[1], null, 'a slot with no report stays a hole');
        assert.ok(inbound.points[2], 'the window after the hole keeps its own slot');
        assert.ok(inbound.points[23], 'the most recent window sits at the end of the grid');

        // ── Measured fields ──────────────────────────────────────────────
        assert.strictEqual(inbound.label, 'Reality', 'the inbound is named the way the manifest names it');
        assert.strictEqual(inbound.protocol, 'vless', 'the protocol survives');
        assert.strictEqual(inbound.port, 443, 'the port survives');
        assert.strictEqual(inbound.points[0].handshakeMs, 40, 'handshake timing reaches the client');
        assert.strictEqual(inbound.points[0].ttfbMs, 90, 'time to first byte reaches the client');
        assert.strictEqual(inbound.points[0].exitIp, '203.0.113.7', 'the exit address reaches the client');
        assert.strictEqual(inbound.latencyP95, 140, 'p95 over the range is the worst window');
        assert.strictEqual(inbound.uptimePct, 100, 'a fully healthy series reports 100%');

        const brokenInbound = berlin.inbounds[0];
        assert.strictEqual(brokenInbound.worstCode, 'auth_rejected', 'the dominant code names the cause');
        assert.strictEqual(brokenInbound.points[1].code, 'auth_rejected', 'the window carries its own verdict');
        assert.strictEqual(brokenInbound.points[1].codes.authRejected, 4, 'the taxonomy counters survive');
        assert.strictEqual(brokenInbound.uptimePct, 0, 'a series that never connected reports 0%');

        // ── Ordering ─────────────────────────────────────────────────────
        assert.strictEqual(data.nodes[0].nodeId, NODE_B, 'the broken node is listed first');

        // ── Summary ──────────────────────────────────────────────────────
        assert.strictEqual(data.summary.attempts, 13, 'attempts are summed across every series');
        assert.strictEqual(data.summary.ok, 9, 'successes are summed across every series');
        assert.strictEqual(data.summary.codes.authRejected, 4, 'the breakdown is aggregated');
        assert.strictEqual(data.summary.nodesTotal, 2, 'every node with data is counted');
        assert.strictEqual(data.summary.nodesFailing, 1, 'only the failing node counts as failing');
        assert.strictEqual(data.summary.targetsBlocked, 1, 'a blocked resource is counted');
        // Four of the twenty-four slots carry a report; the rest is silence.
        assert.strictEqual(data.summary.gapSlots, slots - 4, 'uncovered slots are reported as missing data');
        assert.strictEqual(data.summary.gapMs, (slots - 4) * step, 'the gap is expressed in real time');

        // ── Resources ────────────────────────────────────────────────────
        const target = amsterdam.targets[0];
        assert.strictEqual(target.url, 'https://chat.openai.com', 'the checked URL is resolved from settings');
        assert.strictEqual(target.label, 'OpenAI', 'the resource label is resolved from settings');
        assert.strictEqual(target.blocked, 1, 'blocks are counted');
        assert.strictEqual(target.lastError, 'blocked with status 403', 'the recorded error reaches the client');
        assert.strictEqual(target.points[2].httpStatus, 403, 'the status is kept per window');

        // ── Speed ────────────────────────────────────────────────────────
        assert.strictEqual(data.speedTestEnabled, true, 'the client is told whether measuring is on');
        assert.strictEqual(data.speed.length, 1, 'only series with measurements appear');

        const speed = data.speed[0];
        assert.strictEqual(speed.samples, 2, 'samples are summed');
        assert.strictEqual(speed.maxBps, 30000000, 'the peak comes from the recorded maximum');
        // Windows without a measurement are excluded: folded in, the median of
        // 12.5 and 25 Mbyte/s would collapse towards zero.
        assert.strictEqual(speed.medianBps, 18750000, 'the median ignores windows with no measurement');
        assert.strictEqual(speed.points.length, 2, 'each measurement is kept at its own timestamp');

        // A run that ended on the size cap says nothing about the ceiling, so
        // the flag has to reach the client or the number reads as a fact.
        assert.strictEqual(speed.capped, true, 'a capped measurement marks the series as a lower bound');
        assert.deepStrictEqual(
            speed.points.map((p) => !!p.capped),
            [false, true],
            'the flag stays with the measurement it belongs to'
        );

        // The headline number is the median of every reading, not the best one.
        assert.strictEqual(data.summary.speedBps, 18750000, 'the summary reports the typical speed');
        assert.strictEqual(data.summary.speedBpsMax, 30000000, 'the peak is kept beside it');
        assert.strictEqual(data.summary.speedCapped, true, 'the summary inherits the lower-bound mark');
    });

    // ── Truncated read ───────────────────────────────────────────────────
    // A fleet large enough to overflow the limit must lose the far end of the
    // range, and the axis has to start where the surviving data does.
    const oldest = new Date(now - 60 * 60 * 1000);
    const overflow = {
        ...state,
        targets: [],
        transport: Array.from({ length: DOC_LIMIT }, (_, i) => ({
            nodeId: NODE_A,
            inboundId: 'main',
            inboundTag: 'vless-in',
            ts: new Date(oldest.getTime() + i),
            attempts: 1,
            ok: 1,
            codes: codes(),
            latencyP50: 50,
            latencyP95: 60,
            handshakeMs: 0,
            ttfbMs: 0,
            speedBps: 0,
            speedSamples: 0,
            exitIp: '',
            lastCode: '',
        })),
    };

    await withRoute(overflow, async (port) => {
        const res = await get(port, `/panel/probes/api/${PROBE_ID}/history?hours=6`);
        assert.strictEqual(res.status, 200, 'an overflowing read still answers');
        assert.strictEqual(res.body.truncated, true, 'the client is told the range is incomplete');
        assert.ok(
            new Date(res.body.since).getTime() >= oldest.getTime() - res.body.stepMs,
            'the axis starts at the oldest surviving window, not at the requested range'
        );
    });

    console.log('test-probe-history: OK');
})().catch((e) => {
    console.error('test-probe-history FAILED:', e);
    process.exit(1);
});
