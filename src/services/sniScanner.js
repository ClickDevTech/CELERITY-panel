'use strict';

/**
 * SNI Scanner — finds TLS 1.3 + H2 hosts suitable for Xray Reality SNI.
 * Uses only Node.js built-in modules (tls, dns).
 */

const tls = require('tls');
const dns = require('dns').promises;
const { isValidHostname, isPrivateIp } = require('../utils/netAddress');

// Hard cap: only scan /24 subnets (254 hosts) to keep it lightweight
const MAX_PREFIX = 24;
const RESOLVE_TIMEOUT_MS = 3000;

// ── IP helpers ────────────────────────────────────────────────────────────────

function ipToInt(ip) {
    return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function intToIp(n) {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

function isValidIpv4(ip) {
    if (typeof ip !== 'string') return false;
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every(p => /^\d{1,3}$/.test(p) && parseInt(p, 10) <= 255);
}

/**
 * Turn a scan target (IPv4 or hostname, e.g. the node address field) into a
 * public IPv4 to scan. Private and reserved ranges are refused so a hostname
 * pointing inwards cannot make the panel sweep its own network.
 * Never throws.
 *
 * @param {string} host
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=3000] - DNS lookup cap
 * @returns {Promise<{ip: string}|{error: string}>}
 */
async function resolveScanIp(host, { timeoutMs = RESOLVE_TIMEOUT_MS } = {}) {
    const value = String(host || '').trim().toLowerCase();
    if (!value) return { error: 'Address is empty' };

    let ip;
    if (isValidIpv4(value)) {
        // Canonical form: net.isIP rejects leading zeros, which would let
        // "010.0.0.1" slip past the private-range check.
        ip = value.split('.').map(Number).join('.');
    } else if (isValidHostname(value)) {
        let timer;
        try {
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
            });
            ({ address: ip } = await Promise.race([dns.lookup(value, { family: 4 }), timeout]));
        } catch (err) {
            return {
                error: err.message === 'timeout'
                    ? `DNS lookup for ${value} timed out`
                    : `Cannot resolve ${value} to an IPv4 address`,
            };
        } finally {
            clearTimeout(timer);
        }
    } else {
        return { error: 'Not a valid IPv4 address or hostname' };
    }

    if (!isValidIpv4(ip) || isPrivateIp(ip)) {
        return { error: `${ip} is a private or reserved address and cannot be scanned` };
    }
    return { ip };
}

/** Derive the /24 CIDR from any IP in that subnet. */
function ipToCidr24(ip) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/** Expand a CIDR to an array of usable host IPs. Prefix is capped at MAX_PREFIX. */
function expandCidr(cidr) {
    const [base, bits = '24'] = cidr.split('/');
    const prefix  = Math.max(parseInt(bits, 10), MAX_PREFIX);
    const mask    = (~0 << (32 - prefix)) >>> 0;
    const network = ipToInt(base) & mask;
    const count   = Math.pow(2, 32 - prefix);
    const ips     = [];
    for (let i = 1; i < count - 1; i++) ips.push(intToIp((network + i) >>> 0));
    return ips;
}

// ── Domain quality filter ─────────────────────────────────────────────────────

const SKIP_DOMAIN_PATTERNS = [
    /traefik/i,
    /^[\d.]+$/,           // plain IP as domain
    /localhost/i,
];

const SKIP_ISSUER_PATTERNS = [
    /TRAEFIK DEFAULT CERT/i,
];

function isDomainUsable(domain, issuer) {
    if (!domain || !domain.includes('.')) return false;
    if (SKIP_DOMAIN_PATTERNS.some(r => r.test(domain))) return false;
    if (SKIP_ISSUER_PATTERNS.some(r => r.test(issuer))) return false;
    // Filter out obvious self-signed certs: issuer CN matches domain exactly
    return true;
}

// ── TLS probe ─────────────────────────────────────────────────────────────────

/**
 * Connect to host:port and check for TLS 1.3 + ALPN h2.
 * Returns a result object on success, or null if the host is not feasible.
 *
 * @param {string} ip
 * @param {number} [port=443]
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{ip, domain, issuer, ping}|null>}
 */
