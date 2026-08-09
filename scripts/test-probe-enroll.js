/**
 * Probe enrollment and revocation (no MongoDB).
 *
 * Verifies:
 *   - the enrollment token is one-time: after the exchange it no longer works,
 *   - enrolling creates the hidden user with isProbe and the configured traffic
 *     cap, bound to every active real node (virtual ones are not dialable),
 *   - the probe token is stored only as a hash plus a reversible copy for
 *     re-displaying the install command,
 *   - node rebinding is a no-op when the fleet has not changed,
 *   - deleting a probe removes its user, drops it from the running nodes,
 *     invalidates the subscription cache and wipes its results.
 */

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

function hashToken(t) {
    return crypto.createHash('sha256').update(t).digest('hex');
}

const SETTINGS = { probes: { enabled: true, probeTrafficLimitBytes: 53687091200 } };

async function withStubs(state, run) {
    const originalLoad = Module._load;

    const Probe = {
        ENROLL_TTL_MS: 24 * 60 * 60 * 1000,
        hashToken,
        async createProbe({ name, createdBy }) {
            const enrollToken = `ce_${crypto.randomBytes(16).toString('hex')}`;
            const doc = {
                _id: 'probe-1',
                name,
                createdBy: createdBy || '',
                enrollTokenHash: hashToken(enrollToken),
                enrollExpiresAt: new Date(Date.now() + 3600_000),
                active: true,
            };
            state.probes.push(doc);
            return { doc, enrollToken };
        },
        async findByEnrollToken(plain) {
            const h = hashToken(plain);
            const probe = state.probes.find((p) => p.active && p.enrollTokenHash === h);
            if (!probe) return null;
            if (!probe.enrollExpiresAt || new Date(probe.enrollExpiresAt) < new Date()) return null;
            return probe;
        },
        async issueToken(probeId) {
            const plain = `cp_${crypto.randomBytes(24).toString('hex')}`;
            const probe = state.probes.find((p) => String(p._id) === String(probeId));
            probe.tokenHash = hashToken(plain);
            probe.tokenPrefix = plain.substring(0, 12);
            probe.tokenEncrypted = `enc:${plain}`;
            probe.enrollTokenHash = '';
            probe.enrollExpiresAt = null;
            probe.enrolledAt = new Date();
            return plain;
        },
        async findById(id) {
            const probe = state.probes.find((p) => String(p._id) === String(id));
            return probe || null;
        },
        async updateOne(filter, update) {
            const probe = state.probes.find((p) => String(p._id) === String(filter._id));
            if (probe && update.$set) Object.assign(probe, update.$set);
            state.probeUpdates.push(update);
        },
        async deleteOne(filter) {
            state.probes = state.probes.filter((p) => String(p._id) !== String(filter._id));
            state.probeDeleted = true;
        },
    };

    const HyNode = {
        find(filter) {
            state.nodeFilters.push(filter);
            const matched = state.nodes.filter(
                (n) => n.active && n.type !== 'virtual'
            );
            return { select: () => ({ lean: async () => matched }) };
        },
    };

    const HyUser = {
        async findOne(filter) {
            return state.users.find((u) => u.userId === filter.userId) || null;
        },
        async findById(id) {
            return state.users.find((u) => String(u._id) === String(id)) || null;
        },
        async create(doc) {
            const user = {
                _id: 'user-1',
                subscriptionToken: 'sub-token',
                toObject() { return { ...this }; },
                ...doc,
            };
            state.users.push(user);
            return user;
        },
        async updateOne(filter, update) {
            const user = state.users.find((u) => String(u._id) === String(filter._id));
            if (user && update.$set) Object.assign(user, update.$set);
            state.userUpdates.push(update);
        },
        async deleteOne(filter) {
            state.users = state.users.filter((u) => String(u._id) !== String(filter._id));
            state.userDeleted = true;
        },
    };

    const results = (bucketName) => ({
        async deleteMany(filter) {
            state.deletedResults.push({ bucket: bucketName, filter });
        },
    });

    const syncService = {
        async removeUserFromAllXrayNodes(user) {
            state.removedFromNodes.push(user.userId);
        },
    };

    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    Module._load = function patchedLoad(request, parent, isMain) {
        const parentFile = normalizePath(parent?.filename);
        if (parentFile.endsWith('/src/services/probes/enrollService.js')) {
            if (request === '../../models/probeModel') return Probe;
            if (request === '../../models/hyUserModel') return HyUser;
            if (request === '../../models/hyNodeModel') return HyNode;
            if (request === '../../models/probeResultModel') return results('transport');
            if (request === '../../models/probeTargetResultModel') return results('target');
            if (request === '../cryptoService') {
                return {
                    encrypt: (v) => `enc:${v}`,
                    decrypt: (v) => String(v).replace(/^enc:/, ''),
                    generatePassword: (seed) => `pw-${seed}`,
                };
            }
            if (request === '../syncService') return syncService;
            if (request === '../../utils/logger') return logger;
            if (request === '../../utils/helpers') {
                return {
                    getSettings: async () => SETTINGS,
                    invalidateUserCache: async (userId, token) => {
                        state.cacheInvalidations.push({ userId, token });
                    },
                };
            }
        }
        return originalLoad(request, parent, isMain);
    };

    try {
        delete require.cache[require.resolve('../src/services/probes/enrollService')];
        const enrollService = require('../src/services/probes/enrollService');
        // Must be awaited: the service requires syncService lazily during
        // revocation, long after the synchronous part of the test is over.
        return await run(enrollService);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/services/probes/enrollService')];
    }
}

