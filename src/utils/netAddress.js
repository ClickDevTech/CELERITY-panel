'use strict';

/**
 * Address classification shared by the SNI scanner and Reality Guard.
 * Pure functions without I/O, safe to require from any module.
 */

const net = require('net');

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Strict hostname check for untrusted values (certificates, form input).
 * Rejects wildcards, IPs, single labels and anything outside [a-z0-9.-].
 */
function isValidHostname(value) {
    return typeof value === 'string' && HOSTNAME_RE.test(value.toLowerCase());
}

/**
 * True for addresses that must never be probed from the panel: loopback,
 * RFC 1918, CGNAT (100.64.0.0/10), link-local, "this network" and
 * multicast/reserved (224.0.0.0/3), plus their IPv6 counterparts.
 */
function isPrivateIp(host) {
    const version = net.isIP(host);
    if (version === 4) {
        const [a, b] = host.split('.').map(Number);
        return a === 127 || a === 10 || a === 0
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 169 && b === 254)
            || a >= 224;
    }
    if (version === 6) {
        const lower = host.toLowerCase();
        const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateIp(mapped[1]);
        return lower === '::1' || lower === '::'
            || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
    }
    return false;
}

module.exports = { HOSTNAME_RE, isValidHostname, isPrivateIp };
