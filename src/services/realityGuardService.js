'use strict';

/**
 * Reality Guard — watches the Reality dest of standalone Xray nodes and
 * replaces it automatically once it stops being usable.
 *
 * A dest dies when the site behind it disappears, loses TLS 1.3 / H2 /
 * X25519 or its certificate expires or no longer covers the SNI. The node is
 * unusable for every client at that point, so the guard:
 *   1. checks every dest from the panel on a cron tick;
 *   2. after FAIL_THRESHOLD consecutive failures scans the node /24 for a
 *      replacement that passes the same strict check and is not used by any
 *      other node;
 *   3. writes the new dest/SNI, pushes the config (syncService validates it
 *      with `xray run -test` and restores the previous one on failure) and
 *      reverts the database if the push did not succeed.
 *
 * Only built-in modules are used; the scan reuses sniScanner.
 */

const tls = require('tls');
const net = require('net');

const HyNode = require('../models/hyNodeModel');
const sniScanner = require('./sniScanner');
const webhook = require('./webhookService');
const cache = require('./cacheService');
const nodeSetupLock = require('../utils/nodeSetupLock');
const logger = require('../utils/logger');

const LOG = '[Reality Guard]';

const MODES = ['auto', 'notify', 'off'];
const DEFAULT_MODE = 'auto';

const FAIL_THRESHOLD = 3;
const ROTATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// A scan that found nothing is not repeated on every tick: 254 probes per
// node every 15 minutes would be wasted work on weak hardware.
const RESCAN_INTERVAL_MS = 60 * 60 * 1000;

const CHECK_TIMEOUT_MS = 5000;
const CHECK_CONCURRENCY = 5;
const MAX_SNI_PER_DEST = 5;

const SCAN_PORT = 443;
const SCAN_THREADS = 30;
const SCAN_TIMEOUT_SEC = 5;
const MAX_CANDIDATE_CHECKS = 10;

// Circuit breaker: a mass failure means the panel network is down, not the sites.
const BREAKER_MIN_FAILED = 3;
const BREAKER_RATIO = 0.5;

const MAX_TEXT = 300;
const MAX_FAIL_COUNT = 1000;

const NODE_PROJECTION = 'name ip type status active cascadeRole '
    + 'xray.security xray.realityDest xray.realitySni xray.extraInbounds xray.realityGuard';

// ── Pure helpers ─────────────────────────────────────────────────────────────

function normalizeMode(value) {
    return MODES.includes(value) ? value : DEFAULT_MODE;
}

function clip(value) {
    return String(value || '').slice(0, MAX_TEXT);
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Strict hostname check for values coming from remote certificates.
 * Rejects wildcards, IPs, single labels and anything outside [a-z0-9.-].
 */
function isValidHostname(value) {
    return typeof value === 'string' && HOSTNAME_RE.test(value.toLowerCase());
}

function isPrivateIp(host) {
    const version = net.isIP(host);
    if (version === 4) {
        const [a, b] = host.split('.').map(Number);
        return a === 127 || a === 10 || a === 0
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 169 && b === 254);
    }
    if (version === 6) {
        const lower = host.toLowerCase();
        return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
    }
    return false;
}

/**
 * Parse a Reality dest into { host, port }. Returns null for forms the panel
 * cannot check from outside: unix sockets, bare ports (local listener),
 * loopback/private addresses (self-steal setups) and malformed values.
 */
function parseDest(dest) {
    const value = String(dest || '').trim();
    if (!value || value.startsWith('/') || value.startsWith('@')) return null;
    if (/^\d+$/.test(value)) return null;

    let host;
    let portStr;
    const v6 = value.match(/^\[([^\]]+)\]:(\d+)$/);
    if (v6) {
        host = v6[1];
        portStr = v6[2];
    } else {
        const idx = value.lastIndexOf(':');
        if (idx <= 0) return null;
        host = value.slice(0, idx);
        portStr = value.slice(idx + 1);
    }

    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    host = host.toLowerCase();
    if (host === 'localhost' || isPrivateIp(host)) return null;
    if (!net.isIP(host) && !isValidHostname(host)) return null;
    return { host, port };
}

