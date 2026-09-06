const assert = require('assert');
const Module = require('module');

// Module paths use backslashes on Windows, so suffix checks compare against a
// normalized form or every stub silently misses and the test hits the database.
function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

function loadSubscription() {
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'qrcode') return {};
        if (normalizePath(parent?.filename).endsWith('/src/routes/subscription.js')) {
            if (request === '../../config') {
                return { BASE_URL: 'https://panel.example.com', DOMAIN: 'panel.example.com' };
            }
            if (request === '../models/hyUserModel') return {};
            if (request === '../models/hyNodeModel') return {};
            if (request === '../services/cacheService') return {};
            if (request === '../utils/logger') {
                return { debug() {}, info() {}, warn() {}, error() {} };
            }
            if (request === '../services/cryptoService') return {};
            if (request === '../middleware/i18n') {
                return { getDateLocale: () => 'en-US', normalizeLanguage: v => v || 'en' };
            }
            if (request === '../services/uaStatsService') return { track() {} };
            if (request === '../utils/hwidHeaders') return { extractHwidHeaders: () => null };
            if (request === '../services/hwidDeviceService') return {};
            if (request === '../services/webhookService') return { EVENTS: {}, emit() {} };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../src/routes/subscription')];
        return require('../src/routes/subscription');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/routes/subscription')];
    }
}

const {
    singboxRuleSetTag,
    vlessURIForInbound,
    getXrayPublishedInbounds,
    singboxVlessOutboundForInbound,
    clashVlessProxyForInbound,
    resolveCdnOrigins,
} = loadSubscription();
const { buildXrayStreamSettings } = require('../src/services/configGenerator');

// ---- rule-set tags ----------------------------------------------------------
// sing-geosite publishes attribute variants (`google@cn`, `geolocation-!cn`),
// so rejecting those characters would silently drop working rules.
{
    assert.strictEqual(singboxRuleSetTag('geosite', 'geolocation-!cn'), 'geosite-geolocation-!cn');
    assert.strictEqual(singboxRuleSetTag('geosite', 'google@cn'), 'geosite-google@cn');
    assert.strictEqual(singboxRuleSetTag('geosite', 'category-ads-all'), 'geosite-category-ads-all');
    assert.strictEqual(singboxRuleSetTag('geosite', 'x'), 'geosite-x');
    // Short forms the panel stores for Xray have no same-named list upstream.
    assert.strictEqual(singboxRuleSetTag('geosite', 'ru'), 'geosite-category-ru');

    // sing-geoip carries country codes only — provider lists would 404, and a
    // failing rule-set download makes sing-box discard the whole config.
    assert.strictEqual(singboxRuleSetTag('geoip', 'ru'), 'geoip-ru');
    assert.strictEqual(singboxRuleSetTag('geoip', 'telegram'), null);
    assert.strictEqual(singboxRuleSetTag('geoip', 'private'), null);

    // Nothing may escape the rule-set path.
    assert.strictEqual(singboxRuleSetTag('geosite', '../../etc/passwd'), null);
    assert.strictEqual(singboxRuleSetTag('geosite', 'a/b'), null);
    assert.strictEqual(singboxRuleSetTag('geoip', ''), null);
}

// ---- XHTTP hints in the vless URI ------------------------------------------
const node = {
    _id: 'n1',
    name: 'Frankfurt',
    flag: '',
    type: 'xray',
    domain: 'de.example.com',
    port: 443,
    xray: {},
};
const xhttpInbound = {
    port: 443,
    transport: 'xhttp',
    security: 'reality',
    fingerprint: 'chrome',
    realitySni: ['www.microsoft.com'],
    realityPublicKey: 'PUBKEY',
    realityShortIds: ['ab12'],
    xhttpPath: '/x',
    xhttpMode: 'packet-up',
    xhttpXPaddingBytes: '2000-3000',
    xhttpScMaxEachPostBytes: '500000',
    xhttpXmuxMaxConcurrency: '16-32',
    xhttpNoGrpcHeader: true,
};

function uriParams(inbound) {
    const uri = vlessURIForInbound({ xrayUuid: 'UUID' }, node, inbound);
    return new URL(uri.replace('vless://', 'http://')).searchParams;
}

{
    const params = uriParams(xhttpInbound);
    // The inbound rejects a padding length outside its range and drops oversized
    // posts, so URI-only clients must learn both. Two encodings, because the
    // client families read different ones.
    assert.strictEqual(params.get('x_padding_bytes'), '2000-3000');
    assert.deepStrictEqual(JSON.parse(params.get('extra')), {
        xPaddingBytes: '2000-3000',
        scMaxEachPostBytes: '500000',
    });
    // One-sided knobs stay out: extra keys make some parsers reject the URI.
    assert.ok(!params.get('extra').includes('xmux'));
    assert.ok(!params.get('extra').includes('noGRPCHeader'));
}

