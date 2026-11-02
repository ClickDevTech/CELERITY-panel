'use strict';

/**
 * Bulk actions over many nodes (panel broadcast tab and MCP).
 *
 * One batch runs at a time. The first ready node goes alone as a canary; the
 * rest follow with bounded concurrency. MAX_FAILURES failed nodes stop the
 * batch: nodes already in flight finish, queued ones are cancelled. Each
 * action reuses the existing per-node code path, so locking, rollback and
 * status bookkeeping stay in one place.
 *
 * State lives in memory, like the per-node Xray version tasks.
 */

const crypto = require('crypto');

const HyNode = require('../models/hyNodeModel');
const CascadeLink = require('../models/cascadeLinkModel');
const logger = require('../utils/logger');
const nodeSetupLock = require('../utils/nodeSetupLock');
const { mapLimit } = require('../utils/mapLimit');
const { isServerlessNode } = require('../utils/nodeTypes');
const MAX_NODES = 200;
const MAX_FAILURES = 2;
const BATCH_TTL_MS = 60 * 60 * 1000;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// Only presence of SSH secrets is needed; their values never leave this module.
const NODE_SELECT = [
    '_id', 'name', 'flag', 'type', 'status', 'active', 'cascadeRole', 'xrayVersion',
    'ssh.password', 'ssh.privateKey', 'xray.agentToken',
    'xray.vlessEncryption', 'xray.extraInbounds.vlessEncryption',
].join(' ');

let current = null;
let starting = false;

function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.expose = true;
    return error;
}

function xrayVersionService() {
    return require('./xrayVersionService');
}

function syncService() {
    return require('./syncService');
}

const ACTIONS = {
    xray_version: {
        requiresReauth: true,
        concurrency: 2,
        allFilter: { type: 'xray' },
        async validate(params) {
            const release = await xrayVersionService().getKnownRelease(params?.version);
            if (!release) throw httpError(400, 'Unknown Xray release');
            return { publicParams: { version: release.version }, ctx: { release } };
        },
        async preview(nodes, ctx) {
            const ids = nodes.map(node => node._id);
            const fields = 'name mode portalNode bridgeNode tunnelTransport tunnelProtocol tunnelSecurity priority';
            const [endpointLinks, forwardLinks] = await Promise.all([
                CascadeLink.find({
                    active: true,
                    $or: [{ portalNode: { $in: ids } }, { bridgeNode: { $in: ids } }],
                }).select(fields).lean(),
                CascadeLink.find({ mode: 'forward', active: true }).select(fields).lean(),
            ]);
            const linksByNode = new Map();
            const addLink = (nodeId, link) => {
                const key = String(nodeId);
                if (!linksByNode.has(key)) linksByNode.set(key, new Map());
                linksByNode.get(key).set(String(link._id), link);
            };
            for (const link of endpointLinks) {
                addLink(link.portalNode, link);
                addLink(link.bridgeNode, link);
            }
            // A forward-chain head carries outbounds for every downstream hop.
            const cascadeService = require('./cascadeService');
            for (const id of ids) {
                for (const link of cascadeService._walkForwardChain(forwardLinks, id)) addLink(id, link);
            }
            const nodeLinks = new Map([...linksByNode].map(([id, links]) => [id, [...links.values()]]));
            return xrayVersionService().bulkPreview(nodes, ctx.release, nodeLinks);
        },
        run(nodeId, ctx) {
            return new Promise((resolve) => {
                xrayVersionService().startVersionChange(nodeId, ctx.release.version, {
                    onFinish: task => resolve({
                        ok: task.state === 'done',
                        error: task.error || null,
                        details: {
                            fromVersion: task.currentVersion || null,
                            rollbackSucceeded: !!task.rollbackSucceeded,
                            nodeUnchanged: !!task.nodeUnchanged,
                        },
                    }),
                }).catch((error) => {
                    // Busy or incompatible at start time: nothing was touched.
                    const skipped = error.statusCode === 400 || error.statusCode === 409;
                    resolve({ ok: false, skipped, error: error.message });
                });
            });
        },
        progress(nodeId) {
            return xrayVersionService().getTaskProgress(nodeId).step;
        },
    },

    sync: {
        requiresReauth: false,
        concurrency: 3,
        allFilter: { active: true, type: { $nin: ['virtual', 'cdn'] } },
        async validate() {
            return { publicParams: {}, ctx: {} };
        },
        startGuard() {
            if (syncService().isSyncing) throw httpError(409, 'A full sync is already running');
        },
        async preview(nodes) {
            const fullSyncRunning = !!syncService().isSyncing;
            return nodes.map((node) => {
                const nodeId = String(node._id);
                const hasSsh = !!(node.ssh?.password || node.ssh?.privateKey);
                const hasAgent = node.type === 'xray' && !!node.xray?.agentToken;
                let reason = null;
                if (fullSyncRunning) reason = 'A full sync is already running';
                else if (node.active === false) reason = 'Node is disabled';
                else if (isServerlessNode(node)) reason = 'This node type has no remote service';
                else if (!hasSsh && !hasAgent) reason = 'Neither SSH nor agent is configured';
                else if (nodeSetupLock.holder(nodeId)) reason = `Node is busy: ${nodeSetupLock.holder(nodeId)} is running`;
                const warnings = [];
                // Bridges are never health-checked and always stay 'offline'.
                const offline = !reason && node.status === 'offline' && node.cascadeRole !== 'bridge';
                if (offline) warnings.push('Node is offline');
                return { nodeId, ready: !reason, reason, warnings, deferred: offline };
            });
        },
        async run(nodeId) {
            const node = await HyNode.findById(nodeId);
            if (!node) return { ok: false, skipped: true, error: 'Node not found' };
            if (node.active === false) return { ok: false, skipped: true, error: 'Node is disabled' };
            const report = {};
            try {
                const result = await syncService().updateNodeConfig(node, { report });
                if (result === false) return { ok: false, error: report.error || 'Sync failed' };
                return { ok: true };
            } catch (error) {
                if (/^Node is busy:/.test(error.message)) {
                    return { ok: false, skipped: true, error: error.message };
                }
                return { ok: false, error: error.message };
            }
        },
        progress() {
            return 'sync';
        },
    },
};