function probeHost(ip, port = 443, timeoutMs = 5000) {
    return new Promise(resolve => {
        const start = Date.now();

        const socket = tls.connect({
            host: ip,
            port,
            rejectUnauthorized: false,
            ALPNProtocols: ['h2', 'http/1.1'],
            minVersion: 'TLSv1.3',
            maxVersion: 'TLSv1.3',
            timeout: timeoutMs,
        });

        socket.setTimeout(timeoutMs);

        socket.on('secureConnect', () => {
            const ping   = Date.now() - start;
            const proto  = socket.getProtocol();
            const alpn   = socket.alpnProtocol;
            const cert   = socket.getPeerCertificate();
            socket.destroy();

            if (proto !== 'TLSv1.3' || alpn !== 'h2') return resolve(null);

            let domain = null;

            // Prefer Subject Alternative Names (SANs) over CN
            if (cert?.subjectaltname) {
                const sans = cert.subjectaltname
                    .split(', ')
                    .filter(s => s.startsWith('DNS:'))
                    .map(s => s.slice(4))
                    .filter(s => !s.startsWith('*')); // skip wildcards
                domain = sans[0] || null;
            }

            if (!domain && cert?.subject?.CN) {
                const cn = cert.subject.CN;
                if (!cn.includes(' ') && cn.includes('.')) domain = cn;
            }

            const issuer = cert?.issuer?.O || cert?.issuer?.CN || 'unknown';

            if (!isDomainUsable(domain, issuer)) return resolve(null);

            resolve({ ip, domain, issuer, ping });
        });

        socket.on('error',   () => { socket.destroy(); resolve(null); });
        socket.on('timeout', () => { socket.destroy(); resolve(null); });
    });
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runPool(tasks, concurrency, signal) {
    let idx = 0;

    async function worker() {
        while (idx < tasks.length) {
            if (signal?.aborted) return;
            const i = idx++;
            await tasks[i]();
        }
    }

    const slots = Math.min(concurrency, tasks.length);
    await Promise.all(Array.from({ length: slots }, worker));
}

// ── DNS verification ──────────────────────────────────────────────────────────

/**
 * Resolve domain DNS and verify it supports TLS 1.3+H2 at its real address.
 * Returns enriched result or null if domain is unreachable/doesn't pass TLS check.
 *
 * @param {{ip, domain, issuer, ping}} candidate - Result from probeHost
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<object|null>}
 */
async function verifyDomain(candidate, port, timeoutMs) {
    // The /24 prefix of the originally scanned IP
    const subnetPrefix = candidate.ip.split('.').slice(0, 3).join('.');

    let resolvedIp;
    try {
        const { address } = await dns.lookup(candidate.domain, { family: 4 });
        resolvedIp = address;
    } catch {
        return null;
    }

    // Resolved IP must stay within the same /24 subnet we scanned.
    // Domains that resolve to a completely different network (CDN certs,
    // shared-hosting artifacts, etc.) are not useful as Reality neighbors.
    const resolvedPrefix = resolvedIp.split('.').slice(0, 3).join('.');
    if (resolvedPrefix !== subnetPrefix) return null;

    // If DNS points to the exact same IP we already probed — already verified
    if (resolvedIp === candidate.ip) {
        return { ...candidate, dnsMatch: true };
    }

    // DNS points to a different host within the same /24 — probe it too
    const realResult = await probeHost(resolvedIp, port, timeoutMs);
    if (!realResult || realResult.domain !== candidate.domain) return null;

    return { ...realResult, dnsMatch: true };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan the /24 subnet of the given IP for Reality-compatible SNI targets.
 * Each candidate is DNS-verified: the domain must resolve and its real address
 * must also pass TLS 1.3+H2 check.
 *
 * @param {object}       opts
 * @param {string}       opts.ip          - Any IP in the target /24
 * @param {number}       [opts.port=443]
 * @param {number}       [opts.threads=50]
 * @param {number}       [opts.timeout=5]  - Seconds per probe
 * @param {Function}     [opts.onResult]   - Called with each verified result
 * @param {Function}     [opts.onProgress] - Called with (done, total)
 * @param {AbortSignal}  [opts.signal]     - Cancellation signal
 * @returns {Promise<Array>} Results sorted by ping ascending
 */
async function scanRange({ ip, port = 443, threads = 50, timeout = 5, onResult, onProgress, onVerifying, signal } = {}) {
    const cidr    = ipToCidr24(ip);
    const hosts   = expandCidr(cidr);
    const total   = hosts.length;
    let   done    = 0;
    const results = [];

    const tasks = hosts.map(host => async () => {
        if (signal?.aborted) return;

        const candidate = await probeHost(host, port, timeout * 1000);
        done++;
        if (onProgress) onProgress(done, total);

        if (!candidate) return;

        // Verify domain resolves and is reachable at its real DNS address
        if (onVerifying) onVerifying();
        const verified = await verifyDomain(candidate, port, timeout * 1000);
        if (!verified) return;

        results.push(verified);
        if (onResult) onResult(verified);
    });

    await runPool(tasks, threads, signal);
    results.sort((a, b) => a.ping - b.ping);
    return results;
}

module.exports = { scanRange, probeHost, expandCidr, ipToCidr24, isValidIpv4, resolveScanIp };