/**
 * Group the Reality inbounds of a node by dest. Every group is checked once
 * and replaced as a whole, so inbounds sharing a dest keep sharing it.
 *
 * @returns {Array<{ key, dest, host, port, snis, inbounds }>} where inbounds
 *          holds 'main' and/or extra inbound indexes.
 */
function collectRealityTargets(xray) {
    const groups = new Map();
    const add = (inbound, ref) => {
        if (!inbound || (inbound.security || 'reality') !== 'reality') return;
        const parsed = parseDest(inbound.realityDest);
        if (!parsed) return;
        const key = `${parsed.host}:${parsed.port}`;
        let group = groups.get(key);
        if (!group) {
            group = { key, dest: key, host: parsed.host, port: parsed.port, snis: [], inbounds: [] };
            groups.set(key, group);
        }
        group.inbounds.push(ref);
        for (const sni of inbound.realitySni || []) {
            const name = String(sni || '').trim().toLowerCase();
            if (name && !group.snis.includes(name)) group.snis.push(name);
        }
    };

    add(xray || {}, 'main');
    (xray?.extraInbounds || []).forEach((extra, idx) => add(extra, idx));

    for (const group of groups.values()) {
        if (group.snis.length === 0 && !net.isIP(group.host)) group.snis.push(group.host);
        group.snis = group.snis.slice(0, MAX_SNI_PER_DEST);
    }
    return [...groups.values()];
}

function isStandaloneXray(node) {
    return node?.type === 'xray' && (!node.cascadeRole || node.cascadeRole === 'standalone');
}

/**
 * True when so many dests failed at once that the panel itself is the likely
 * cause; the tick is then discarded without touching any counter.
 */
function breakerTripped(total, failed) {
    return failed >= BREAKER_MIN_FAILED && total > 0 && failed / total >= BREAKER_RATIO;
}

/**
 * Decide what to do with a node after its dests were checked.
 *
 * @returns {{ set: Object, action: 'none'|'rotate'|'notify', cause?: string }}
 *          `set` holds the realityGuard fields that changed.
 */
function evaluateNode(node, failed, now) {
    const guard = node.xray?.realityGuard || {};
    const mode = normalizeMode(guard.mode);
    const prevStatus = guard.status || 'ok';
    const prevFails = guard.failCount || 0;
    const set = {};

    if (failed.length === 0) {
        if (prevStatus !== 'ok') set.status = 'ok';
        if (prevFails !== 0) set.failCount = 0;
        if (guard.lastError) set.lastError = '';
        return { set, action: 'none' };
    }

    const failCount = Math.min(prevFails + 1, MAX_FAIL_COUNT);
    set.failCount = failCount;
    const lastError = clip(failed.map(f => `${f.dest}: ${f.reason}`).join('; '));
    if (lastError !== guard.lastError) set.lastError = lastError;

    if (failCount < FAIL_THRESHOLD) {
        if (prevStatus !== 'failing') set.status = 'failing';
        return { set, action: 'none' };
    }

    const markDead = (cause) => {
        if (prevStatus !== 'dead' && prevStatus !== 'no_candidate') set.status = 'dead';
        const alreadyReported = prevStatus === 'dead' || prevStatus === 'no_candidate';
        return { set, action: alreadyReported ? 'none' : 'notify', cause };
    };

    if (mode === 'notify') return markDead('notify_mode');

    const lastRotatedAt = guard.lastRotatedAt ? new Date(guard.lastRotatedAt).getTime() : 0;
    if (lastRotatedAt && now - lastRotatedAt < ROTATION_COOLDOWN_MS) return markDead('cooldown');
    if (node.status === 'offline') return markDead('node_offline');

    return { set, action: 'rotate' };
}

/**
 * Domains already taken by any node or cascade link. A replacement must not
 * reuse them, otherwise one dead site takes several nodes down at once.
 */