{
    const params = uriParams({ ...xhttpInbound, xhttpXPaddingBytes: '', xhttpScMaxEachPostBytes: '' });
    assert.strictEqual(params.get('x_padding_bytes'), null);
    assert.strictEqual(params.get('extra'), null);
}

{
    const advanced = {
        ...xhttpInbound,
        xhttpUplinkHTTPMethod: 'GET',
        xhttpUplinkDataPlacement: 'header',
        xhttpUplinkDataKey: 'X-Upload',
        xhttpUplinkChunkSize: '3000-4000',
        xhttpScMinPostsIntervalMs: '0',
        xhttpXPaddingObfsMode: true,
        xhttpXPaddingKey: 'utm_source',
        xhttpXPaddingPlacement: 'query',
        xhttpXPaddingMethod: 'tokenish',
        xhttpSessionPlacement: 'header',
        xhttpSessionKey: 'X-Session',
        xhttpSeqPlacement: 'query',
        xhttpSeqKey: 'part',
    };
    const params = uriParams(advanced);
    const extra = JSON.parse(params.get('extra'));
    assert.strictEqual(extra.uplinkHTTPMethod, 'GET');
    assert.strictEqual(extra.uplinkDataPlacement, 'header');
    assert.strictEqual(extra.uplinkChunkSize, '3000-4000');
    assert.strictEqual(extra.xPaddingObfsMode, true);
    // xray-core v26.6.22 renamed the session keys and kept no fallback in
    // either direction. The client core is whatever the user installed, so both
    // spellings ship and each core reads the pair it knows.
    assert.strictEqual(extra.sessionIDKey, 'X-Session');
    assert.strictEqual(extra.sessionIDPlacement, 'header');
    assert.strictEqual(extra.sessionKey, 'X-Session');
    assert.strictEqual(extra.sessionPlacement, 'header');
    assert.strictEqual(extra.seqKey, 'part');

    // The `extra` blob is Xray-family only. sing-box derivatives read the very
    // same knobs as flat snake_case query keys, and a mismatch on any of them
    // is a 400 from the inbound, so both encodings carry the full set.
    assert.strictEqual(params.get('uplink_http_method'), 'GET');
    assert.strictEqual(params.get('uplink_data_placement'), 'header');
    assert.strictEqual(params.get('uplink_data_key'), 'X-Upload');
    assert.strictEqual(params.get('uplink_chunk_size'), '3000-4000');
    assert.strictEqual(params.get('sc_min_posts_interval_ms'), '0');
    assert.strictEqual(params.get('sc_max_each_post_bytes'), '500000');
    assert.strictEqual(params.get('x_padding_obfs_mode'), 'true');
    assert.strictEqual(params.get('x_padding_key'), 'utm_source');
    assert.strictEqual(params.get('x_padding_placement'), 'query');
    assert.strictEqual(params.get('x_padding_method'), 'tokenish');
    assert.strictEqual(params.get('session_placement'), 'header');
    assert.strictEqual(params.get('session_key'), 'X-Session');
    assert.strictEqual(params.get('seq_placement'), 'query');
    assert.strictEqual(params.get('seq_key'), 'part');

    // sing-box gets them natively, under the same names.
    const { outbound } = singboxVlessOutboundForInbound({ xrayUuid: 'UUID' }, node, advanced);
    assert.strictEqual(outbound.transport.uplink_http_method, 'GET');
    assert.strictEqual(outbound.transport.uplink_data_key, 'X-Upload');
    assert.strictEqual(outbound.transport.session_placement, 'header');
    assert.strictEqual(outbound.transport.seq_key, 'part');
    assert.strictEqual(outbound.transport.x_padding_obfs_mode, true);

    // Mihomo takes the same knobs in xhttp-opts, kebab-cased — except a GET
    // uplink, which parses but never connects (MetaCubeX/mihomo#2832), so an
    // inbound requiring it is dropped from the Clash profile instead.
    assert.strictEqual(clashVlessProxyForInbound({ xrayUuid: 'UUID' }, node, advanced).proxy, null);

    const clash = clashVlessProxyForInbound(
        { xrayUuid: 'UUID' },
        node,
        { ...advanced, xhttpUplinkHTTPMethod: 'POST', xhttpUplinkDataPlacement: 'body', xhttpUplinkDataKey: '' }
    ).proxy;
    assert.ok(clash.includes('uplink-http-method: "POST"'));
    assert.ok(clash.includes('x-padding-key: "utm_source"'));
    assert.ok(clash.includes('x-padding-obfs-mode: true'));
    assert.ok(clash.includes('session-placement: "header"'));
    assert.ok(clash.includes('session-key: "X-Session"'));
    assert.ok(clash.includes('seq-key: "part"'));
    assert.ok(clash.includes('x-padding-bytes: "2000-3000"'));
    assert.ok(clash.includes('reuse-settings:'));
    assert.ok(clash.includes('max-concurrency: "16-32"'));
    assert.ok(clash.includes('no-grpc-header: true'));
    assert.ok(clashVlessProxyForInbound({ xrayUuid: 'UUID' }, node, xhttpInbound).proxy);

    // "0-0" disables padding for Xray but hangs mihomo (MetaCubeX/mihomo#3068).
    const zeroPadding = clashVlessProxyForInbound(
        { xrayUuid: 'UUID' },
        node,
        { ...xhttpInbound, xhttpXPaddingBytes: '0-0' }
    ).proxy;
    assert.ok(!zeroPadding.includes('x-padding-bytes'));

    // A quote in the node name must not truncate the YAML string.
    const quoted = clashVlessProxyForInbound(
        { xrayUuid: 'UUID' },
        { ...node, name: 'Frank "DE" furt' },
        xhttpInbound
    ).proxy;
    assert.ok(quoted.includes('name: "Frank \\"DE\\" furt"'));
}

