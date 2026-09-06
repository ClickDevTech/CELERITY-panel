const assert = require('assert');
const dns = require('dns').promises;
const {
    addressesFromDohResponse,
    discoverCdnAddresses,
} = require('../src/services/cdnDiscoveryService');

async function run() {
    assert.deepStrictEqual(addressesFromDohResponse({
        Answer: [
            { type: 5, data: 'edge.example.net.' },
            { type: 1, data: '192.0.2.10' },
            { type: 28, data: '2001:db8::10' },
            { type: 1, data: 'not-an-ip' },
        ],
    }), ['192.0.2.10', '2001:db8::10']);

    const originalResolve4 = dns.resolve4;
    const originalResolve6 = dns.resolve6;
    const originalFetch = global.fetch;

    dns.resolve4 = async () => ['192.0.2.1'];
    dns.resolve6 = async () => ['2001:db8::1'];
    global.fetch = async (url) => {
        const text = String(url);
        const ipv6 = /(?:[?&]type=AAAA)(?:&|$)/.test(text);
        const providerAddress = text.includes('dns.google')
            ? (ipv6 ? '2001:db8::2' : '192.0.2.2')
            : (ipv6 ? '2001:db8::1' : '192.0.2.1');
        return {
            ok: true,
            json: async () => ({
                Answer: [{ type: ipv6 ? 28 : 1, data: providerAddress }],
            }),
        };
    };

    try {
        const result = await discoverCdnAddresses('cdn.example.com');
        assert.deepStrictEqual(result.addresses, [
            '192.0.2.1',
            '2001:db8::1',
            '192.0.2.2',
            '2001:db8::2',
        ]);
        assert(result.sources.includes('System DNS'));
        assert(result.sources.includes('Google'));
        assert.strictEqual(result.attemptedSources.length, 5);
    } finally {
        dns.resolve4 = originalResolve4;
        dns.resolve6 = originalResolve6;
        global.fetch = originalFetch;
    }

    console.log('CDN discovery tests passed');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