function collectUsedDomains(nodes, links) {
    const used = new Set();
    const addDest = (dest) => {
        const parsed = parseDest(dest);
        if (parsed) used.add(parsed.host);
    };
    const addSnis = (snis) => {
        for (const sni of snis || []) {
            const name = String(sni || '').trim().toLowerCase();
            if (name) used.add(name);
        }
    };
    for (const node of nodes || []) {
        const xray = node.xray || {};
        addDest(xray.realityDest);
        addSnis(xray.realitySni);
        for (const extra of xray.extraInbounds || []) {
            addDest(extra.realityDest);
            addSnis(extra.realitySni);
        }
    }
    for (const link of links || []) {
        addDest(link.realityDest);
        addSnis(link.realitySni);
    }
    return used;
}

/**
 * Filter raw scan results down to candidates worth a strict check, best ping first.
 */
function filterScanResults(results, used, nodeIp) {
    const seen = new Set();
    return [...(results || [])]
        .sort((a, b) => (a.ping || 0) - (b.ping || 0))
        .map(r => ({ ...r, domain: String(r.domain || '').toLowerCase() }))
        .filter((r) => {
            if (!isValidHostname(r.domain)) return false;
            if (r.ip === nodeIp) return false;
            if (used.has(r.domain) || seen.has(r.domain)) return false;
            seen.add(r.domain);
            return true;
        });
}

/**
 * Build the Mongo filter/$set pair that swaps the dest of every inbound in
 * the given groups. The filter pins the old values so a concurrent manual
 * edit makes the update a no-op instead of being overwritten.
 */
function buildDestUpdate(nodeId, replacements, { revert = false } = {}) {
    const filter = { _id: nodeId };
    const set = {};
    for (const r of replacements) {
        for (const ref of r.target.inbounds) {
            const base = ref === 'main' ? 'xray' : `xray.extraInbounds.${ref}`;
            const from = revert ? r.next : r.prev[String(ref)];
            const to = revert ? r.prev[String(ref)] : r.next;
            filter[`${base}.realityDest`] = from.dest;
            set[`${base}.realityDest`] = to.dest;
            set[`${base}.realitySni`] = to.sni;
        }
    }
    return { filter, set };
}

// ── TLS check ────────────────────────────────────────────────────────────────

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME']);
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT']);

function classifyError(err) {
    const code = String(err?.code || '');
    if (DNS_CODES.has(code)) return 'dns';
    if (CONNECT_CODES.has(code)) return 'connect';
    if (code === 'CERT_HAS_EXPIRED') return 'cert_expired';
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'cert_name';
    if (/CERT|SELF_SIGNED|UNABLE_TO|DEPTH_ZERO/.test(code)) return 'cert_invalid';
    return 'tls';
}

/**
 * One strict handshake: TLS 1.3 only, X25519 only, H2 required and a
 * certificate that validates for `servername`.
 */
function tlsHandshake(host, port, servername, timeoutMs = CHECK_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;
        let socket = null;
        let timer = null;
        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (socket) socket.destroy();
            resolve(result);
        };

        timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs + 1000);
        timer.unref?.();

        try {
            socket = tls.connect({
                host,
                port,
                servername: net.isIP(servername) ? undefined : servername,
                ALPNProtocols: ['h2'],
                minVersion: 'TLSv1.3',
                maxVersion: 'TLSv1.3',
                ecdhCurve: 'X25519',
                rejectUnauthorized: true,
            });
        } catch (err) {
            done({ ok: false, reason: classifyError(err) });
            return;
        }

        socket.setTimeout(timeoutMs, () => done({ ok: false, reason: 'timeout' }));
        socket.once('secureConnect', () => {
            if (socket.getProtocol() !== 'TLSv1.3') return done({ ok: false, reason: 'tls_version' });
            if (socket.alpnProtocol !== 'h2') return done({ ok: false, reason: 'no_h2' });
            done({ ok: true });
        });
        socket.once('error', err => done({ ok: false, reason: classifyError(err) }));
    });
}

/**
 * Check a dest against every SNI it serves. `memo` dedupes identical
 * host:port|sni handshakes within one tick.
 */
