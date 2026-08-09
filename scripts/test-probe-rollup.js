/**
 * Probe rollups, retention and liveness (no MongoDB).
 *
 * Verifies:
 *   - the previous whole hour is rolled up, not the current partial one,
 *   - raw windows collapse into one hourly document per (probe, node, inbound)
 *     with counters summed and the worst p95 kept,
 *   - retention comes from settings and is applied to both collections,
 *   - a probe that missed three report intervals raises the offline alert once,
 *     and the guard is cleared when it comes back.
 */

const assert = require('assert');
const Module = require('module');

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

const SETTINGS = {
    probes: { enabled: true, reportIntervalSec: 900, retentionDays: 14 },
};

async function withStubs(state, run) {
    const originalLoad = Module._load;

    const ProbeResult = {
        async aggregate(pipeline) {
            state.transportPipeline = pipeline;
            return state.transportRows;
        },
        async bulkUpsertWindows(ops) {
            state.transportBulkCalls++;
            state.transportUpserts.push(...ops);
            return ops.length;
        },
        async cleanup(days) {
            state.cleanupDays.push(days);
            return { raw: 5, hourly: 1 };
        },
    };

    const ProbeTargetResult = {
        async aggregate(pipeline) {
            state.targetPipeline = pipeline;
            return state.targetRows;
        },
        async bulkUpsertWindows(ops) {
            state.targetBulkCalls++;
            state.targetUpserts.push(...ops);
            return ops.length;
        },
        async cleanup(days) {
            state.cleanupDays.push(days);
            return { raw: 2, hourly: 0 };
        },
    };

    const Probe = {
        find(filter) {
            state.livenessFilter = filter;
            return { lean: async () => state.staleProbes };
        },
        async updateOne(filter, update) {
            state.probeUpdates.push({ filter, update });
        },
        async updateMany(filter, update) {
            state.probeUpdateMany.push({ filter, update });
        },
    };

    const webhook = {
        EVENTS: { PROBE_OFFLINE: 'probe.offline' },
        emit(event, payload) {
            state.webhooks.push({ event, payload });
        },
    };

    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    Module._load = function patchedLoad(request, parent, isMain) {
        const parentFile = normalizePath(parent?.filename);
        if (parentFile.endsWith('/src/services/probes/rollupService.js')) {
            if (request === '../../models/probeModel') return Probe;
            if (request === '../../models/probeResultModel') return ProbeResult;
            if (request === '../../models/probeTargetResultModel') return ProbeTargetResult;
            if (request === '../webhookService') return webhook;
            if (request === '../../utils/logger') return logger;
            if (request === '../../utils/helpers') return { getSettings: async () => SETTINGS };
        }
        return originalLoad(request, parent, isMain);
    };

    try {
        delete require.cache[require.resolve('../src/services/probes/rollupService')];
        const rollupService = require('../src/services/probes/rollupService');
        return await run(rollupService);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/services/probes/rollupService')];
    }
}

