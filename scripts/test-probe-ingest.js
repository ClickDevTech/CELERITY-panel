/**
 * Panel-side probe ingest contract (no HTTP, no MongoDB).
 *
 * Verifies:
 *   - gzipped NDJSON is inflated and parsed, malformed lines are skipped
 *     instead of rejecting the whole batch,
 *   - transport and target windows are upserted by their natural key, which is
 *     what makes at-least-once redelivery harmless,
 *   - failure codes are normalized into the fixed taxonomy,
 *   - records for unknown nodes are dropped rather than stored,
 *   - a probe sitting on a node address is flagged, since such a vantage point
 *     proves nothing about that node,
 *   - a reported transition emits the alerting webhook.
 */

const assert = require('assert');
const zlib = require('zlib');
const Module = require('module');

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

async function withStubs(state, run) {
    const originalLoad = Module._load;

    const Probe = {
        updates: state.probeUpdates,
        async updateOne(filter, update) {
            state.probeUpdates.push(update);
            return { acknowledged: true };
        },
    };

    const HyNode = {
        find() {
            state.nodeQueries++;
            return {
                select() {
                    return { lean: async () => state.nodes };
                },
            };
        },
    };

    const HyUser = {
        findById() {
            return { select: () => ({ lean: async () => ({ traffic: { tx: 100, rx: 200 } }) }) };
        },
    };

    const ProbeResult = {
        async bulkUpsertWindows(ops) {
            state.transportCalls++;
            state.transport.push(...ops);
            return ops.length;
        },
    };

    const ProbeTargetResult = {
        async bulkUpsertWindows(ops) {
            state.targetCalls++;
            state.targets.push(...ops);
            return ops.length;
        },
    };

    const Settings = {
        async updateOne() {},
    };

    const webhook = {
        EVENTS: {
            PROBE_OFFLINE: 'probe.offline',
            PROBE_NODE_UNREACHABLE: 'probe.node_unreachable',
            PROBE_TARGET_UNREACHABLE: 'probe.target_unreachable',
        },
        emit(event, payload) {
            state.webhooks.push({ event, payload });
        },
    };

    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    Module._load = function patchedLoad(request, parent, isMain) {
        const parentFile = normalizePath(parent?.filename);
        if (parentFile.endsWith('/src/services/probes/ingestService.js')) {
            if (request === '../../models/probeModel') return Probe;
            if (request === '../../models/hyNodeModel') return HyNode;
            if (request === '../../models/hyUserModel') return HyUser;
            if (request === '../../models/probeResultModel') return ProbeResult;
            if (request === '../../models/probeTargetResultModel') return ProbeTargetResult;
            if (request === '../../models/settingsModel') return Settings;
            if (request === '../webhookService') return webhook;
            if (request === '../../utils/logger') return logger;
        }
        return originalLoad(request, parent, isMain);
    };

    try {
        delete require.cache[require.resolve('../src/services/probes/ingestService')];
        const ingestService = require('../src/services/probes/ingestService');
        return await run(ingestService);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/services/probes/ingestService')];
    }
}

