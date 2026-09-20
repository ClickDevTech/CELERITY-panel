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
function applyFrontPatch(xray, node, previousFront, rollbackState = null) {
    if (!xray?.front) return null;
    const previous = previousFront?.toObject ? previousFront.toObject() : (previousFront || {});
    xray.front = { ...previous, ...normalizeXrayFront(xray.front) };
    applyFrontLayout(xray, node, previousFront);
    attachFrontRollbackState(xray, rollbackState, previous);
    return validateFront(xray, node);
}

module.exports = {
    validateFront,
    captureFrontRollbackState,
    attachFrontRollbackState,
    applyFrontLayout,
    applyFrontPatch,
};
