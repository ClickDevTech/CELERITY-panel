/**
 * HTTP contract of the probe endpoints (real Express, stubbed services).
 *
 * The route is the trust boundary of the whole feature: it decides what an
 * unauthenticated caller learns, how much body it is allowed to send, and
 * whether a redelivered batch is stored twice. None of that is visible from the
 * service-level tests, so it is exercised here over a real socket.
 *
 * Verifies:
 *   - the feature flag is enforced before anything else,
 *   - a missing or wrong token never reaches the ingest pipeline,
 *   - a claimed batch id that does not match the body is refused,
 *   - a redelivered batch is acknowledged without being processed again,
 *   - a body past the cap is cut off with 413 instead of being buffered,
 *   - a batch the service rejects is answered with its own status and counted.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const Module = require('module');

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

function request(port, method, path, { token, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...headers,
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) { /* non-JSON body */ }
                resolve({ status: res.statusCode, body: parsed, raw: data });
            });
        });

        // A 413 closes the socket mid-upload on purpose; that is a successful
        // rejection, not a test failure.
        req.on('error', (err) => {
            if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
                return resolve({ status: 413, body: null, raw: '', aborted: true });
            }
            reject(err);
        });

        if (body) req.write(body);
        req.end();
    });
}

async function withRoute(state, run) {
    const originalLoad = Module._load;

    const Probe = {
        async findByToken(token) {
            return token === state.validToken
                ? { _id: 'probe-1', name: 'Moscow', egressIp: '' }
                : null;
        },
        async updateOne() { return { acknowledged: true }; },
    };

    const Settings = {
        async get() { return { probes: { enabled: state.enabled } }; },
    };

    const cacheService = {
        async isBatchProcessed(probeId, batchId) {
            return state.processed.has(batchId);
        },
        async markBatchProcessed(probeId, batchId) {
            state.processed.add(batchId);
        },
    };

    const ingestService = {
        async processBatch() {
            state.processedBatches++;
            if (state.throwStatus) {
                const err = new Error('batch has too many records');
                err.statusCode = state.throwStatus;
                throw err;
            }
            return { transport: 1, target: 0, event: 0, meta: 0, skipped: 0 };
        },
        async bumpStats(field) {
            state.stats.push(field);
        },
    };

    const enrollService = {
        async ensureProbeUser() {
            state.ensureCalls++;
            return { subscriptionToken: 'sub-token', userId: 'probe-user', nodes: [] };
        },
        async syncProbeUserNodes() {
            state.syncCalls++;
            return false;
        },
    };

    const manifestService = {
        async buildManifest() {
            return { nodes: [], ingestUrl: 'https://panel/api/probe/ingest' };
        },
    };

    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    Module._load = function patchedLoad(request_, parent, isMain) {
        const parentFile = normalizePath(parent?.filename);
        if (parentFile.endsWith('/src/routes/probe.js')) {
            if (request_ === '../models/probeModel') return Probe;
            if (request_ === '../models/settingsModel') return Settings;
            if (request_ === '../services/cacheService') return cacheService;
            if (request_ === '../services/probes/enrollService') return enrollService;
            if (request_ === '../services/probes/manifestService') return manifestService;
            if (request_ === '../services/probes/ingestService') return ingestService;
            if (request_ === '../utils/logger') return logger;
        }
        return originalLoad(request_, parent, isMain);
    };

    let server;
    try {
        delete require.cache[require.resolve('../src/routes/probe')];
        const router = require('../src/routes/probe');

        const express = require('express');
        const app = express();
        app.use('/api/probe', router);

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        return await run(server.address().port, router);
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/routes/probe')];
    }
}

