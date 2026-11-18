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
const nodeConfigFields = require('./nodeConfigFields');
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

function invalidateNodesCache() {
    return require('../utils/helpers').invalidateNodesCache();
}

// config_patch validates the final state with the panel form rules, so it
// needs the whole node, including the manual TLS key the form check reads.
const PATCH_NODE_SELECT = '+xray.manualKey';
const REALITY_GUARD_KEYS = new Set(['realityDest', 'realitySni']);

function nodeReadiness(node) {
    const nodeId = String(node._id);
    if (node.active === false) return 'Node is disabled';
    if (isServerlessNode(node)) return 'This node type has no remote service';
    if (node.cascadeRole === 'bridge') return 'Bridge nodes are configured by cascade links';
    const hasSsh = !!(node.ssh?.password || node.ssh?.privateKey);
    const hasAgent = node.type === 'xray' && !!node.xray?.agentToken;
    if (!hasSsh && !hasAgent) return 'Neither SSH nor agent is configured';
    if (nodeSetupLock.holder(nodeId)) return `Node is busy: ${nodeSetupLock.holder(nodeId)} is running`;
    return null;
}

/**
 * Plan a patch on one node and check the resulting node with the same rules
 * as the node form, plus every CDN front that points at it.
 * @returns {{ reason: string|null, plan: Object, next: Object|null }}
 */
function evaluatePatch(node, patch, dependents = []) {
    const plan = nodeConfigFields.planNodePatch(node, patch);
    if (plan.reason) return { reason: plan.reason, plan, next: null };
    const next = nodeConfigFields.applyChanges(node, plan.changes);
    const helpers = require('../routes/panel/helpers');
    let error;
    if (node.type === 'xray') {
        error = helpers.validateXrayFormFields(next.xray || {}, { port: next.port, domain: next.domain, ip: next.ip })
            || require('../utils/vlessEncryption').versionError(next.xray || {}, node.xrayVersion, node.name);
    } else {
        error = helpers.validateHysteriaFormFields(next);
    }
    if (!error && node.type === 'xray' && dependents.length > 0) {
        const { checkCdnOriginCompat } = require('../utils/cdnConfig');
        const origin = { type: 'xray', name: node.name, active: node.active !== false, xray: next.xray };
        for (const dependent of dependents) {
            const result = checkCdnOriginCompat(dependent.cdn || {}, origin, { allowInactive: true });
            if (result.error) {
                error = `CDN node "${dependent.name}" depends on this node: ${result.error}`;
                break;
            }
        }
    }
    return { reason: error || null, plan, next };
}

function changeSummary(changes) {
    return changes.map(change => ({ inbound: change.label, before: change.before, after: change.after }));
}

// Put back only the fields this patch wrote, and only where they still hold
// the patched value: an edit made in the meantime wins.
async function revertPatch(nodeId, changes) {
    let reverted = 0;
    for (const change of changes) {
        const extra = change.target !== 'main' && change.target !== 'node';
        const path = extra ? `xray.extraInbounds.$.${change.key}` : change.dbPath;
        const restore = change.before === null ? { $unset: { [path]: '' } } : { $set: { [path]: change.before } };
        const filter = extra
            ? { _id: nodeId, 'xray.extraInbounds': { $elemMatch: { id: change.target, [change.key]: change.after } } }
            : { _id: nodeId, [change.dbPath]: change.after };
        const result = await HyNode.updateOne(filter, restore);
        reverted += result.modifiedCount || 0;
    }
    return reverted;
}