function getAction(action) {
    const def = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
    if (!def) throw httpError(400, 'Unknown bulk action');
    return def;
}

function listActions() {
    return Object.entries(ACTIONS).map(([id, def]) => ({ id, requiresReauth: def.requiresReauth }));
}

function normalizeNodeIds(nodeIds) {
    if (!Array.isArray(nodeIds)) throw httpError(400, 'nodeIds must be an array');
    const unique = [...new Set(nodeIds.map(id => String(id || '').trim()))].filter(Boolean);
    if (unique.length === 0) throw httpError(400, 'Select at least one node');
    if (unique.length > MAX_NODES) throw httpError(400, `At most ${MAX_NODES} nodes per bulk action`);
    if (!unique.every(id => OBJECT_ID_RE.test(id))) throw httpError(400, 'Invalid node id');
    return unique;
}

async function allNodeIds(action) {
    const def = getAction(action);
    const nodes = await HyNode.find(def.allFilter).select('_id').limit(MAX_NODES).lean();
    return nodes.map(node => String(node._id));
}

async function buildPreview(action, nodeIds, params) {
    const def = getAction(action);
    const ids = normalizeNodeIds(nodeIds);
    const { publicParams, ctx } = await def.validate(params || {});
    const nodes = await HyNode.find({ _id: { $in: ids } }).select(NODE_SELECT).lean();
    const byId = new Map(nodes.map(node => [String(node._id), node]));
    const verdicts = new Map((await def.preview(nodes, ctx)).map(v => [v.nodeId, v]));

    const items = ids.map((id) => {
        const node = byId.get(id);
        if (!node) {
            return { nodeId: id, name: '', flag: '', type: '', xrayVersion: null, ready: false, reason: 'Node not found', warnings: [] };
        }
        const verdict = verdicts.get(id) || { ready: false, reason: 'Not evaluated', warnings: [] };
        return {
            nodeId: id,
            name: node.name || '',
            flag: node.flag || '',
            type: node.type || '',
            xrayVersion: node.type === 'xray' ? (node.xrayVersion || null) : null,
            ready: !!verdict.ready,
            reason: verdict.reason || null,
            warnings: verdict.warnings || [],
            deferred: !!verdict.deferred,
        };
    });
    return { def, publicParams, ctx, items };
}

async function preview({ action, nodeIds, params }) {
    const { publicParams, items } = await buildPreview(action, nodeIds, params);
    return {
        action,
        params: publicParams,
        ready: items.filter(item => item.ready).length,
        skipped: items.filter(item => !item.ready).length,
        items: items.map(({ deferred, ...item }) => item),
    };
}

function isActive(batch) {
    return !!batch && !batch.finishedAt;
}

function countItems(items) {
    const counts = { total: items.length, queued: 0, running: 0, done: 0, error: 0, skipped: 0, cancelled: 0 };
    for (const item of items) counts[item.state] = (counts[item.state] || 0) + 1;
    return counts;
}

function batchState(batch) {
    if (batch.finishedAt) return batch.state;
    return batch.stopReason ? 'stopping' : 'running';
}

function requestStop(batch, reason) {
    if (!batch.stopReason) batch.stopReason = reason;
}