async function checkDest(target, memo = new Map(), timeoutMs = CHECK_TIMEOUT_MS) {
    const names = target.snis.length ? target.snis : [target.host];
    for (const sni of names) {
        const key = `${target.host}:${target.port}|${sni}`;
        if (!memo.has(key)) memo.set(key, tlsHandshake(target.host, target.port, sni, timeoutMs));
        const result = await memo.get(key);
        if (!result.ok) return { ok: false, reason: result.reason, sni };
    }
    return { ok: true };
}

async function runLimited(items, limit, worker) {
    let idx = 0;
    const slots = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: slots }, async () => {
        while (idx < items.length) {
            const i = idx++;
            await worker(items[i]);
        }
    }));
}

// ── Notifications ────────────────────────────────────────────────────────────

function emitDead(node, failed, cause) {
    for (const f of failed) {
        webhook.emit(webhook.EVENTS.NODE_REALITY_DEST_DEAD, {
            nodeId: String(node._id),
            name: node.name,
            dest: f.dest,
            reason: f.reason,
            cause,
        });
    }
}

// ── Rotation ─────────────────────────────────────────────────────────────────

const _lastScanAt = new Map();

async function loadUsedDomains() {
    const CascadeLink = require('../models/cascadeLinkModel');
    const [nodes, links] = await Promise.all([
        HyNode.find({ type: 'xray' })
            .select('xray.realityDest xray.realitySni xray.extraInbounds.realityDest xray.extraInbounds.realitySni')
            .lean(),
        CascadeLink.find({}).select('realityDest realitySni').lean(),
    ]);
    return collectUsedDomains(nodes, links);
}

async function findReplacements(node, needed, deadHosts) {
    const used = await loadUsedDomains();
    for (const host of deadHosts) used.add(host);

    const scanned = await sniScanner.scanRange({
        ip: node.ip,
        port: SCAN_PORT,
        threads: SCAN_THREADS,
        timeout: SCAN_TIMEOUT_SEC,
    });

    const picked = [];
    const candidates = filterScanResults(scanned, used, node.ip).slice(0, MAX_CANDIDATE_CHECKS);
    for (const candidate of candidates) {
        if (picked.length >= needed) break;
        const result = await checkDest({ host: candidate.domain, port: SCAN_PORT, snis: [candidate.domain] });
        if (result.ok) picked.push(candidate.domain);
    }
    return picked;
}

async function setGuard(nodeId, fields) {
    const set = {};
    for (const [k, v] of Object.entries(fields)) set[`xray.realityGuard.${k}`] = v;
    await HyNode.updateOne({ _id: nodeId }, { $set: set });
}

/**
 * Replace the failed dests of one node. Never throws.
 */