(async () => {
    const state = {
        nodes: [{ _id: 'node-1', ip: '10.0.0.1', name: 'Node One' }],
        transport: [],
        targets: [],
        webhooks: [],
        probeUpdates: [],
        transportCalls: 0,
        targetCalls: 0,
        nodeQueries: 0,
    };

    await withStubs(state, async (ingestService) => {
        const now = new Date().toISOString();

        const lines = [
            JSON.stringify({
                kind: 'transport',
                nodeId: 'node-1',
                inboundId: 'main',
                inboundTag: 'vless-in',
                ts: now,
                attempts: 4,
                ok: 3,
                codes: { handshakeFailed: 1, bogusCode: 99, netUnreachable: -5 },
                latencyP50: 120,
                latencyP95: 400,
                speedBps: 9_000_000,
                speedSamples: 2,
                speedCapped: true,
                lastCode: 'handshake_failed',
            }),
            'this line is not json',
            JSON.stringify({
                kind: 'target',
                nodeId: 'node-1',
                targetId: 'openai',
                ts: now,
                attempts: 1,
                ok: 0,
                blocked: 1,
                httpStatus: 403,
            }),
            JSON.stringify({
                kind: 'transport',
                nodeId: 'unknown-node',
                inboundId: 'main',
                ts: now,
                attempts: 1,
                ok: 1,
            }),
            JSON.stringify({
                kind: 'event',
                event: 'node_unreachable',
                nodeId: 'node-1',
                inboundId: 'main',
                code: 'auth_rejected',
                message: 'user not found',
            }),
            JSON.stringify({
                kind: 'meta',
                version: '1.0.0',
                egressIp: '10.0.0.1',
                country: 'RU',
                asn: 'AS12345',
            }),
        ];

        const body = zlib.gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));

        const parsed = await ingestService.parseBatch(body, 'gzip');
        assert.strictEqual(parsed.length, 5, 'malformed line is skipped, valid ones survive');

        const probe = { _id: 'probe-1', name: 'Moscow', probeUserId: 'user-1' };
        const counters = await ingestService.processBatch(probe, body, 'gzip');

        assert.strictEqual(counters.transport, 1, 'one transport window stored');
        assert.strictEqual(counters.target, 1, 'one target window stored');
        assert.strictEqual(counters.event, 1, 'one transition handled');
        assert.strictEqual(counters.meta, 1, 'metadata applied');
        assert.strictEqual(counters.skipped, 1, 'unknown node dropped');

        // The natural key is what makes redelivery idempotent.
        const key = state.transport[0].key;
        assert.deepStrictEqual(
            Object.keys(key).sort(),
            ['bucket', 'inboundId', 'nodeId', 'probeId', 'ts'],
            'transport window keyed by probe, node, inbound, bucket and time'
        );
        assert.strictEqual(key.bucket, 'raw', 'shipped windows land in the raw bucket');

        // Unknown code names are ignored and negative counters clamped, so a
        // misbehaving probe cannot inject arbitrary fields.
        const codes = state.transport[0].data.codes;
        assert.deepStrictEqual(codes, {
            netUnreachable: 0,
            handshakeFailed: 1,
            authRejected: 0,
            tunnelNoData: 0,
            degraded: 0,
            coreDown: 0,
        }, 'codes normalized into the fixed taxonomy');

        // A reading that stopped on the size cap is a floor, and the panel can
        // only say so if the flag survives ingest. An older probe sends no
        // maximum, so the reading itself stands in for it.
        const speed = state.transport[0].data;
        assert.strictEqual(speed.speedBps, 9_000_000, 'the throughput reading is stored');
        assert.strictEqual(speed.speedBpsMax, 9_000_000, 'a missing peak falls back to the reading');
        assert.strictEqual(speed.speedCapped, true, 'the lower-bound mark is kept');

        assert.strictEqual(state.targets[0].data.blocked, 1, 'target block recorded');
        assert.strictEqual(state.targets[0].key.targetId, 'openai', 'target keyed by resource');

        // Windows go out in one write per collection: on a fleet of dozens of
        // inbounds, a write per window is what makes ingest expensive.
        assert.strictEqual(state.transportCalls, 1, 'transport windows written in a single batch');
        assert.strictEqual(state.targetCalls, 1, 'target windows written in a single batch');
        assert.strictEqual(state.nodeQueries, 1, 'node index loaded once per batch');

        const alert = state.webhooks.find((w) => w.event === 'probe.node_unreachable');
        assert.ok(alert, 'transition emitted an alert');
        assert.strictEqual(alert.payload.code, 'auth_rejected', 'alert carries the failure code');
        assert.strictEqual(alert.payload.nodeName, 'Node One', 'alert names the node from the cached index');

        // A probe whose egress matches a node address is useless for that node.
        const sameHostUpdate = state.probeUpdates.find((u) => u.$set && u.$set.sameHostNodeIds);
        assert.ok(sameHostUpdate, 'same-host probe detected');
        assert.deepStrictEqual(sameHostUpdate.$set.sameHostNodeIds, ['node-1']);

        // An oversized batch is refused whole. Truncating it silently would
        // acknowledge measurements the panel never stored, and the probe
        // deletes a batch once it is acknowledged.
        const huge = [];
        for (let i = 0; i < 5001; i++) {
            huge.push(JSON.stringify({ kind: 'transport', nodeId: 'node-1', inboundId: 'main', ts: now }));
        }
        const hugeBody = zlib.gzipSync(Buffer.from(huge.join('\n'), 'utf8'));

        await assert.rejects(
            () => ingestService.parseBatch(hugeBody, 'gzip'),
            (err) => err.statusCode === 413,
            'a batch past the record cap is rejected with 413, not truncated'
        );
    });

    console.log('test-probe-ingest: OK');
})().catch((e) => {
    console.error('test-probe-ingest FAILED:', e);
    process.exit(1);
});
