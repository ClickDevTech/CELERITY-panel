'use strict';

// Front entry point for the panel form, REST and MCP: adds the panel-side
// context pure validation cannot know and applies the layout the front implies.

const appConfig = require('../../../config');
const nodeSetup = require('../nodeSetup');
const {
    normalizeXrayFront,
    validateXrayFront,
    captureFrontInboundLayout,
    applyFrontInboundLayout,
    restoreFrontInboundLayout,
    releaseFrontInboundLayout,
} = require('../../utils/xrayFront');

function validateFront(xray, node) {
    if (!xray?.front?.enabled) return null;
    return validateXrayFront(xray, node, {
        sameVps: nodeSetup.isSameVpsAsPanel(node || {}),
        acmeEmail: String(xray.acmeEmail || '').trim() || String(appConfig.ACME_EMAIL || '').trim(),
    });
}

// Hidden front field a REST/MCP node update must load to keep the pending
// cutover baseline. siteHtml is left out: those updates never write it (see
// frontUpdatePaths). Never combine with an inclusive projection that lists
// `xray`: MongoDB rejects a parent and its child in one projection.
const FRONT_HIDDEN_SELECT = '+xray.front.rollbackSnapshot';

// The decoy page is only changed by the panel upload/reset routes.
const FRONT_UPDATE_EXCLUDED_KEYS = new Set(['siteHtml', 'siteHtmlBytes']);

// $set entries for a front written by REST/MCP. Dot-paths leave siteHtml in
// MongoDB untouched, whatever the merged front object carries.
function frontUpdatePaths(front) {
    const paths = {};
    if (!front || typeof front !== 'object') return paths;
    for (const [key, value] of Object.entries(front)) {
        if (FRONT_UPDATE_EXCLUDED_KEYS.has(key) || value === undefined) continue;
        paths[`xray.front.${key}`] = value;
    }
    return paths;
}

// Persisted until the remote cutover succeeds. The remote transaction restores
// the previous Xray/Caddy runtime; this snapshot makes MongoDB match it again.
function captureFrontRollbackState(node) {
    const plain = node?.toObject ? node.toObject() : node;
    if (!plain || plain.type !== 'xray' || !plain.xray) return null;

    const xray = { ...plain.xray };
    // A second save may arrive while the first cutover is still pending. Keep
    // the original runtime baseline instead of snapshotting an unapplied state.
    if (xray.front?.rollbackSnapshot?.xray) {
        return xray.front.rollbackSnapshot;
    }
    if (xray.front) {
        xray.front = { ...xray.front };
        delete xray.front.rollbackSnapshot;
        // A rollback keeps the current page (see rollbackFrontDatabaseState),
        // so a copy of up to 256 KB would only go stale.
        delete xray.front.siteHtml;
    }
    return {
        ip: plain.ip,
        port: plain.port,
        domain: plain.domain,
        status: plain.status,
        lastError: plain.lastError,
        xray,
    };
}

function attachFrontRollbackState(xray, rollbackState, previousFront = null) {
    if (!xray?.front || !rollbackState) return;
    const tracksRemoteFront = xray.front.enabled
        || previousFront?.enabled
        || !!previousFront?.appliedFingerprint;
    if (tracksRemoteFront) xray.front.rollbackSnapshot = rollbackState;
}

// Mutates both objects: the front owns the public port, so node.port moves too.
function applyFrontLayout(xray, node, previousFront) {
    if (!xray?.front) return;
    if (xray.front.enabled) {
        // The form persists desired state before the remote transaction runs.
        // Keep subscriptions from advertising that desired front until Caddy
        // and Xray have both committed it successfully.
        xray.front.status = 'pending';
        xray.front.lastError = '';
        if (!previousFront?.enabled) xray.front.appliedFingerprint = '';
        if (previousFront?.enabled) {
            if (!restoreFrontInboundLayout(xray, node, previousFront.layoutSnapshot)) {
                releaseFrontInboundLayout(xray, previousFront.inboundIds || []);
                if ((previousFront.inboundIds || []).includes('main')) {
                    node.port = previousFront.publicPort || node.port;
                }
            }
        }
        xray.front.layoutSnapshot = captureFrontInboundLayout(xray, node);
        applyFrontInboundLayout(xray, node);
    } else if (previousFront?.enabled) {
        // Caddy itself is stopped by the reconciler, which still sees
        // front.appliedFingerprint on the node.
        xray.front.status = 'pending';
        xray.front.lastError = '';
        if (!restoreFrontInboundLayout(xray, node, previousFront.layoutSnapshot)) {
            releaseFrontInboundLayout(xray, previousFront.inboundIds || []);
            if ((previousFront.inboundIds || []).includes('main')) {
                node.port = previousFront.publicPort || node.port;
            }
        }
    }
}

// Normalize, lay out and validate in one step; returns the first error or null.
// Fields the patch omits keep their stored values: normalizeXrayFront maps an
// absent siteMode to 'nginx', which would replace the uploaded decoy page.
function applyFrontPatch(xray, node, previousFront, rollbackState = null) {
    if (!xray?.front) return null;
    const previous = previousFront?.toObject ? previousFront.toObject() : (previousFront || {});
    xray.front = { ...previous, ...normalizeXrayFront({ ...previous, ...xray.front }) };
    applyFrontLayout(xray, node, previousFront);
    attachFrontRollbackState(xray, rollbackState, previous);
    return validateFront(xray, node);
}

module.exports = {
    FRONT_HIDDEN_SELECT,
    frontUpdatePaths,
    validateFront,
    captureFrontRollbackState,
    attachFrontRollbackState,
    applyFrontLayout,
    applyFrontPatch,
};
