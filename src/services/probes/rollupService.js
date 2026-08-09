/**
 * Probe rollups, retention and liveness
 *
 * Raw windows are kept for the configured retention, but reading a month of
 * them for a dashboard would mean aggregating a million documents on every
 * render. Hourly rollups exist as a read index for long ranges; short ranges
 * still read raw windows.
 */

const Probe = require('../../models/probeModel');
const ProbeResult = require('../../models/probeResultModel');
const ProbeTargetResult = require('../../models/probeTargetResultModel');
const webhook = require('../webhookService');
const logger = require('../../utils/logger');
const { getSettings } = require('../../utils/helpers');

function hourStart(date) {
    const d = new Date(date);
    d.setMinutes(0, 0, 0);
    return d;
}

/**
 * Aggregate raw transport windows of one hour into a single hourly document
 * per (probe, node, inbound).
 *
 * Percentiles cannot be merged exactly from pre-aggregated windows: p50 is
 * averaged over the hour and p95 takes the worst window, which is the usual
 * trade-off and keeps the rollup cheap.
 */
async function rollupTransport(from, to) {
    const rows = await ProbeResult.aggregate([
        { $match: { bucket: 'raw', ts: { $gte: from, $lt: to } } },
        {
            $group: {
                _id: { probeId: '$probeId', nodeId: '$nodeId', inboundId: '$inboundId' },
                inboundTag: { $last: '$inboundTag' },
                netFingerprint: { $last: '$netFingerprint' },
                attempts: { $sum: '$attempts' },
                ok: { $sum: '$ok' },
                netUnreachable: { $sum: '$codes.netUnreachable' },
                handshakeFailed: { $sum: '$codes.handshakeFailed' },
                authRejected: { $sum: '$codes.authRejected' },
                tunnelNoData: { $sum: '$codes.tunnelNoData' },
                degraded: { $sum: '$codes.degraded' },
                coreDown: { $sum: '$codes.coreDown' },
                latencyP50: { $avg: '$latencyP50' },
                latencyP95: { $max: '$latencyP95' },
                handshakeMs: { $avg: '$handshakeMs' },
                ttfbMs: { $avg: '$ttfbMs' },
                speedBps: { $max: '$speedBps' },
                speedSamples: { $sum: '$speedSamples' },
                exitIp: { $last: '$exitIp' },
                lastCode: { $last: '$lastCode' },
            },
        },
    ]);

    await ProbeResult.bulkUpsertWindows(rows.map((row) => ({
        key: {
            probeId: row._id.probeId,
            nodeId: row._id.nodeId,
            inboundId: row._id.inboundId,
            bucket: 'hourly',
            ts: from,
        },
        data: {
            inboundTag: row.inboundTag || '',
            netFingerprint: row.netFingerprint || '',
            attempts: row.attempts || 0,
            ok: row.ok || 0,
            codes: {
                netUnreachable: row.netUnreachable || 0,
                handshakeFailed: row.handshakeFailed || 0,
                authRejected: row.authRejected || 0,
                tunnelNoData: row.tunnelNoData || 0,
                degraded: row.degraded || 0,
                coreDown: row.coreDown || 0,
            },
            latencyP50: Math.round(row.latencyP50 || 0),
            latencyP95: Math.round(row.latencyP95 || 0),
            handshakeMs: Math.round(row.handshakeMs || 0),
            ttfbMs: Math.round(row.ttfbMs || 0),
            speedBps: row.speedBps || 0,
            speedSamples: row.speedSamples || 0,
            exitIp: row.exitIp || '',
            lastCode: row.lastCode || '',
        },
    })));

    return rows.length;
}

async function rollupTargets(from, to) {
    const rows = await ProbeTargetResult.aggregate([
        { $match: { bucket: 'raw', ts: { $gte: from, $lt: to } } },
        {
            $group: {
                _id: { probeId: '$probeId', nodeId: '$nodeId', targetId: '$targetId' },
                netFingerprint: { $last: '$netFingerprint' },
                attempts: { $sum: '$attempts' },
                ok: { $sum: '$ok' },
                blocked: { $sum: '$blocked' },
                httpStatus: { $last: '$httpStatus' },
                latencyMs: { $avg: '$latencyMs' },
                lastError: { $last: '$lastError' },
            },
        },
    ]);

    await ProbeTargetResult.bulkUpsertWindows(rows.map((row) => ({
        key: {
            probeId: row._id.probeId,
            nodeId: row._id.nodeId,
            targetId: row._id.targetId,
            bucket: 'hourly',
            ts: from,
        },
        data: {
            netFingerprint: row.netFingerprint || '',
            attempts: row.attempts || 0,
            ok: row.ok || 0,
            blocked: row.blocked || 0,
            httpStatus: row.httpStatus || 0,
            latencyMs: Math.round(row.latencyMs || 0),
            lastError: row.lastError || '',
        },
    })));

    return rows.length;
}

/**
 * Roll up the hour that just finished.
 */
async function rollupPreviousHour() {
    const settings = await getSettings();
    if (!settings?.probes?.enabled) return { transport: 0, targets: 0 };

    const to = hourStart(new Date());
    const from = new Date(to.getTime() - 60 * 60 * 1000);

    const [transport, targets] = await Promise.all([
        rollupTransport(from, to),
        rollupTargets(from, to),
    ]);

    if (transport > 0 || targets > 0) {
        logger.info(`[Probes] Hourly rollup: ${transport} transport, ${targets} target series`);
    }
    return { transport, targets };
}

/**
 * Apply retention to raw windows and hourly rollups.
 */
async function cleanup() {
    const settings = await getSettings();
    const retentionDays = settings?.probes?.retentionDays || 30;

    const [transport, targets] = await Promise.all([
        ProbeResult.cleanup(retentionDays),
        ProbeTargetResult.cleanup(retentionDays),
    ]);

    logger.info(
        `[Probes] Cleanup removed ${transport.raw + transport.hourly} transport and ` +
        `${targets.raw + targets.hourly} target documents`
    );
    return { transport, targets };
}

/**
 * Alert when a probe stops reporting. A probe is considered offline after three
 * missed report intervals, which tolerates a single failed delivery.
 */
async function checkLiveness() {
    const settings = await getSettings();
    if (!settings?.probes?.enabled) return 0;

    const reportSec = settings.probes.reportIntervalSec || 900;
    const threshold = new Date(Date.now() - reportSec * 3 * 1000);

    const stale = await Probe.find({
        active: true,
        enrolledAt: { $ne: null },
        lastSeenAt: { $lt: threshold },
        offlineNotified: false,
    }).lean();

    for (const probe of stale) {
        webhook.emit(webhook.EVENTS.PROBE_OFFLINE, {
            probeId: String(probe._id),
            probeName: probe.name,
            country: probe.country || '',
            asn: probe.asn || '',
            lastSeenAt: probe.lastSeenAt,
        });
        await Probe.updateOne({ _id: probe._id }, { $set: { offlineNotified: true } });
        logger.warn(`[Probes] Probe ${probe.name} is offline`);
    }

    // Clear the guard for probes that came back.
    await Probe.updateMany(
        { offlineNotified: true, lastSeenAt: { $gte: threshold } },
        { $set: { offlineNotified: false } }
    );

    return stale.length;
}

module.exports = {
    rollupPreviousHour,
    cleanup,
    checkLiveness,
    hourStart,
};