{
    // Garbage never reaches the client: a malformed range is a fatal error.
    const params = uriParams({ ...xhttpInbound, xhttpXPaddingBytes: '100..200', xhttpScMaxEachPostBytes: 'abc' });
    assert.strictEqual(params.get('x_padding_bytes'), null);
    assert.strictEqual(params.get('extra'), null);
}

// ---- server-side ranges stay a superset of the client defaults --------------
{
    const stream = buildXrayStreamSettings({
        transport: 'xhttp',
        security: 'reality',
        xhttpPath: '/x',
        xhttpXPaddingBytes: '2000-3000',
        xhttpScMaxEachPostBytes: '500000',
    }, node);
    assert.strictEqual(stream.xhttpSettings.extra.xPaddingBytes, '100-3000');
    assert.strictEqual(stream.xhttpSettings.extra.scMaxEachPostBytes, '1000000');
}

{
    const stream = buildXrayStreamSettings({
        transport: 'xhttp',
        security: 'reality',
        xhttpXPaddingBytes: '50',
        xhttpScMaxEachPostBytes: '2000000',
    }, node);
    assert.strictEqual(stream.xhttpSettings.extra.xPaddingBytes, '50-1000');
    assert.strictEqual(stream.xhttpSettings.extra.scMaxEachPostBytes, '2000000');
}

{
    const stream = buildXrayStreamSettings({ transport: 'xhttp', security: 'reality' }, node);
    assert.strictEqual(stream.xhttpSettings.extra, undefined);
}

{
    const stream = buildXrayStreamSettings({
        transport: 'xhttp',
        security: 'none',
        xhttpUplinkHTTPMethod: 'GET',
        xhttpUplinkDataPlacement: 'header',
        xhttpUplinkDataKey: 'X-Upload',
        xhttpUplinkChunkSize: '3000-4000',
        xhttpScMinPostsIntervalMs: '0',
        xhttpServerMaxHeaderBytes: 65536,
        xhttpXPaddingObfsMode: true,
        xhttpSessionPlacement: 'header',
        xhttpSessionKey: 'X-Session',
        xhttpSessionIDTable: 'Base62',
        xhttpSessionIDLength: '16-32',
    }, node);
    assert.strictEqual(stream.xhttpSettings.extra.uplinkHTTPMethod, 'GET');
    assert.strictEqual(stream.xhttpSettings.extra.serverMaxHeaderBytes, 65536);
    assert.strictEqual(stream.xhttpSettings.extra.xPaddingObfsMode, true);
    assert.strictEqual(stream.xhttpSettings.extra.sessionIDPlacement, 'header');
    assert.strictEqual(stream.xhttpSettings.extra.sessionIDKey, 'X-Session');
    assert.strictEqual(stream.xhttpSettings.extra.sessionIDTable, 'Base62');
    assert.strictEqual(stream.xhttpSettings.extra.sessionIDLength, '16-32');
    // Same reason as in the URI test: an inbound built for a core older than
    // v26.6.22 only understands the pre-rename pair.
    assert.strictEqual(stream.xhttpSettings.extra.sessionPlacement, 'header');
    assert.strictEqual(stream.xhttpSettings.extra.sessionKey, 'X-Session');
}