async function rotate(node, failed) {
    const nodeId = String(node._id);
    if (!nodeSetupLock.acquire(nodeId, 'Reality dest rotation')) {
        logger.info(`${LOG} ${node.name}: busy (${nodeSetupLock.holder(nodeId)}), rotation postponed`);
        return;
    }

    try {
        const syncService = require('./syncService');
        const fresh = await HyNode.findById(nodeId);
        if (!fresh || !isStandaloneXray(fresh)) return;
        if (!fresh.ssh?.password && !fresh.ssh?.privateKey) {
            logger.warn(`${LOG} ${node.name}: no SSH credentials, cannot push a new dest`);
            await setGuard(nodeId, { status: 'dead' });
            if (node.xray?.realityGuard?.status !== 'dead') emitDead(node, failed, 'no_ssh');
            return;
        }

        // Re-resolve against the current document: the operator may have
        // fixed the dest while the tick was running.
        const current = new Map(collectRealityTargets(fresh.xray?.toObject?.() || fresh.xray).map(t => [t.key, t]));
        const targets = failed.map(f => current.get(f.key)).filter(Boolean);
        if (targets.length === 0) return;

        _lastScanAt.set(nodeId, Date.now());
        logger.info(`${LOG} ${node.name}: scanning ${node.ip}/24 for ${targets.length} replacement(s)`);
        const domains = sniScanner.isValidIpv4(node.ip)
            ? await findReplacements(node, targets.length, targets.map(t => t.host))
            : [];

        if (domains.length === 0) {
            logger.warn(`${LOG} ${node.name}: no usable replacement found`);
            const prev = fresh.xray?.realityGuard?.status;
            await setGuard(nodeId, { status: 'no_candidate' });
            await cache.invalidateNodes();
            if (prev !== 'no_candidate') emitDead(node, failed, 'no_candidate');
            return;
        }

        const xrayObj = fresh.xray?.toObject?.() || fresh.xray || {};
        const replacements = targets.slice(0, domains.length).map((target, i) => {
            const prev = {};
            for (const ref of target.inbounds) {
                const inbound = ref === 'main' ? xrayObj : xrayObj.extraInbounds[ref];
                prev[String(ref)] = { dest: inbound.realityDest, sni: [...(inbound.realitySni || [])] };
            }
            return { target, prev, next: { dest: `${domains[i]}:${SCAN_PORT}`, sni: [domains[i]] } };
        });

        const apply = buildDestUpdate(fresh._id, replacements);
        const res = await HyNode.updateOne(apply.filter, { $set: apply.set });
        if (!res.matchedCount) {
            logger.warn(`${LOG} ${node.name}: dest changed concurrently, rotation skipped`);
            return;
        }

        const updated = await HyNode.findById(nodeId);
        const report = { applied: false };
        let pushed = false;
        try {
            pushed = await syncService.updateXrayNodeConfig(updated, { lockHeld: true, report });
        } catch (err) {
            logger.error(`${LOG} ${node.name}: config push failed: ${err.message}`);
        }

        // Reverting the database while the node already runs the new dest
        // would publish the dead SNI and bring it back on the next sync.
        if (!pushed && report.applied) {
            logger.warn(`${LOG} ${node.name}: new config is running but agent health was not confirmed; keeping the new dest`);
            pushed = true;
        }

        if (!pushed) {
            const revert = buildDestUpdate(fresh._id, replacements, { revert: true });
            await HyNode.updateOne(revert.filter, { $set: revert.set });
            await setGuard(nodeId, { status: 'dead', lastError: clip('rotation rolled back: config push failed') });
            await cache.invalidateNodes();
            logger.error(`${LOG} ${node.name}: rotation rolled back`);
            if (fresh.xray?.realityGuard?.status !== 'dead') emitDead(node, failed, 'rollback');
            return;
        }

        const summary = replacements.map(r => r.target.dest).join(', ');
        const nextSummary = replacements.map(r => r.next.dest).join(', ');
        await setGuard(nodeId, {
            status: 'ok',
            failCount: 0,
            lastError: '',
            lastRotatedAt: new Date(),
            lastRotatedFrom: clip(summary),
            lastRotatedTo: clip(nextSummary),
        });
        _lastScanAt.delete(nodeId);
        const { invalidateNodesCache } = require('../utils/helpers');
        await invalidateNodesCache();

        const reasons = new Map(failed.map(f => [f.key, f.reason]));
        for (const r of replacements) {
            logger.info(`${LOG} ${node.name}: ${r.target.dest} -> ${r.next.dest} (${reasons.get(r.target.key)})`);
            webhook.emit(webhook.EVENTS.NODE_REALITY_DEST_ROTATED, {
                nodeId,
                name: node.name,
                oldDest: r.target.dest,
                newDest: r.next.dest,
                newSni: r.next.sni,
                reason: reasons.get(r.target.key) || '',
            });
        }
    } catch (err) {
        logger.error(`${LOG} ${node.name}: rotation failed: ${err.message}`);
    } finally {
        nodeSetupLock.release(nodeId);
    }
}

// ── Cron tick ────────────────────────────────────────────────────────────────

let _running = false;