(async () => {
    const state = {
        transportRows: [
            {
                _id: { probeId: 'probe-1', nodeId: 'node-1', inboundId: 'main' },
                inboundTag: 'vless-in',
                attempts: 24,
                ok: 20,
                netUnreachable: 1,
                handshakeFailed: 3,
                authRejected: 0,
                tunnelNoData: 0,
                degraded: 2,
                latencyP50: 118.4,
                latencyP95: 940,
                handshakeMs: 61.2,
                ttfbMs: 210.7,
                speedBps: 8_000_000,
                speedSamples: 2,
                exitIp: '203.0.113.9',
                lastCode: 'handshake_failed',
            },
        ],
        targetRows: [
            {
                _id: { probeId: 'probe-1', nodeId: 'node-1', targetId: 'openai' },
                attempts: 12,
                ok: 9,
                blocked: 3,
                httpStatus: 403,
                latencyMs: 512.6,
                lastError: 'blocked',
            },
        ],
        transportUpserts: [],
        targetUpserts: [],
        transportBulkCalls: 0,
        targetBulkCalls: 0,
        cleanupDays: [],
        staleProbes: [
            { _id: 'probe-1', name: 'Moscow', country: 'RU', asn: 'AS12345', lastSeenAt: new Date(0) },
        ],
        probeUpdates: [],
        probeUpdateMany: [],
        webhooks: [],
    };

    await withStubs(state, async (rollupService) => {
        const counts = await rollupService.rollupPreviousHour();
        assert.deepStrictEqual(counts, { transport: 1, targets: 1 });

        // The rolled-up window must be the last complete hour: rolling up the
        // current one would produce a document that keeps changing.
        const expectedTo = rollupService.hourStart(new Date());
        const expectedFrom = new Date(expectedTo.getTime() - 3600 * 1000);
        const match = state.transportPipeline[0].$match;
        assert.strictEqual(match.bucket, 'raw', 'rollup reads raw windows only');
        assert.strictEqual(match.ts.$gte.getTime(), expectedFrom.getTime());
        assert.strictEqual(match.ts.$lt.getTime(), expectedTo.getTime());

        const upsert = state.transportUpserts[0];
        assert.strictEqual(upsert.key.bucket, 'hourly', 'result lands in the hourly bucket');
        assert.strictEqual(upsert.key.ts.getTime(), expectedFrom.getTime(), 'stamped with the hour start');
        assert.deepStrictEqual(
            Object.keys(upsert.key).sort(),
            ['bucket', 'inboundId', 'nodeId', 'probeId', 'ts'],
            'one hourly document per probe, node and inbound'
        );

        assert.strictEqual(upsert.data.attempts, 24);
        assert.strictEqual(upsert.data.ok, 20);
        assert.deepStrictEqual(upsert.data.codes, {
            netUnreachable: 1,
            handshakeFailed: 3,
            authRejected: 0,
            tunnelNoData: 0,
            degraded: 2,
            coreDown: 0,
        }, 'failure codes are summed, not overwritten');
        assert.strictEqual(upsert.data.latencyP50, 118, 'p50 averaged over the hour');
        assert.strictEqual(upsert.data.latencyP95, 940, 'p95 keeps the worst window');
        assert.strictEqual(upsert.data.lastCode, 'handshake_failed');

        assert.strictEqual(state.targetUpserts[0].key.targetId, 'openai');
        assert.strictEqual(state.targetUpserts[0].data.blocked, 3);

        // The hourly rollup writes once per collection: a write per series
        // would make the cron scale with the fleet instead of with the data.
        assert.strictEqual(state.transportBulkCalls, 1, 'hourly transport rows written in one batch');
        assert.strictEqual(state.targetBulkCalls, 1, 'hourly target rows written in one batch');

        // Retention
        await rollupService.cleanup();
        assert.deepStrictEqual(state.cleanupDays, [14, 14], 'retention from settings hits both collections');

        // Liveness: three missed report intervals is the threshold.
        const before = Date.now();
        const stale = await rollupService.checkLiveness();
        assert.strictEqual(stale, 1);

        const cutoff = state.livenessFilter.lastSeenAt.$lt.getTime();
        const expectedCutoff = before - 900 * 3 * 1000;
        assert.ok(
            Math.abs(cutoff - expectedCutoff) < 2000,
            'offline after three missed reports, so one failed delivery is tolerated'
        );
        assert.strictEqual(state.livenessFilter.offlineNotified, false, 'alert fires once per outage');

        const alert = state.webhooks.find((w) => w.event === 'probe.offline');
        assert.ok(alert, 'offline probe raised an alert');
        assert.strictEqual(alert.payload.probeName, 'Moscow');
        assert.strictEqual(alert.payload.asn, 'AS12345', 'alert carries the vantage point');

        assert.deepStrictEqual(
            state.probeUpdates[0].update,
            { $set: { offlineNotified: true } },
            'the alert guard is armed'
        );
        assert.deepStrictEqual(
            state.probeUpdateMany[0].update,
            { $set: { offlineNotified: false } },
            'the guard is cleared for probes that came back'
        );
    });

    // A disabled feature must not touch the database at all.
    SETTINGS.probes.enabled = false;
    const idle = {
        transportRows: [], targetRows: [], transportUpserts: [], targetUpserts: [],
        cleanupDays: [], staleProbes: [], probeUpdates: [], probeUpdateMany: [], webhooks: [],
    };
    await withStubs(idle, async (rollupService) => {
        assert.deepStrictEqual(await rollupService.rollupPreviousHour(), { transport: 0, targets: 0 });
        assert.strictEqual(await rollupService.checkLiveness(), 0);
        assert.strictEqual(idle.transportPipeline, undefined, 'disabled probes run no aggregation');
    });

    console.log('test-probe-rollup: OK');
})().catch((e) => {
    console.error('test-probe-rollup FAILED:', e);
    process.exit(1);
});