// ---- CDN publication -------------------------------------------------------
{
    const origin = {
        _id: 'origin',
        type: 'xray',
        name: 'Origin',
        ip: '10.0.0.10',
        port: 8443,
        xray: {
            transport: 'xhttp',
            security: 'none',
            xhttpPath: '/origin',
            xhttpMode: 'packet-up',
        },
    };
    const cdn = {
        _id: 'cdn',
        type: 'cdn',
        name: 'CDN',
        cdn: {
            originNode: 'origin',
            domain: 'cdn.example.com',
            port: 443,
            security: 'tls',
            sni: 'cdn.example.com',
            host: 'cdn.example.com',
            path: '/origin/events.php',
            edges: [
                { id: 'edge-1', label: 'Warsaw', address: '203.0.113.1', enabled: true },
                { id: 'edge-2', label: 'Disabled', address: '203.0.113.2', enabled: false },
            ],
        },
        _resolvedOrigin: origin,
    };
    const published = getXrayPublishedInbounds(cdn);
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].address, '203.0.113.1');
    assert.strictEqual(published[0].nameSuffix, 'Warsaw');
    assert.strictEqual(published[0].xhttpPath, '/origin/events.php');
    assert.strictEqual(published[0].security, 'tls');

    const params = new URL(
        vlessURIForInbound({ xrayUuid: 'UUID' }, cdn, published[0]).replace('vless://', 'http://')
    );
    assert.strictEqual(params.hostname, '203.0.113.1');
    assert.strictEqual(params.searchParams.get('sni'), 'cdn.example.com');

    published[0].address = '2001:db8::10';
    const ipv6Uri = vlessURIForInbound({ xrayUuid: 'UUID' }, cdn, published[0]);
    assert.match(ipv6Uri, /^vless:\/\/UUID@\[2001:db8::10\]:443\?/);

    // sing-box dials the edge, but keeps the TLS identity of the CDN domain —
    // an outbound pointed at the origin's own SNI would fail the handshake.
    const sbEdge = getXrayPublishedInbounds(cdn)[0];
    const { outbound: sbOutbound } = singboxVlessOutboundForInbound({ xrayUuid: 'UUID' }, cdn, sbEdge);
    assert.strictEqual(sbOutbound.server, '203.0.113.1');
    assert.strictEqual(sbOutbound.server_port, 443);
    assert.strictEqual(sbOutbound.tls.enabled, true);
    assert.strictEqual(sbOutbound.tls.server_name, 'cdn.example.com');
    assert.strictEqual(sbOutbound.transport.type, 'xhttp');
    assert.strictEqual(sbOutbound.transport.path, '/origin/events.php');
    assert.strictEqual(sbOutbound.transport.host, 'cdn.example.com');

    cdn.cdn.edges = [];
    const domainOnly = getXrayPublishedInbounds(cdn);
    assert.strictEqual(domainOnly.length, 1);
    assert.strictEqual(domainOnly[0].address, 'cdn.example.com');
}

// ---- CDN origin resolution -------------------------------------------------
// A front whose origin is gone, disabled or down dials a dead backend, so it is
// dropped before anything is generated rather than published as a broken entry.
{
    const front = () => ({ _id: 'f1', type: 'cdn', name: 'Front', cdn: { originNode: 'o1' } });
    const origin = extra => ({ _id: 'o1', type: 'xray', name: 'Origin', status: 'online', ...extra });

    const kept = [front()];
    resolveCdnOrigins(kept, [origin(), ...kept], true);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(kept[0]._resolvedOrigin.name, 'Origin');

    const noOrigin = [front()];
    resolveCdnOrigins(noOrigin, noOrigin, true);
    assert.strictEqual(noOrigin.length, 0);

    const inactiveOrigin = [front()];
    resolveCdnOrigins(inactiveOrigin, [origin({ active: false }), ...inactiveOrigin], true);
    assert.strictEqual(inactiveOrigin.length, 0);

    const offlineOrigin = [front()];
    resolveCdnOrigins(offlineOrigin, [origin({ status: 'offline' }), ...offlineOrigin], true);
    assert.strictEqual(offlineOrigin.length, 0);

    // Probes and operators who turned hideOffline off still want to see it.
    const offlineShown = [front()];
    resolveCdnOrigins(offlineShown, [origin({ status: 'offline' }), ...offlineShown], false);
    assert.strictEqual(offlineShown.length, 1);

    // The origin may arrive populated, as an object rather than an id.
    const populated = [{ _id: 'f2', type: 'cdn', name: 'Front', cdn: { originNode: { _id: 'o1' } } }];
    resolveCdnOrigins(populated, [origin(), ...populated], true);
    assert.strictEqual(populated.length, 1);
}

console.log('subscription rule-set and XHTTP tests passed');