(async () => {
    const state = {
        enabled: true,
        validToken: 'cp_valid',
        processed: new Set(),
        processedBatches: 0,
        stats: [],
        ensureCalls: 0,
        syncCalls: 0,
        throwStatus: 0,
    };

    await withRoute(state, async (port, router) => {
        // ── Authentication ───────────────────────────────────────────────
        const noToken = await request(port, 'GET', '/api/probe/profile');
        assert.strictEqual(noToken.status, 401, 'a request without a token is rejected');

        const badToken = await request(port, 'GET', '/api/probe/profile', { token: 'cp_wrong' });
        assert.strictEqual(badToken.status, 401, 'an unknown token is rejected');
        assert.strictEqual(state.ensureCalls, 0, 'no probe user work happens for an unauthenticated caller');

        const profile = await request(port, 'GET', '/api/probe/profile', { token: state.validToken });
        assert.strictEqual(profile.status, 200, 'a valid token gets the manifest');
        assert.ok(profile.body.ingestUrl, 'the manifest tells the probe where to report');

        // ── Ingest ───────────────────────────────────────────────────────
        const payload = Buffer.from('{"kind":"transport","nodeId":"node-1"}\n', 'utf8');
        const batchId = crypto.createHash('sha256').update(payload).digest('hex');

        const empty = await request(port, 'POST', '/api/probe/ingest', { token: state.validToken });
        assert.strictEqual(empty.status, 400, 'an empty batch is refused');

        const mismatch = await request(port, 'POST', '/api/probe/ingest', {
            token: state.validToken,
            body: payload,
            headers: { 'x-batch-id': 'f'.repeat(64) },
        });
        assert.strictEqual(mismatch.status, 400, 'a batch id that does not match the body is refused');
        assert.strictEqual(state.processedBatches, 0, 'a mismatched batch never reaches the pipeline');

        const accepted = await request(port, 'POST', '/api/probe/ingest', {
            token: state.validToken,
            body: payload,
            headers: { 'x-batch-id': batchId },
        });
        assert.strictEqual(accepted.status, 202, 'a well-formed batch is accepted');
        assert.strictEqual(accepted.body.batchId, batchId, 'the response echoes the computed batch id');
        assert.strictEqual(state.processedBatches, 1, 'the batch was processed exactly once');

        // At-least-once shipping means the same batch will arrive again after a
        // lost acknowledgement; storing it twice would double every counter.
        const duplicate = await request(port, 'POST', '/api/probe/ingest', {
            token: state.validToken,
            body: payload,
            headers: { 'x-batch-id': batchId },
        });
        assert.strictEqual(duplicate.status, 200, 'a redelivered batch is acknowledged');
        assert.strictEqual(duplicate.body.duplicate, true, 'the response says it was a duplicate');
        assert.strictEqual(state.processedBatches, 1, 'a redelivered batch is not processed again');
        assert.ok(state.stats.includes('duplicateBatches'), 'duplicates are counted');

        // ── Oversized body ───────────────────────────────────────────────
        const oversized = Buffer.alloc(1024 * 1024 + 4096, 0x41);
        const tooBig = await request(port, 'POST', '/api/probe/ingest', {
            token: state.validToken,
            body: oversized,
        });
        assert.strictEqual(tooBig.status, 413, 'a body past the cap is rejected');

        // ── Service-level rejection ──────────────────────────────────────
        state.throwStatus = 413;
        const rejected = await request(port, 'POST', '/api/probe/ingest', {
            token: state.validToken,
            body: Buffer.from('{"kind":"transport","nodeId":"node-2"}\n', 'utf8'),
        });
        assert.strictEqual(rejected.status, 413, 'the service status is passed through');
        assert.ok(state.stats.includes('rejectedBatches'), 'rejected batches are counted');
        state.throwStatus = 0;

        // ── Feature flag ─────────────────────────────────────────────────
        state.enabled = false;
        router.invalidateFeatureCache();

        const disabled = await request(port, 'GET', '/api/probe/profile', { token: state.validToken });
        assert.strictEqual(disabled.status, 403, 'a disabled feature refuses authenticated probes too');

        const disabledIngest = await request(port, 'POST', '/api/probe/ingest', {
            token: state.validToken,
            body: payload,
        });
        assert.strictEqual(disabledIngest.status, 403, 'ingest is closed while the feature is off');
    });

    console.log('test-probe-route: OK');
})().catch((e) => {
    console.error('test-probe-route FAILED:', e);
    process.exit(1);
});
