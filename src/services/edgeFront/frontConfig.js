'use strict';

// Front entry point for the panel form, REST and MCP: adds the panel-side
// context pure validation cannot know and applies the layout the front implies.

const appConfig = require('../../../config');
const nodeSetup = require('../nodeSetup');
const {
    normalizeXrayFront,
    validateXrayFront,
    applyFrontInboundLayout,
    releaseFrontInboundLayout,
} = require('../../utils/xrayFront');

function validateFront(xray, node) {
    if (!xray?.front?.enabled) return null;
    return validateXrayFront(xray, node, {
        sameVps: nodeSetup.isSameVpsAsPanel(node || {}),
        acmeEmail: String(xray.acmeEmail || '').trim() || String(appConfig.ACME_EMAIL || '').trim(),
    });
}

// Mutates both objects: the front owns the public port, so node.port moves too.
function applyFrontLayout(xray, node, previousFront) {
    if (!xray?.front) return;
    if (xray.front.enabled) {
        applyFrontInboundLayout(xray, node);
    } else if (previousFront?.enabled) {
        // Caddy itself is stopped by the reconciler, which still sees
        // front.appliedFingerprint on the node.
        releaseFrontInboundLayout(xray, previousFront.inboundIds || []);
    }
}

// Normalize, lay out and validate in one step; returns the first error or null.
function applyFrontPatch(xray, node, previousFront) {
    if (!xray?.front) return null;
    xray.front = { ...previousFront, ...normalizeXrayFront(xray.front) };
    applyFrontLayout(xray, node, previousFront);
    return validateFront(xray, node);
}

module.exports = {
    validateFront,
    applyFrontLayout,
    applyFrontPatch,
};
