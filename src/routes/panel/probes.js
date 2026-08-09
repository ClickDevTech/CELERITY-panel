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

// Beyond this range the history switches from shipped windows to hourly
// rollups: a day of raw windows is already hundreds of points per inbound.
const HISTORY_RAW_MAX_HOURS = 12;

// Upper bound on segments in one strip. Past this a wider slot is used instead,
// because a segment thinner than a couple of pixels cannot be read or clicked.
const HISTORY_MAX_SLOTS = 240;

// Documents read per collection for one history request.
const HISTORY_DOC_LIMIT = 6000;

// Failure counters in the order that decides which one describes a window.
// A dead local core wins outright: while it is down nothing else measured in
// that window is evidence about any node.
const CODE_PRIORITY = [
    ['coreDown', 'core_down'],
    ['authRejected', 'auth_rejected'],
    ['handshakeFailed', 'handshake_failed'],
    ['netUnreachable', 'net_unreachable'],
    ['tunnelNoData', 'tunnel_no_data'],
    ['degraded', 'degraded'],
];

function emptyCodes() {
    return {
        netUnreachable: 0,
        handshakeFailed: 0,
        authRejected: 0,
        tunnelNoData: 0,
        degraded: 0,
        coreDown: 0,
    };
}

function addCodes(into, from) {
    if (!from) return into;
    for (const field of Object.keys(into)) into[field] += from[field] || 0;
    return into;
}

function totalCodes(codes) {
    return Object.values(codes).reduce((sum, n) => sum + n, 0);
}

function dominantCode(codes) {
    let best = '';
    let bestCount = 0;
    for (const [field, code] of CODE_PRIORITY) {
        if ((codes[field] || 0) > bestCount) {
            best = code;
            bestCount = codes[field];
        }
    }
    return best;
}

function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2
        ? sorted[mid]
        : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function mean(sum, count) {
    return count > 0 ? Math.round(sum / count) : 0;
}

function uptimePct(ok, attempts) {
    if (!attempts) return null;
    return Math.round((ok / attempts) * 1000) / 10;
}

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
 * Short ranges read the shipped windows; anything longer reads the hourly
 * rollups, so a week-wide question costs the same as a day-wide one.
 *
 * Windows are laid out on a fixed time grid rather than concatenated. Without
 * it a silent probe leaves no trace: the surviving windows simply close ranks
 * and the strip claims uninterrupted coverage.
 */