async function tick(now = Date.now()) {
    const nodes = (await HyNode.find({ type: 'xray', active: true }).select(NODE_PROJECTION).lean())
        .filter(isStandaloneXray);

    const watched = [];
    const resetOps = [];
    for (const node of nodes) {
        const guard = node.xray?.realityGuard || {};
        if (normalizeMode(guard.mode) === 'off') {
            if ((guard.status && guard.status !== 'ok') || guard.failCount) {
                resetOps.push({ updateOne: {
                    filter: { _id: node._id },
                    update: { $set: { 'xray.realityGuard.status': 'ok', 'xray.realityGuard.failCount': 0, 'xray.realityGuard.lastError': '' } },
                } });
            }
            continue;
        }
        const targets = collectRealityTargets(node.xray);
        if (targets.length) watched.push({ node, targets });
    }

    // One check per unique dest across all nodes.
    const unique = new Map();
    for (const { targets } of watched) {
        for (const t of targets) {
            const known = unique.get(t.key);
            if (!known) unique.set(t.key, { ...t, snis: [...t.snis] });
            else for (const s of t.snis) if (!known.snis.includes(s)) known.snis.push(s);
        }
    }

    const memo = new Map();
    const results = new Map();
    await runLimited([...unique.values()], CHECK_CONCURRENCY, async (target) => {
        results.set(target.key, await checkDest(target, memo));
    });

    const failedTotal = [...results.values()].filter(r => !r.ok).length;
    if (breakerTripped(results.size, failedTotal)) {
        logger.warn(`${LOG} ${failedTotal}/${results.size} dests failed at once, assuming a panel network issue; tick discarded`);
        if (resetOps.length) await HyNode.bulkWrite(resetOps, { ordered: false });
        return;
    }

    const ops = [...resetOps];
    const notify = [];
    const rotations = [];
    const checkedAt = new Date(now);
    let statusChanged = resetOps.length > 0;

    for (const { node, targets } of watched) {
        const failed = [];
        for (const t of targets) {
            const r = results.get(t.key);
            if (r && !r.ok) failed.push({ key: t.key, dest: t.dest, reason: r.reason });
        }

        const decision = evaluateNode(node, failed, now);
        if ('status' in decision.set) statusChanged = true;

        const $set = { 'xray.realityGuard.lastCheckAt': checkedAt };
        for (const [k, v] of Object.entries(decision.set)) $set[`xray.realityGuard.${k}`] = v;
        ops.push({ updateOne: { filter: { _id: node._id }, update: { $set } } });

        if (decision.action === 'notify') notify.push({ node, failed, cause: decision.cause });
        if (decision.action === 'rotate') {
            const lastScan = _lastScanAt.get(String(node._id)) || 0;
            if (now - lastScan >= RESCAN_INTERVAL_MS) rotations.push({ node, failed });
        }
        if (failed.length) {
            logger.warn(`${LOG} ${node.name}: ${failed.map(f => `${f.dest} ${f.reason}`).join(', ')} (${decision.set.failCount}/${FAIL_THRESHOLD})`);
        }
    }

    if (ops.length) await HyNode.bulkWrite(ops, { ordered: false });
    if (statusChanged) await cache.invalidateNodes();

    for (const n of notify) emitDead(n.node, n.failed, n.cause);

    // Sequential on purpose: at most one /24 scan runs at a time.
    for (const r of rotations) await rotate(r.node, r.failed);
}

/**
 * Cron entry point. Never throws; overlapping ticks are skipped.
 */
async function checkAll() {
    if (_running) {
        logger.warn(`${LOG} previous tick still running, skipped`);
        return;
    }
    _running = true;
    try {
        await tick();
    } catch (err) {
        logger.error(`${LOG} tick failed: ${err.message}`);
    } finally {
        _running = false;
    }
}

module.exports = {
    checkAll,
    checkDest,
    // Exposed for tests.
    _internals: {
        MODES,
        FAIL_THRESHOLD,
        ROTATION_COOLDOWN_MS,
        normalizeMode,
        isValidHostname,
        parseDest,
        collectRealityTargets,
        isStandaloneXray,
        breakerTripped,
        evaluateNode,
        collectUsedDomains,
        filterScanResults,
        buildDestUpdate,
        classifyError,
        tick,
        rotate,
    },
};
