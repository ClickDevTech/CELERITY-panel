'use strict';

// Rules for Xray nodes that issue their own Let's Encrypt certificate with
// acme.sh (tlsSource 'acme', no front). HTTP-01 standalone needs TCP 80 on the
// node, both for the first issue and for every renewal. Pure, so setup, the
// panel form, REST and MCP agree.

const { hasOwnTlsInbound, isLoopbackAddress } = require('./xrayFront');

const ACME_HTTP_PORT = 80;

function xrayAcmeNeedsPort80(xray = {}) {
    return xray?.tlsSource === 'acme' && !xray.front?.enabled && hasOwnTlsInbound(xray);
}

// First inbound that would take TCP 80 away from acme.sh, or null.
function findPort80Inbound(xray = {}, nodePort = 443) {
    const inbounds = [
        { label: 'main', port: nodePort || 443, listen: xray.listen },
        ...(Array.isArray(xray.extraInbounds) ? xray.extraInbounds : [])
            .filter(Boolean)
            .map(inbound => ({
                label: String(inbound.label || inbound.id || '').trim() || 'extra',
                port: inbound.port,
                listen: inbound.listen,
            })),
    ];
    return inbounds.find(inbound => Number(inbound.port) === ACME_HTTP_PORT
        && !isLoopbackAddress(inbound.listen || '0.0.0.0')) || null;
}

/**
 * Validate the final node state for acme.sh. Returns an error or null.
 * @param {Object} xray - final xray block
 * @param {Object} node - final node fields (`port`)
 * @param {{ sameVps?: boolean }} context - whether the node runs on the panel server
 * @returns {string|null}
 */
function validateXrayAcme(xray, node = {}, { sameVps = false } = {}) {
    if (!xrayAcmeNeedsPort80(xray)) return null;
    if (sameVps) {
        return "Let's Encrypt (tlsSource 'acme') cannot run on the panel server: "
            + "port 80 belongs to the panel's Caddy. Use the panel certificate or move the node to another server.";
    }
    const busy = findPort80Inbound(xray, node.port);
    if (busy) {
        return `Inbound "${busy.label}" listens on port 80, which acme.sh needs to issue and renew `
            + "the Let's Encrypt certificate. Move the inbound to another port.";
    }
    return null;
}

module.exports = {
    ACME_HTTP_PORT,
    xrayAcmeNeedsPort80,
    findPort80Inbound,
    validateXrayAcme,
};
