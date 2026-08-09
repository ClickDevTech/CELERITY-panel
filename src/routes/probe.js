/**
 * Probe endpoints (external probe -> panel).
 *
 * Mounted BEFORE the global express.json() so the ingest handler can read the
 * raw gzipped body itself. Probes live behind NAT and on residential links, so
 * the panel never connects to them: everything is pull (profile) or push
 * (ingest) initiated by the probe.
 *
 *   POST /enroll  - exchange the one-time enrollment token for a permanent one
 *   GET  /profile - manifest of what to check, plus cadence and budgets
 *   POST /ingest  - gzipped NDJSON rollup windows
 *
 * Authentication is a probe-scoped Bearer token, not an admin API key: a probe
 * has no rights on nodes and can only report its own measurements.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const logger = require('../utils/logger');
const Probe = require('../models/probeModel');
const cacheService = require('../services/cacheService');
const enrollService = require('../services/probes/enrollService');
const manifestService = require('../services/probes/manifestService');
const ingestService = require('../services/probes/ingestService');

// A rollup batch is tiny compared to access logs: a few hundred windows at
// most. Keep the cap low so a misbehaving probe cannot pressure the panel.
const MAX_BODY_BYTES = 1 * 1024 * 1024;

// Feature flag cached briefly so a probe polling every few minutes does not
// hit Mongo for the settings document on every request.
let _enabledCache = { value: false, at: 0 };
const ENABLED_TTL_MS = 10 * 1000;

const Settings = require('../models/settingsModel');

async function probesEnabled() {
    const now = Date.now();
    if (now - _enabledCache.at > ENABLED_TTL_MS) {
        const s = await Settings.get();
        _enabledCache = { value: !!s?.probes?.enabled, at: now };
    }
    return _enabledCache.value;
}

/**
 * Drop the cached flag so toggling the feature takes effect immediately instead
 * of after the TTL.
 */
function invalidateFeatureCache() {
    _enabledCache = { value: false, at: 0 };
}

// Read the raw request body into a single Buffer, aborting past the cap.
function readRawBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let aborted = false;
        req.on('data', (chunk) => {
            if (aborted) return;
            size += chunk.length;
            if (size > limit) {
                aborted = true;
                const err = new Error('payload too large');
                err.statusCode = 413;
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
        req.on('error', (e) => { if (!aborted) reject(e); });
    });
}

function getBearer(req) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : '';
}

/**
 * Resolve the calling probe, or answer 401/403 directly.
 * Returns null when the response has already been sent.
 */
async function authenticate(req, res) {
    if (!(await probesEnabled())) {
        res.status(403).json({ error: 'probes disabled' });
        return null;
    }
    const token = getBearer(req);
    if (!token) {
        res.status(401).json({ error: 'missing bearer token' });
        return null;
    }
    const probe = await Probe.findByToken(token);
    if (!probe) {
        res.status(401).json({ error: 'invalid token' });
        return null;
    }
    return probe;
}

/**
 * POST /enroll — one-time exchange of the enrollment token.
 * Uses a local JSON parser because the router is mounted before express.json().
 */
router.post('/enroll', express.json({ limit: '8kb' }), async (req, res) => {
    try {
        if (!(await probesEnabled())) {
            return res.status(403).json({ error: 'probes disabled' });
        }

        const enrollToken = getBearer(req) || String(req.body?.enrollToken || '');
        if (!enrollToken) {
            return res.status(401).json({ error: 'missing enrollment token' });
        }

        const result = await enrollService.enroll(enrollToken, {
            version: req.body?.version,
            singboxVersion: req.body?.singboxVersion,
            os: req.body?.os,
            arch: req.body?.arch,
            egressIp: req.ip,
        });

        if (!result) {
            return res.status(401).json({ error: 'invalid or expired enrollment token' });
        }

        return res.status(201).json({
            token: result.token,
            probeId: String(result.probe._id),
            name: result.probe.name,
        });
    } catch (err) {
        logger.error(`[Probes] enroll error: ${err.message}`);
        return res.status(500).json({ error: 'enrollment failed' });
    }
});

/**
 * GET /profile — what to check, how often, and where to send results.
 */
router.get('/profile', async (req, res) => {
    try {
        const probe = await authenticate(req, res);
        if (!probe) return undefined;

        // A poll must stay cheap: ensureProbeUser only writes when the user is
        // actually missing, and the node rebind only when the fleet changed.
        const user = await enrollService.ensureProbeUser(probe);
        await enrollService.syncProbeUserNodes(user);


        const manifest = await manifestService.buildManifest(probe, user.subscriptionToken);

        await Probe.updateOne(
            { _id: probe._id },
            { $set: { lastSeenAt: new Date(), egressIp: req.ip || probe.egressIp || '' } }
        );

        return res.json(manifest);
    } catch (err) {
        logger.error(`[Probes] profile error: ${err.message}`);
        return res.status(500).json({ error: 'profile failed' });
    }
});

/**
 * POST /ingest — gzipped NDJSON rollup windows.
 */
router.post('/ingest', async (req, res) => {
    try {
        const probe = await authenticate(req, res);
        if (!probe) return undefined;

        const body = await readRawBody(req, MAX_BODY_BYTES);
        if (!body || body.length === 0) {
            return res.status(400).json({ error: 'empty body' });
        }

        const computedId = crypto.createHash('sha256').update(body).digest('hex');
        const claimedId = String(req.headers['x-batch-id'] || '').trim().toLowerCase();
        if (claimedId && claimedId !== computedId) {
            return res.status(400).json({ error: 'batch id mismatch' });
        }

        // Idempotency: an identical redelivered batch is acknowledged without
        // reprocessing, so at-least-once shipping stays safe.
        if (await cacheService.isBatchProcessed(String(probe._id), computedId)) {
            await ingestService.bumpStats('duplicateBatches');
            return res.status(200).json({ ok: true, duplicate: true });
        }

        const counters = await ingestService.processBatch(
            probe,
            body,
            req.headers['content-encoding']
        );

        await cacheService.markBatchProcessed(String(probe._id), computedId);
        await ingestService.bumpStats('ingestedBatches');

        return res.status(202).json({ ok: true, batchId: computedId, ...counters });
    } catch (err) {
        const code = err.statusCode || 500;
        if (code >= 500) {
            logger.error(`[Probes] ingest error: ${err.message}`);
        }
        await ingestService.bumpStats('rejectedBatches').catch(() => {});
        return res.status(code).json({ error: err.message || 'ingest failed' });
    }
});

router.invalidateFeatureCache = invalidateFeatureCache;

module.exports = router;
