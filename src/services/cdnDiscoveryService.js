const dns = require('dns').promises;
const net = require('net');

const LOOKUP_TIMEOUT_MS = 3500;
const DOH_PROVIDERS = [
    {
        name: 'Cloudflare',
        url: (domain, type) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
    },
    {
        name: 'Google',
        url: (domain, type) => `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
    },
    {
        name: 'AdGuard',
        url: (domain, type) => `https://dns.adguard-dns.com/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
    },
    {
        name: 'Quad9',
        url: (domain, type) => `https://dns.quad9.net:5053/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
    },
];

function addressesFromDohResponse(data) {
    return (Array.isArray(data?.Answer) ? data.Answer : [])
        .filter(answer => answer && (answer.type === 1 || answer.type === 28))
        .map(answer => String(answer.data || '').trim())
        .filter(address => net.isIP(address) !== 0);
}

async function queryDoh(provider, domain, type) {
    const response = await fetch(provider.url(domain, type), {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${provider.name} returned HTTP ${response.status}`);
    return addressesFromDohResponse(await response.json());
}

async function discoverCdnAddresses(domain, maxAddresses = 32) {
    const lookups = [
        { source: 'System DNS', run: () => dns.resolve4(domain) },
        { source: 'System DNS', run: () => dns.resolve6(domain) },
        ...DOH_PROVIDERS.flatMap(provider => [
            { source: provider.name, run: () => queryDoh(provider, domain, 'A') },
            { source: provider.name, run: () => queryDoh(provider, domain, 'AAAA') },
        ]),
    ];

    const settled = await Promise.allSettled(lookups.map(lookup => lookup.run()));
    const addresses = [];
    const seenAddresses = new Set();
    const successfulSources = new Set();

    settled.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        successfulSources.add(lookups[index].source);
        for (const address of result.value || []) {
            if (net.isIP(address) === 0 || seenAddresses.has(address)) continue;
            seenAddresses.add(address);
            addresses.push(address);
        }
    });

    return {
        addresses: addresses.slice(0, maxAddresses),
        sources: [...successfulSources],
        attemptedSources: [...new Set(lookups.map(lookup => lookup.source))],
    };
}

module.exports = {
    addressesFromDohResponse,
    discoverCdnAddresses,
};