async function runItem(batch, def, ctx, item) {
    if (batch.stopReason) {
        item.state = 'cancelled';
        return;
    }
    item.state = 'running';
    let result;
    try {
        result = await def.run(item.nodeId, ctx);
    } catch (error) {
        result = { ok: false, error: error.message };
    }
    item.error = result.error || null;
    item.details = result.details || null;
    if (result.skipped) {
        item.state = 'skipped';
    } else if (result.ok) {
        item.state = 'done';
    } else {
        item.state = 'error';
        batch.failures += 1;
        if (batch.failures >= MAX_FAILURES) requestStop(batch, 'failures');
    }
}

async function runBatch(batch, def, ctx) {
    // Deferred (likely unreachable) nodes go last and never act as the canary.
    const queued = batch.items.filter(item => item.state === 'queued');
    const queue = queued.filter(item => !item.deferred);
    const deferred = queued.filter(item => item.deferred);
    try {
        // Canary: run one node at a time until one actually completes, so a
        // bad release or a broken action is caught on a single node.
        let index = 0;
        while (index < queue.length && !batch.stopReason) {
            const item = queue[index];
            index += 1;
            await runItem(batch, def, ctx, item);
            if (item.state === 'error') requestStop(batch, 'canary');
            if (item.state === 'done' || item.state === 'error') break;
        }
        await mapLimit(queue.slice(index), def.concurrency, item => runItem(batch, def, ctx, item));
        await mapLimit(deferred, def.concurrency, item => runItem(batch, def, ctx, item));
    } catch (error) {
        logger.error(`[Bulk] ${batch.action} batch ${batch.id} crashed: ${error.message}`);
        requestStop(batch, 'error');
        for (const item of batch.items) {
            if (item.state === 'queued') item.state = 'cancelled';
        }
    } finally {
        if (batch.stopReason === 'cancel') batch.state = 'cancelled';
        else if (batch.stopReason) batch.state = 'stopped';
        else batch.state = 'done';
        batch.finishedAt = new Date().toISOString();
        const counts = countItems(batch.items);
        logger.warn(`[Bulk] ${batch.action} batch ${batch.id} finished (${batch.state}${batch.stopReason ? `, ${batch.stopReason}` : ''}): `
            + `done=${counts.done} error=${counts.error} skipped=${counts.skipped} cancelled=${counts.cancelled}`);
        const timer = setTimeout(() => {
            if (current === batch) current = null;
        }, BATCH_TTL_MS);
        timer.unref?.();
    }
}

async function start({ action, nodeIds, params, actor }) {
    if (starting || isActive(current)) throw httpError(409, 'A bulk action is already running');
    getAction(action).startGuard?.();
    starting = true;
    try {
        const { def, publicParams, ctx, items } = await buildPreview(action, nodeIds, params);
        const ready = items.filter(item => item.ready);
        if (ready.length === 0) throw httpError(400, 'No selected node is ready for this action');

        const batch = {
            id: crypto.randomUUID(),
            action,
            params: publicParams,
            state: 'running',
            stopReason: null,
            failures: 0,
            startedBy: String(actor || 'unknown').slice(0, 100),
            startedAt: new Date().toISOString(),
            finishedAt: null,
            items: items.map(item => ({
                nodeId: item.nodeId,
                name: item.name,
                flag: item.flag,
                state: item.ready ? 'queued' : 'skipped',
                error: item.ready ? null : item.reason,
                details: null,
                warnings: item.warnings,
                deferred: item.deferred,
            })),
        };
        current = batch;
        logger.warn(`[Bulk] ${action} batch ${batch.id} started by ${batch.startedBy}: `
            + `params=${JSON.stringify(publicParams)} ready=${ready.length} skipped=${items.length - ready.length}`);
        setImmediate(() => runBatch(batch, def, ctx));
        return status();
    } finally {
        starting = false;
    }
}

function cancel(actor) {
    if (!isActive(current)) throw httpError(409, 'No bulk action is running');
    requestStop(current, 'cancel');
    logger.warn(`[Bulk] ${current.action} batch ${current.id} cancel requested by ${String(actor || 'unknown').slice(0, 100)}`);
    return status();
}

function status() {
    const batch = current;
    if (!batch) return { state: 'idle' };
    const def = ACTIONS[batch.action];
    return {
        id: batch.id,
        action: batch.action,
        params: batch.params,
        state: batchState(batch),
        stopReason: batch.stopReason,
        startedBy: batch.startedBy,
        startedAt: batch.startedAt,
        finishedAt: batch.finishedAt,
        counts: countItems(batch.items),
        items: batch.items.map(item => ({
            nodeId: item.nodeId,
            name: item.name,
            flag: item.flag,
            state: item.state,
            step: item.state === 'running' && def?.progress ? def.progress(item.nodeId) : null,
            error: item.error,
            details: item.details,
            warnings: item.warnings,
        })),
    };
}

module.exports = {
    MAX_NODES,
    MAX_FAILURES,
    listActions,
    getAction,
    allNodeIds,
    preview,
    start,
    cancel,
    status,
    _test: {
        reset() {
            current = null;
            starting = false;
        },
    },
};