router.get('/probes/api/:id/history', async (req, res) => {
    try {
        if (!validObjectId(req.params.id)) {
            return res.status(400).json({ error: 'invalid probe id' });
        }

        const settings = await getSettings();
        const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 720);
        const bucket = hours > HISTORY_RAW_MAX_HOURS ? 'hourly' : 'raw';
        const until = Date.now();
        const since = new Date(until - hours * 60 * 60 * 1000);
        const probeId = new (require('mongoose').Types.ObjectId)(req.params.id);

        const [transport, targets] = await Promise.all([
            ProbeResult.getHistory({ probeId, since, bucket, limit: HISTORY_DOC_LIMIT }),
            ProbeTargetResult.getHistory({ probeId, since, bucket, limit: HISTORY_DOC_LIMIT }),
        ]);

        // Both reads are newest-first internally, so hitting the limit means the
        // far end of the range is missing. Starting the grid at the oldest row
        // that did arrive keeps the axis honest instead of drawing an empty
        // prefix that looks like downtime.
        const truncated = transport.length >= HISTORY_DOC_LIMIT || targets.length >= HISTORY_DOC_LIMIT;
        const firstTs = [transport[0], targets[0]]
            .filter(Boolean)
            .map((row) => new Date(row.ts).getTime());
        const rangeStart = truncated && firstTs.length
            ? Math.max(since.getTime(), Math.min(...firstTs))
            : since.getTime();

        const reportSec = settings?.probes?.reportIntervalSec || 900;
        const baseStep = bucket === 'hourly'
            ? 60 * 60 * 1000
            : Math.max(reportSec * 1000, 60 * 1000);

        const spanMs = Math.max(until - rangeStart, baseStep);
        const stepMs = Math.max(baseStep, Math.ceil(spanMs / HISTORY_MAX_SLOTS));
        const slots = Math.max(1, Math.ceil(spanMs / stepMs));
        const gridStart = until - slots * stepMs;

        const nodeIds = new Set();
        for (const row of [...transport, ...targets]) {
            if (row.nodeId) nodeIds.add(String(row.nodeId));
            if (row.selectedNodeId) nodeIds.add(String(row.selectedNodeId));
        }

        // The same projection the manifest uses: inbound metadata is derived by
        // manifestService from these fields, and a short projection would make
        // it silently describe nothing.
        const nodes = nodeIds.size
            ? await HyNode.find({ _id: { $in: [...nodeIds] } })
                .select('name flag type ip domain port portRange portConfigs sni obfs hopInterval xray virtual groups')
                .lean()
            : [];
        const nodeById = new Map(nodes.map((n) => [String(n._id), n]));

        const targetById = new Map(
            (settings?.probes?.targets || []).map((t) => [String(t.id), t])
        );

        const grid = { gridStart, stepMs, slots, until };
        const built = buildHistory({ transport, targets, nodeById, targetById, grid });

        return res.json({
            bucket,
            hours,
            since: new Date(gridStart),
            until: new Date(until),
            stepMs,
            slots,
            truncated,
            speedTestEnabled: !!settings?.probes?.speedTest?.enabled,
            ...built,
        });
    } catch (error) {
        logger.error('[Panel] probe history error:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

/**
 * Human-readable metadata per inbound id of one node, reused from the manifest
 * so the history names an inbound exactly the way the probe was told to check
 * it. Stored windows only carry an opaque id and a core tag.
 */
function describeInbounds(node) {
    if (!node) return new Map();

    if (node.type === 'virtual') {
        return new Map([[manifestService.INBOUND_GROUP, {
            label: '',
            protocol: 'urltest',
            port: 0,
            transport: '',
            security: '',
        }]]);
    }

    try {
        return new Map((manifestService.describeNodeInbounds(node) || []).map((inbound) => [
            inbound.inboundId,
            {
                label: inbound.label || '',
                protocol: inbound.protocol || '',
                port: inbound.port || 0,
                portRange: inbound.portRange || '',
                transport: inbound.transport || '',
                security: inbound.security || '',
            },
        ]));
    } catch (error) {
        // Node config the subscription helpers cannot render. The series is
        // still worth showing, just without the pretty name.
        logger.debug(`[Panel] inbound metadata unavailable for node ${node._id}: ${error.message}`);
        return new Map();
    }
}

/**
 * Place a window on the grid. Windows outside the drawn range are dropped
 * rather than clamped, so a stale row cannot distort the first segment.
 */
function slotIndex(ts, grid) {
    const at = new Date(ts).getTime();
    if (!Number.isFinite(at)) return -1;
    const index = Math.floor((at - grid.gridStart) / grid.stepMs);
    if (index < 0) return -1;
    return Math.min(index, grid.slots - 1);
}

function newTransportSlot(ts) {
    return {
        ts,
        attempts: 0,
        ok: 0,
        codes: emptyCodes(),
        latencySum: 0,
        latencyCount: 0,
        latencyP95: 0,
        handshakeSum: 0,
        handshakeCount: 0,
        ttfbSum: 0,
        ttfbCount: 0,
        speedSum: 0,
        speedSamples: 0,
        speedCapped: false,
        exitIp: '',
        selectedNodeId: '',
    };
}

function finalizeTransportSlot(slot, nodeById) {
    if (!slot) return null;
    const selectedNode = slot.selectedNodeId ? nodeById.get(slot.selectedNodeId) : null;

    return {
        ts: slot.ts,
        attempts: slot.attempts,
        ok: slot.ok,
        code: slot.ok >= slot.attempts && !totalCodes(slot.codes) ? '' : dominantCode(slot.codes),
        codes: slot.codes,
        latencyP50: mean(slot.latencySum, slot.latencyCount),
        latencyP95: slot.latencyP95,
        handshakeMs: mean(slot.handshakeSum, slot.handshakeCount),
        ttfbMs: mean(slot.ttfbSum, slot.ttfbCount),
        speedBps: mean(slot.speedSum, slot.speedSamples),
        speedSamples: slot.speedSamples,
        speedCapped: slot.speedCapped,
        exitIp: slot.exitIp,
        selectedNodeId: slot.selectedNodeId,
        selectedNodeName: selectedNode?.name || '',
    };
}

/**
 * Fold windows into one entry per node, with a series per inbound and a series
 * per checklist resource, plus probe-wide and per-node aggregates.
 *
 * Every field the probe measured is carried through: the failure taxonomy is
 * what turns "something is red" into a specific action, and it is exactly what
 * the strip alone cannot say.
 */
function buildHistory({ transport, targets, nodeById, targetById, grid }) {
    const nodes = new Map();
    const inboundMeta = new Map();

    const nodeEntry = (nodeId) => {
        if (!nodes.has(nodeId)) {
            const node = nodeById.get(nodeId);
            nodes.set(nodeId, {
                nodeId,
                nodeName: node?.name || nodeId,
                nodeType: node?.type || '',
                flag: node?.flag || '',
                attempts: 0,
                ok: 0,
                codes: emptyCodes(),
                exitIp: '',
                inbounds: [],
                targets: [],
            });
            inboundMeta.set(nodeId, describeInbounds(node));
        }
        return nodes.get(nodeId);
    };

    // Slots covered by at least one transport window. Anything left uncovered
    // is time the probe reported nothing at all.
    const covered = new Array(grid.slots).fill(false);
    const speedSeries = [];

    const series = new Map();
    for (const row of transport) {
        const nodeId = String(row.nodeId);
        const key = `${nodeId}::${row.inboundId}`;

        if (!series.has(key)) {
            const entryNode = nodeEntry(nodeId);
            const meta = inboundMeta.get(nodeId)?.get(row.inboundId);
            const entry = {
                inboundId: row.inboundId,
                inboundTag: row.inboundTag || '',
                label: meta?.label || '',
                protocol: meta?.protocol || '',
                port: meta?.port || 0,
                portRange: meta?.portRange || '',
                transport: meta?.transport || '',
                security: meta?.security || '',
                attempts: 0,
                ok: 0,
                codes: emptyCodes(),
                latencySum: 0,
                latencyCount: 0,
                latencyP95: 0,
                handshakeSum: 0,
                handshakeCount: 0,
                ttfbSum: 0,
                ttfbCount: 0,
                speedBps: 0,
                speedBpsMax: 0,
                speedSamples: 0,
                speedCapped: false,
                speedValues: [],
                speedPoints: [],
                speedLastAt: null,
                exitIp: '',
                slots: new Array(grid.slots).fill(null),
            };
            series.set(key, entry);
            entryNode.inbounds.push(entry);
        }

        const entry = series.get(key);
        const index = slotIndex(row.ts, grid);
        if (index < 0) continue;

        entry.attempts += row.attempts || 0;
        entry.ok += row.ok || 0;
        addCodes(entry.codes, row.codes);
        if (row.latencyP50) { entry.latencySum += row.latencyP50; entry.latencyCount++; }
        if (row.latencyP95) entry.latencyP95 = Math.max(entry.latencyP95, row.latencyP95);
        if (row.handshakeMs) { entry.handshakeSum += row.handshakeMs; entry.handshakeCount++; }
        if (row.ttfbMs) { entry.ttfbSum += row.ttfbMs; entry.ttfbCount++; }
        if (row.exitIp) entry.exitIp = row.exitIp;

        // Throughput is sampled round-robin under a daily budget, so most
        // windows carry no measurement. Zeros are excluded everywhere: folded
        // into an average they would report a healthy node as barely moving.
        if (row.speedSamples > 0 && row.speedBps > 0) {
            entry.speedBpsMax = Math.max(entry.speedBpsMax, row.speedBpsMax || row.speedBps);
            entry.speedSamples += row.speedSamples;
            entry.speedValues.push(row.speedBps);
            entry.speedCapped = entry.speedCapped || !!row.speedCapped;
            entry.speedPoints.push({
                ts: row.ts,
                speedBps: row.speedBps,
                samples: row.speedSamples,
                capped: !!row.speedCapped,
            });
            entry.speedLastAt = row.ts;
        }

        if (!entry.slots[index]) {
            entry.slots[index] = newTransportSlot(new Date(grid.gridStart + index * grid.stepMs));
        }
        const slot = entry.slots[index];
        slot.attempts += row.attempts || 0;
        slot.ok += row.ok || 0;
        addCodes(slot.codes, row.codes);
        if (row.latencyP50) { slot.latencySum += row.latencyP50; slot.latencyCount++; }
        if (row.latencyP95) slot.latencyP95 = Math.max(slot.latencyP95, row.latencyP95);
        if (row.handshakeMs) { slot.handshakeSum += row.handshakeMs; slot.handshakeCount++; }
        if (row.ttfbMs) { slot.ttfbSum += row.ttfbMs; slot.ttfbCount++; }
        if (row.speedSamples > 0 && row.speedBps > 0) {
            slot.speedSum += row.speedBps * row.speedSamples;
            slot.speedSamples += row.speedSamples;
            slot.speedCapped = slot.speedCapped || !!row.speedCapped;
        }
        if (row.exitIp) slot.exitIp = row.exitIp;
        if (row.selectedNodeId) slot.selectedNodeId = String(row.selectedNodeId);

        if (row.attempts > 0) covered[index] = true;
    }

    const targetSeries = new Map();
    for (const row of targets) {
        const nodeId = String(row.nodeId);
        const key = `${nodeId}::${row.targetId}`;

        if (!targetSeries.has(key)) {
            const definition = targetById.get(String(row.targetId));
            const entry = {
                targetId: row.targetId,
                url: definition?.url || '',
                label: definition?.label || '',
                attempts: 0,
                ok: 0,
                blocked: 0,
                httpStatus: 0,
                latencySum: 0,
                latencyCount: 0,
                lastError: '',
                slots: new Array(grid.slots).fill(null),
            };
            targetSeries.set(key, entry);
            nodeEntry(nodeId).targets.push(entry);
        }

        const entry = targetSeries.get(key);
        const index = slotIndex(row.ts, grid);
        if (index < 0) continue;

        entry.attempts += row.attempts || 0;
        entry.ok += row.ok || 0;
        entry.blocked += row.blocked || 0;
        if (row.httpStatus) entry.httpStatus = row.httpStatus;
        if (row.latencyMs) { entry.latencySum += row.latencyMs; entry.latencyCount++; }
        if (row.lastError) entry.lastError = row.lastError;

        if (!entry.slots[index]) {
            entry.slots[index] = {
                ts: new Date(grid.gridStart + index * grid.stepMs),
                attempts: 0,
                ok: 0,
                blocked: 0,
                httpStatus: 0,
                latencySum: 0,
                latencyCount: 0,
                lastError: '',
            };
        }
        const slot = entry.slots[index];
        slot.attempts += row.attempts || 0;
        slot.ok += row.ok || 0;
        slot.blocked += row.blocked || 0;
        if (row.httpStatus) slot.httpStatus = row.httpStatus;
        if (row.latencyMs) { slot.latencySum += row.latencyMs; slot.latencyCount++; }
        if (row.lastError) slot.lastError = row.lastError;
    }

    const summary = {
        attempts: 0,
        ok: 0,
        codes: emptyCodes(),
        latencySum: 0,
        latencyWeight: 0,
        latencyP95: 0,
        handshakeSum: 0,
        handshakeCount: 0,
        ttfbSum: 0,
        ttfbCount: 0,
        speedValues: [],
        speedBpsMax: 0,
        speedSamples: 0,
        speedCapped: false,
        nodesTotal: 0,
        nodesFailing: 0,
        targetsTotal: 0,
        targetsBlocked: 0,
    };

    const list = [];
    for (const node of nodes.values()) {
        for (const inbound of node.inbounds) {
            node.attempts += inbound.attempts;
            node.ok += inbound.ok;
            addCodes(node.codes, inbound.codes);
            if (inbound.exitIp) node.exitIp = inbound.exitIp;

            summary.attempts += inbound.attempts;
            summary.ok += inbound.ok;
            addCodes(summary.codes, inbound.codes);
            summary.latencySum += inbound.latencySum;
            summary.latencyWeight += inbound.latencyCount;
            summary.latencyP95 = Math.max(summary.latencyP95, inbound.latencyP95);
            summary.handshakeSum += inbound.handshakeSum;
            summary.handshakeCount += inbound.handshakeCount;
            summary.ttfbSum += inbound.ttfbSum;
            summary.ttfbCount += inbound.ttfbCount;
            // The headline number is the median of every reading taken, not the
            // best one: a drop has to stay visible instead of hiding behind the
            // luckiest measurement of the period.
            summary.speedValues.push(...inbound.speedValues);
            summary.speedBpsMax = Math.max(summary.speedBpsMax, inbound.speedBpsMax);
            summary.speedSamples += inbound.speedSamples;
            summary.speedCapped = summary.speedCapped || inbound.speedCapped;

            inbound.speedBps = median(inbound.speedValues);

            if (inbound.speedSamples > 0) {
                speedSeries.push({
                    nodeId: node.nodeId,
                    nodeName: node.nodeName,
                    inboundId: inbound.inboundId,
                    label: inbound.label,
                    protocol: inbound.protocol,
                    inboundTag: inbound.inboundTag,
                    maxBps: inbound.speedBpsMax,
                    medianBps: inbound.speedBps,
                    samples: inbound.speedSamples,
                    capped: inbound.speedCapped,
                    lastAt: inbound.speedLastAt,
                    points: inbound.speedPoints,
                });
            }

            inbound.uptimePct = uptimePct(inbound.ok, inbound.attempts);
            inbound.worstCode = dominantCode(inbound.codes);
            inbound.latencyP50 = mean(inbound.latencySum, inbound.latencyCount);
            inbound.handshakeMs = mean(inbound.handshakeSum, inbound.handshakeCount);
            inbound.ttfbMs = mean(inbound.ttfbSum, inbound.ttfbCount);
            inbound.points = inbound.slots.map((slot) => finalizeTransportSlot(slot, nodeById));

            delete inbound.slots;
            delete inbound.latencySum;
            delete inbound.latencyCount;
            delete inbound.handshakeSum;
            delete inbound.handshakeCount;
            delete inbound.ttfbSum;
            delete inbound.ttfbCount;
            delete inbound.speedValues;
            delete inbound.speedPoints;
        }

        for (const target of node.targets) {
            summary.targetsTotal++;
            if (target.blocked > 0) summary.targetsBlocked++;

            target.uptimePct = uptimePct(target.ok, target.attempts);
            target.latencyMs = mean(target.latencySum, target.latencyCount);
            target.points = target.slots.map((slot) => (slot ? {
                ts: slot.ts,
                attempts: slot.attempts,
                ok: slot.ok,
                blocked: slot.blocked,
                httpStatus: slot.httpStatus,
                latencyMs: mean(slot.latencySum, slot.latencyCount),
                lastError: slot.lastError,
            } : null));

            delete target.slots;
            delete target.latencySum;
            delete target.latencyCount;
        }

        node.uptimePct = uptimePct(node.ok, node.attempts);
        node.worstCode = dominantCode(node.codes);
        node.failures = Math.max(node.attempts - node.ok, 0);

        summary.nodesTotal++;
        if (node.failures > 0 || node.worstCode) summary.nodesFailing++;

        list.push(node);
    }

    // Worst first: a list sorted by name buries the one node that needs
    // attention among a dozen healthy ones.
    list.sort((a, b) => {
        const left = a.uptimePct === null ? 101 : a.uptimePct;
        const right = b.uptimePct === null ? 101 : b.uptimePct;
        if (left !== right) return left - right;
        if (b.failures !== a.failures) return b.failures - a.failures;
        return a.nodeName.localeCompare(b.nodeName);
    });

    // Slowest first: the point of the block is spotting the node that sagged.
    speedSeries.sort((a, b) => a.medianBps - b.medianBps);

    const gapSlots = covered.filter((hit) => !hit).length;

    return {
        summary: {
            attempts: summary.attempts,
            ok: summary.ok,
            uptimePct: uptimePct(summary.ok, summary.attempts),
            codes: summary.codes,
            failures: Math.max(summary.attempts - summary.ok, 0),
            latencyP50: mean(summary.latencySum, summary.latencyWeight),
            latencyP95: summary.latencyP95,
            handshakeMs: mean(summary.handshakeSum, summary.handshakeCount),
            ttfbMs: mean(summary.ttfbSum, summary.ttfbCount),
            speedBps: median(summary.speedValues),
            speedBpsMax: summary.speedBpsMax,
            speedSamples: summary.speedSamples,
            speedCapped: summary.speedCapped,
            nodesTotal: summary.nodesTotal,
            nodesFailing: summary.nodesFailing,
            targetsTotal: summary.targetsTotal,
            targetsBlocked: summary.targetsBlocked,
            gapSlots,
            gapMs: gapSlots * grid.stepMs,
        },
        nodes: list,
        speed: speedSeries,
    };
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