(async () => {
    const state = {
        probes: [],
        users: [],
        nodes: [
            { _id: 'node-1', active: true, type: 'xray' },
            { _id: 'node-2', active: true, type: 'hysteria' },
            { _id: 'node-off', active: false, type: 'xray' },
            { _id: 'node-virtual', active: true, type: 'virtual' },
        ],
        nodeFilters: [],
        userUpdates: [],
        probeUpdates: [],
        cacheInvalidations: [],
        deletedResults: [],
        removedFromNodes: [],
    };

    await withStubs(state, async (enrollService) => {
        const { probe, enrollToken } = await enrollService.createProbe({
            name: 'Moscow',
            createdBy: 'admin',
        });
        assert.ok(enrollToken.startsWith('ce_'), 'enrollment token is namespaced');
        assert.strictEqual(probe.tokenHash, undefined, 'no permanent token before enrollment');

        const enrolled = await enrollService.enroll(enrollToken, {
            version: '1.0.0',
            singboxVersion: '1.9.0',
            os: 'linux',
            arch: 'amd64',
            egressIp: '198.51.100.7',
        });
        assert.ok(enrolled, 'valid enrollment token is accepted');
        assert.ok(enrolled.token.startsWith('cp_'), 'permanent token is namespaced');
        assert.strictEqual(enrolled.subscriptionToken, 'sub-token', 'probe gets its subscription');

        // One-time by construction: the hash is cleared during the exchange.
        const replay = await enrollService.enroll(enrollToken, {});
        assert.strictEqual(replay, null, 'enrollment token cannot be replayed');

        const stored = state.probes[0];
        assert.strictEqual(stored.tokenHash, hashToken(enrolled.token), 'only the hash is stored');
        assert.strictEqual(stored.tokenEncrypted, `enc:${enrolled.token}`, 'encrypted copy for re-display');
        assert.strictEqual(stored.tokenPrefix, enrolled.token.substring(0, 12), 'prefix for identification');
        assert.strictEqual(stored.os, 'linux', 'self-reported runtime info applied');
        assert.strictEqual(stored.egressIp, '198.51.100.7');

        const user = state.users[0];
        assert.strictEqual(user.isProbe, true, 'hidden user is flagged as a probe');
        assert.strictEqual(user.enabled, true);
        assert.strictEqual(
            user.trafficLimit,
            SETTINGS.probes.probeTrafficLimitBytes,
            'probe user is capped: the credentials are plain'
        );
        assert.deepStrictEqual(
            user.nodes.map(String).sort(),
            ['node-1', 'node-2'],
            'bound to active real nodes only, virtual ones are not dialable'
        );
        assert.strictEqual(user.maxDevices, 0, 'probe user is not device-limited');
        assert.ok(
            state.cacheInvalidations.some((c) => c.userId === 'probe-probe-1'),
            'subscription cache invalidated so the probe sees its config'
        );

        // Rebinding is skipped when the fleet is unchanged, so a profile poll
        // every few minutes does not churn the subscription cache.
        state.cacheInvalidations.length = 0;
        assert.strictEqual(await enrollService.syncProbeUserNodes(user), false, 'no-op when unchanged');
        assert.strictEqual(state.cacheInvalidations.length, 0, 'no cache invalidation without change');

        state.nodes.push({ _id: 'node-3', active: true, type: 'xray' });
        assert.strictEqual(await enrollService.syncProbeUserNodes(user), true, 'new node picked up');
        assert.strictEqual(state.cacheInvalidations.length, 1, 'subscription refreshed once');

        // Re-issuing the enrollment token invalidates the current one.
        const again = await enrollService.regenerateEnrollToken('probe-1');
        assert.ok(again.startsWith('ce_'));
        assert.strictEqual(state.probes[0].tokenHash, '', 'old permanent token is revoked on re-issue');

        // Revocation
        const removed = await enrollService.deleteProbe('probe-1');
        assert.strictEqual(removed, true);
        assert.strictEqual(state.userDeleted, true, 'hidden user removed with the probe');
        assert.strictEqual(state.probeDeleted, true);
        assert.deepStrictEqual(state.removedFromNodes, ['probe-probe-1'], 'pushed to the running nodes');
        assert.deepStrictEqual(
            state.deletedResults.map((r) => r.bucket).sort(),
            ['target', 'transport'],
            'measurements of a deleted probe are removed too'
        );
        assert.ok(
            state.cacheInvalidations.some((c) => c.token === 'sub-token'),
            'subscription cache purged on revocation'
        );

        assert.strictEqual(await enrollService.deleteProbe('probe-1'), false, 'deleting twice is harmless');
    });

    console.log('test-probe-enroll: OK');
})().catch((e) => {
    console.error('test-probe-enroll FAILED:', e);
    process.exit(1);
});
