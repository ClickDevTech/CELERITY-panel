/**
 * SNI scan target resolution (no network).
 *
 * Verifies:
 *   - a public IPv4 is passed through in canonical form,
 *   - a hostname is resolved to IPv4 through dns.lookup (family 4),
 *   - private, CGNAT, loopback, link-local and multicast targets are refused,
 *     whether typed directly or reached through DNS (including leading-zero
 *     forms that net.isIP would not recognise),
 *   - lookup failures and slow lookups return an error instead of throwing,
 *   - malformed input is rejected before any DNS query.
 */

const assert = require('assert');
const Module = require('module');

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

const lookups = [];
let dnsTable = {};

const fakeDns = {
    promises: {
        lookup(host, opts) {
            lookups.push({ host, family: opts && opts.family });
            const entry = dnsTable[host];
            if (entry === 'hang') return new Promise(() => {});
            if (!entry) {
                const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
                err.code = 'ENOTFOUND';
                return Promise.reject(err);
            }
            return Promise.resolve({ address: entry, family: 4 });
        },
    },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'dns' && normalizePath(parent?.filename).endsWith('/src/services/sniScanner.js')) {
        return fakeDns;
    }
    return originalLoad(request, parent, isMain);
};

const { resolveScanIp } = require('../src/services/sniScanner');
const { isPrivateIp } = require('../src/utils/netAddress');
Module._load = originalLoad;

(async () => {
    // isPrivateIp coverage
    for (const ip of ['10.1.2.3', '127.0.0.1', '0.0.0.0', '100.64.0.1', '100.127.255.254', '172.16.0.1',
        '172.31.255.1', '192.168.1.1', '169.254.1.1', '224.0.0.1', '255.255.255.255',
        '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
        assert.ok(isPrivateIp(ip), `${ip} is private/reserved`);
    }
    for (const ip of ['8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '203.0.113.10',
        '2001:db8::1', '::ffff:8.8.8.8']) {
        assert.ok(!isPrivateIp(ip), `${ip} is public`);
    }

    // Public IPv4 passes through without DNS.
    assert.deepStrictEqual(await resolveScanIp(' 203.0.113.10 '), { ip: '203.0.113.10' });
    assert.deepStrictEqual(await resolveScanIp('203.000.113.010'), { ip: '203.0.113.10' }, 'canonical form');
    assert.strictEqual(lookups.length, 0, 'no DNS query for an IPv4');

    // Private IPv4 typed directly, including the leading-zero bypass attempt.
    for (const ip of ['192.168.1.1', '010.0.0.1', '127.0.0.1', '100.64.1.1', '224.0.0.1']) {
        const res = await resolveScanIp(ip);
        assert.ok(res.error && /private or reserved/.test(res.error), `${ip} refused`);
    }

    // Hostname resolved to a public IPv4.
    dnsTable = { 'node.example.net': '198.51.100.7', 'inside.example.net': '10.0.0.5', 'lo.example.net': '127.0.0.1' };
    assert.deepStrictEqual(await resolveScanIp('Node.Example.NET'), { ip: '198.51.100.7' });
    assert.deepStrictEqual(lookups[lookups.length - 1], { host: 'node.example.net', family: 4 });

    // Hostname pointing inwards.
    for (const host of ['inside.example.net', 'lo.example.net']) {
        const res = await resolveScanIp(host);
        assert.ok(res.error && /private or reserved/.test(res.error), `${host} refused`);
    }

    // Lookup failure.
    const missing = await resolveScanIp('missing.example.net');
    assert.ok(missing.error && /Cannot resolve missing\.example\.net/.test(missing.error));

    // Slow lookup is capped.
    dnsTable['slow.example.net'] = 'hang';
    const started = Date.now();
    const slow = await resolveScanIp('slow.example.net', { timeoutMs: 50 });
    assert.ok(slow.error && /timed out/.test(slow.error));
    assert.ok(Date.now() - started < 2000, 'timeout honoured');

    // Malformed input never reaches DNS.
    const before = lookups.length;
    for (const bad of ['', '   ', 'localhost', '*.example.com', 'a b.example.com', 'x;rm -rf.example.com',
        '1.2.3.256', `${'a'.repeat(250)}.com`, null, undefined]) {
        const res = await resolveScanIp(bad);
        assert.ok(res.error, `${JSON.stringify(bad)} rejected`);
    }
    assert.strictEqual(lookups.length, before, 'malformed input is not looked up');

    console.log('test-sni-resolve: OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