async function pushNode(node) {
    const report = {};
    try {
        const pushed = await syncService().updateNodeConfig(node, { report });
        return pushed === false ? (report.error || 'Config push failed') : null;
    } catch (error) {
        return error.message;
    }
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

    config_patch: {
        requiresReauth: true,
        concurrency: 3,
        nodeSelect: PATCH_NODE_SELECT,
        allFilterFor(params) {
            const def = nodeConfigFields.getField(String(params?.path || ''));
            if (!def) throw httpError(400, 'This field cannot be changed in bulk');
            return { type: { $in: def.nodeTypes }, active: true };
        },
        async validate(params) {
            const patch = nodeConfigFields.parsePatch(params);
            return { publicParams: nodeConfigFields.publicPatch(patch), ctx: { patch } };
        },
        async preview(nodes, ctx) {
            const ids = nodes.filter(node => node.type === 'xray').map(node => node._id);
            const dependents = ids.length > 0
                ? await HyNode.find({ type: 'cdn', 'cdn.originNode': { $in: ids } }).select('name cdn').lean()
                : [];
            const dependentsByOrigin = new Map();
            for (const dependent of dependents) {
                const key = String(dependent.cdn?.originNode || '');
                if (!dependentsByOrigin.has(key)) dependentsByOrigin.set(key, []);
                dependentsByOrigin.get(key).push(dependent);
            }
            return nodes.map((node) => {
                const nodeId = String(node._id);
                const notReady = nodeReadiness(node);
                if (notReady) return { nodeId, ready: false, reason: notReady, warnings: [] };
                const { reason, plan } = evaluatePatch(node, ctx.patch, dependentsByOrigin.get(nodeId) || []);
                const offline = !reason && node.status === 'offline';
                const warnings = [...plan.notes];
                if (offline) warnings.push('Node is offline');
                return {
                    nodeId,
                    ready: !reason,
                    reason,
                    warnings,
                    deferred: offline,
                    changes: reason ? [] : changeSummary(plan.changes),
                };
            });
        },
        async run(nodeId, ctx) {
            const doc = await HyNode.findById(nodeId).select(PATCH_NODE_SELECT);
            if (!doc) return { ok: false, skipped: true, error: 'Node not found' };
            const node = doc.toObject();
            const notReady = nodeReadiness(node);
            if (notReady) return { ok: false, skipped: true, error: notReady };
            const dependents = node.type === 'xray'
                ? await HyNode.find({ type: 'cdn', 'cdn.originNode': doc._id }).select('name cdn').lean()
                : [];
            const { reason, plan, next } = evaluatePatch(node, ctx.patch, dependents);
            if (reason) return { ok: false, skipped: true, error: reason };

            for (const change of plan.changes) doc.set(change.dbPath, change.after);
            if (plan.changes.some(change => REALITY_GUARD_KEYS.has(change.key))) {
                const { mergeRealityGuard } = require('../routes/panel/helpers');
                doc.set('xray.realityGuard', mergeRealityGuard(node.xray || {}, next.xray || {}));
            }
            await doc.save();
            await invalidateNodesCache();

            const pushError = await pushNode(doc);
            if (!pushError) return { ok: true, details: { changed: plan.changes.length } };

            // Nothing reached the node when it was busy; otherwise restore the
            // previous config there too.
            const busy = /^Node is busy:/.test(pushError);
            const reverted = await revertPatch(doc._id, plan.changes);
            await invalidateNodesCache();
            let configRestored = false;
            if (!busy && reverted > 0) {
                const restored = await HyNode.findById(nodeId);
                configRestored = !!restored && (await pushNode(restored)) === null;
            }
            logger.warn(`[Bulk] config_patch ${ctx.patch.path} on ${node.name} failed: ${pushError}; `
                + `reverted ${reverted}/${plan.changes.length} field(s), config restored: ${configRestored}`);
            return {
                ok: false,
                skipped: busy,
                error: pushError,
                details: { rolledBack: reverted === plan.changes.length, configRestored },
            };
        },
        progress() {
            return 'config';
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

async function allNodeIds(action, params = {}) {
    const def = getAction(action);
    const filter = def.allFilterFor ? def.allFilterFor(params) : def.allFilter;
    const nodes = await HyNode.find(filter).select('_id').limit(MAX_NODES).lean();
    return nodes.map(node => String(node._id));
}

async function buildPreview(action, nodeIds, params) {
    const def = getAction(action);
    const ids = normalizeNodeIds(nodeIds);
    const { publicParams, ctx } = await def.validate(params || {});
    const nodes = await HyNode.find({ _id: { $in: ids } }).select(def.nodeSelect || NODE_SELECT).lean();
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
            ...(verdict.changes ? { changes: verdict.changes } : {}),
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
