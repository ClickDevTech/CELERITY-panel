/**
 * Admin-only probes UI + JSON API.
 *
 * Routes (all behind the panel auth chain applied in panel/index.js):
 *   GET    /panel/probes                    -> probes page
 *   GET    /panel/probes/api/list           -> probe list with live status
 *   POST   /panel/probes/api/create         -> create a probe, return install command
 *   POST   /panel/probes/api/:id/reissue    -> new one-time enrollment token
 *   DELETE /panel/probes/api/:id            -> delete probe, user and results
 *   GET    /panel/probes/api/:id/history    -> check history for one probe
 *   GET    /panel/nodes/:id/probe-status    -> external checks block on a node card
 *
 * Probe verdicts are deliberately kept out of node.status: with a single probe
 * there is no way to tell "node is down" from "the probe uplink is broken", so
 * results are always presented per vantage point.
 */

const express = require('express');
const router = express.Router();

const { render } = require('./helpers');
const logger = require('../../utils/logger');
const Probe = require('../../models/probeModel');
const HyNode = require('../../models/hyNodeModel');
const ProbeResult = require('../../models/probeResultModel');
const ProbeTargetResult = require('../../models/probeTargetResultModel');
const enrollService = require('../../services/probes/enrollService');
const manifestService = require('../../services/probes/manifestService');
const { getSettings } = require('../../utils/helpers');

const RELEASE_BASE = 'https://github.com/ClickDevTech/CELERITY-panel/releases/latest/download';

// Beyond this range the history switches from 5-minute windows to hourly
// rollups: a day of raw windows is already ~288 points per inbound.
const HISTORY_RAW_MAX_HOURS = 12;

/**
 * Build the one-liners the operator runs on the probe host. The enrollment
 * token is embedded and is single-use, so a command is only valid until the
 * first run.
 *
 * The installer writes to /usr/local/bin and registers a service, so it needs
 * root. `sudo` has to wrap the interpreter rather than curl: in a pipeline the
 * shell runs both sides itself, and privileges on the download side are useless.
 */
function buildInstallCommands(baseUrl, enrollToken) {
    const shUrl = `${RELEASE_BASE}/celerity-probe-install.sh`;
    const ps1Url = `${RELEASE_BASE}/celerity-probe-install.ps1`;

    return {
        unix: `curl -fsSL ${shUrl} | sudo PANEL_URL='${baseUrl}' ENROLL_TOKEN='${enrollToken}' sh`,
        windows: `$env:PANEL_URL='${baseUrl}'; $env:ENROLL_TOKEN='${enrollToken}'; irm ${ps1Url} | iex`,
    };
}

async function isEnabled() {
    const settings = await getSettings();
    return !!settings?.probes?.enabled;
}

/**
 * Reject anything that is not a Mongo id before it reaches a query: a cast
 * error would otherwise surface as a 500 on attacker-controlled input.
 */
function validObjectId(value) {
    return require('mongoose').Types.ObjectId.isValid(String(value || ''));
}

/**
 * A probe is considered live when it reported within three report intervals.
 */
function probeIsLive(probe, reportSec) {
    if (!probe.lastSeenAt) return false;
    return Date.now() - new Date(probe.lastSeenAt).getTime() < reportSec * 3 * 1000;
}

// ─── Page ────────────────────────────────────────────────────────────────────

router.get('/probes', async (req, res) => {
    try {
        const settings = await getSettings();
        // The table is filled by the API right after load, so the page only
        // needs counts: fetching the full list twice would double the work.
        const [probeCount, nodeCount] = await Promise.all([
            Probe.countDocuments({}),
            HyNode.countDocuments({ active: true, type: { $ne: 'virtual' } }),
        ]);

        const targetCount = (settings?.probes?.targets || []).filter((t) => t.enabled !== false).length;

        render(res, 'probes', {
            title: res.locals.t('probes.pageTitle'),
            page: 'probes',
            enabled: !!settings?.probes?.enabled,
            nodeCount,
            targetCount,
            // Series budget shown as a warning when the fleet grows: probes are
            // multiplied by nodes and by checklist resources.
            seriesEstimate: probeCount * nodeCount * Math.max(targetCount, 1),
        });
    } catch (error) {
        logger.error('[Panel] GET /probes error:', error.message);
        res.status(500).send(`${res.locals.t?.('common.error') || 'Error'}: ${error.message}`);
    }
});

// ─── JSON API ────────────────────────────────────────────────────────────────

