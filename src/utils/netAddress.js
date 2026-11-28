'use strict';

/**
 * Address classification shared by the SNI scanner, Reality Guard and
 * cascade links over IPv6. Pure functions without I/O, safe to require from
 * any module.
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

/**
 * True for a global unicast IPv6 literal (2000::/3) without a zone index.
 * Loopback, link-local, ULA, multicast and IPv4-mapped forms are rejected:
 * only such addresses are reachable between servers over the internet.
 */
function isGlobalIpv6(value) {
    if (typeof value !== 'string' || value.includes('%') || net.isIP(value) !== 6) return false;
    const first = value.toLowerCase().split(':')[0];
    if (!first) return false;
    const group = parseInt(first, 16);
    return group >= 0x2000 && group <= 0x3fff;
}

/**
 * RFC 5952 text form of an IPv6 literal (lowercase, longest zero run
 * compressed), so differently written copies of one address compare equal.
 * @returns {string} canonical form, or '' when `value` is not IPv6
 */
function canonicalIpv6(value) {
    if (typeof value !== 'string' || value.includes('%') || net.isIP(value) !== 6) return '';
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
}

/**
 * Read-only shell command listing the IPv6 addresses of a node: iproute2 on
 * Linux, ifconfig where it is missing (FreeBSD). Output feeds parseGlobalIpv6Addrs.
 */
const IPV6_ADDR_LIST_COMMAND =
    'if command -v ip >/dev/null 2>&1; then ip -6 -o addr show scope global 2>/dev/null; ' +
    'elif command -v ifconfig >/dev/null 2>&1; then ifconfig -a inet6 2>/dev/null; ' +
    'else echo NO_IP_TOOL; fi';

/**
 * Extract global IPv6 addresses from `ip -6 -o addr show` or `ifconfig`
 * output. By default temporary (privacy), deprecated, tentative and
 * failed-DAD addresses are skipped: they change or vanish and must not be
 * pinned in a tunnel config.
 * @param {string} output
 * @param {{ stableOnly?: boolean }} [opts]
 * @returns {string[]} unique canonical addresses in output order
 */
function parseGlobalIpv6Addrs(output, { stableOnly = true } = {}) {
    const found = [];
    for (const line of String(output || '').split('\n')) {
        if (stableOnly && /\b(temporary|deprecated|tentative|dadfailed)\b/.test(line)) continue;
        const match = /\binet6\s+([0-9a-fA-F:]+)(?:\/\d{1,3}\b|\s+prefixlen\b)/.exec(line);
        if (!match || !isGlobalIpv6(match[1])) continue;
        const address = canonicalIpv6(match[1]);
        if (!found.includes(address)) found.push(address);
    }
    return found;
}

/**
 * Normalize an optional node IPv6 from untrusted input.
 * @returns {{ value: string, error: string|null }} value is '' when cleared
 */
function normalizeIpv6Input(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) return { value: '', error: null };
    if (value.length > 45 || !isGlobalIpv6(value)) {
        return {
            value: '',
            error: 'IPv6 must be a public server address such as 2a01:4f8:c17:1::1 (local, link-local and IPv4 addresses are not accepted)',
        };
    }
    return { value: canonicalIpv6(value), error: null };
}

module.exports = {
    HOSTNAME_RE,
    isValidHostname,
    isPrivateIp,
    isGlobalIpv6,
    canonicalIpv6,
    IPV6_ADDR_LIST_COMMAND,
    parseGlobalIpv6Addrs,
    normalizeIpv6Input,
};