router.get('/probes/api/list', async (req, res) => {
    try {
        const settings = await getSettings();
        const reportSec = settings?.probes?.reportIntervalSec || 900;
        const probes = await Probe.listProbes();

        return res.json({
            enabled: !!settings?.probes?.enabled,
            probes: probes.map((p) => ({
                ...p,
                live: probeIsLive(p, reportSec),
            })),
        });
    } catch (error) {
        logger.error('[Panel] probes list error:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

router.post('/probes/api/create', async (req, res) => {
    try {
        if (!(await isEnabled())) {
            return res.status(403).json({ error: 'probes disabled' });
        }

        const name = String(req.body?.name || '').trim();
        if (!name) {
            return res.status(400).json({ error: 'name is required' });
        }

        const settings = await getSettings();
        const baseUrl = manifestService.resolveBaseUrl(settings);
        if (!baseUrl) {
            return res.status(400).json({ error: 'panel base URL is not configured' });
        }

        const { probe, enrollToken } = await enrollService.createProbe({
            name,
            createdBy: req.session?.username || 'admin',
        });

        return res.status(201).json({
            probeId: String(probe._id),
            name: probe.name,
            enrollToken,
            installCommands: buildInstallCommands(baseUrl, enrollToken),
            expiresAt: probe.enrollExpiresAt,
        });
    } catch (error) {
        logger.error('[Panel] probe create error:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

router.post('/probes/api/:id/reissue', async (req, res) => {
    try {
        if (!(await isEnabled())) {
            return res.status(403).json({ error: 'probes disabled' });
        }
        if (!validObjectId(req.params.id)) {
            return res.status(400).json({ error: 'invalid probe id' });
        }

        const probe = await Probe.findById(req.params.id);
        if (!probe) return res.status(404).json({ error: 'probe not found' });

        const settings = await getSettings();
        const baseUrl = manifestService.resolveBaseUrl(settings);
        if (!baseUrl) {
            // Without a base URL the command would point nowhere, and the old
            // token would already be revoked by the reissue.
            return res.status(400).json({ error: 'panel base URL is not configured' });
        }

        const enrollToken = await enrollService.regenerateEnrollToken(probe._id);

        return res.json({
            enrollToken,
            installCommands: buildInstallCommands(baseUrl, enrollToken),
        });
    } catch (error) {
        logger.error('[Panel] probe reissue error:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

// Deletion stays available even when the feature is switched off: revoking a
// probe must never depend on the feature flag.
router.delete('/probes/api/:id', async (req, res) => {
    try {
        if (!validObjectId(req.params.id)) {
            return res.status(400).json({ error: 'invalid probe id' });
        }

        const deleted = await enrollService.deleteProbe(req.params.id);
        if (!deleted) return res.status(404).json({ error: 'probe not found' });
        return res.json({ success: true });
    } catch (error) {
        logger.error('[Panel] probe delete error:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

/**
 * Check history for one probe, grouped by node and inbound.
 *
 * Short ranges read the raw 5-minute windows; anything longer reads the hourly
 * rollups, so a week-wide question costs the same as a day-wide one.
 */
router.get('/probes/api/:id/history', async (req, res) => {
    try {
        if (!validObjectId(req.params.id)) {
            return res.status(400).json({ error: 'invalid probe id' });
        }

        const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 720);
        const bucket = hours > HISTORY_RAW_MAX_HOURS ? 'hourly' : 'raw';
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);
        const probeId = new (require('mongoose').Types.ObjectId)(req.params.id);

        const [transport, targets] = await Promise.all([
            ProbeResult.getHistory({ probeId, since, bucket }),
            ProbeTargetResult.getHistory({ probeId, since, bucket }),
        ]);

        const nodeIds = [...new Set([...transport, ...targets].map((r) => r.nodeId).filter(Boolean))];
        const nodes = nodeIds.length
            ? await HyNode.find({ _id: { $in: nodeIds } }).select('name type').lean()
            : [];
        const nodeById = new Map(nodes.map((n) => [String(n._id), n]));

        return res.json({
            bucket,
            hours,
            since,
            nodes: buildHistoryTree(transport, targets, nodeById),
        });
    } catch (error) {
        logger.error('[Panel] probe history error:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

/**
 * Fold raw windows into one entry per node, with a series per inbound and a
 * series per checklist resource. Percentages are computed over the whole range
 * so the summary does not depend on how the series is rendered.
 */
function buildHistoryTree(transport, targets, nodeById) {
    const nodes = new Map();

    const nodeEntry = (nodeId) => {
        if (!nodes.has(nodeId)) {
            const node = nodeById.get(nodeId);
            nodes.set(nodeId, {
                nodeId,
                nodeName: node?.name || nodeId,
                nodeType: node?.type || '',
                inbounds: [],
                targets: [],
            });
        }
        return nodes.get(nodeId);
    };

    const series = new Map();
    for (const row of transport) {
        const nodeId = String(row.nodeId);
        const key = `${nodeId}::${row.inboundId}`;
        if (!series.has(key)) {
            const entry = {
                inboundId: row.inboundId,
                inboundTag: row.inboundTag || '',
                attempts: 0,
                ok: 0,
                latencyP95: 0,
                speedBps: 0,
                points: [],
            };
            series.set(key, entry);
            nodeEntry(nodeId).inbounds.push(entry);
        }

        const entry = series.get(key);
        entry.attempts += row.attempts || 0;
        entry.ok += row.ok || 0;
        entry.latencyP95 = Math.max(entry.latencyP95, row.latencyP95 || 0);
        if (row.speedBps) entry.speedBps = row.speedBps;
        entry.points.push({
            ts: row.ts,
            attempts: row.attempts || 0,
            ok: row.ok || 0,
            code: row.lastCode || '',
        });
    }

    const targetSeries = new Map();
    for (const row of targets) {
        const nodeId = String(row.nodeId);
        const key = `${nodeId}::${row.targetId}`;
        if (!targetSeries.has(key)) {
            const entry = {
                targetId: row.targetId,
                attempts: 0,
                ok: 0,
                blocked: 0,
                points: [],
            };
            targetSeries.set(key, entry);
            nodeEntry(nodeId).targets.push(entry);
        }

        const entry = targetSeries.get(key);
        entry.attempts += row.attempts || 0;
        entry.ok += row.ok || 0;
        entry.blocked += row.blocked || 0;
        entry.points.push({
            ts: row.ts,
            attempts: row.attempts || 0,
            ok: row.ok || 0,
            blocked: row.blocked || 0,
            httpStatus: row.httpStatus || 0,
        });
    }

    return Array.from(nodes.values())
        .sort((a, b) => a.nodeName.localeCompare(b.nodeName));
}

/**
 * External checks for a single node, grouped per probe. Feeds the node card.
 */
router.get('/nodes/:id/probe-status', async (req, res) => {
    try {
        const settings = await getSettings();
        if (!settings?.probes?.enabled) {
            return res.json({ enabled: false, probes: [] });
        }
        if (!validObjectId(req.params.id)) {
            return res.status(400).json({ error: 'invalid node id' });
        }

        const nodeId = String(req.params.id);
        const [transport, targets, probes] = await Promise.all([
            ProbeResult.getLatestForNode(nodeId),
            ProbeTargetResult.getLatestForNode(nodeId),
            Probe.listProbes(),
        ]);

        const probeById = new Map(probes.map((p) => [String(p._id), p]));
        const grouped = new Map();

        for (const row of transport) {
            const pid = String(row.probeId);
            const probe = probeById.get(pid);
            if (!probe) continue;
            if (!grouped.has(pid)) {
                grouped.set(pid, {
                    probeId: pid,
                    name: probe.name,
                    country: probe.country || '',
                    asn: probe.asn || '',
                    sameHost: (probe.sameHostNodeIds || []).includes(nodeId),
                    inbounds: [],
                    targets: [],
                });
            }
            grouped.get(pid).inbounds.push({
                inboundId: row.inboundId,
                inboundTag: row.inboundTag,
                ts: row.ts,
                attempts: row.attempts,
                ok: row.ok,
                lastCode: row.lastCode,
                latencyP50: row.latencyP50,
                latencyP95: row.latencyP95,
                speedBps: row.speedBps,
                exitIp: row.exitIp,
                selectedNodeId: row.selectedNodeId,
            });
        }

        for (const row of targets) {
            const pid = String(row.probeId);
            if (!grouped.has(pid)) continue;
            grouped.get(pid).targets.push({
                targetId: row.targetId,
                ts: row.ts,
                ok: row.ok,
                blocked: row.blocked,
                httpStatus: row.httpStatus,
            });
        }

        return res.json({ enabled: true, probes: Array.from(grouped.values()) });
    } catch (error) {
        logger.error('[Panel] node probe-status error:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

module.exports = router;
