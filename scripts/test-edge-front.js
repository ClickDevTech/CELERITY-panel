'use strict';

// Reverse-proxy front: Caddyfile, validation, inbound layout, publication.

const assert = require('assert');
const Module = require('module');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

// Subscription touches Mongo and Redis at require time.
function loadSubscription() {
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'qrcode') return {};
        if (normalizePath(parent?.filename).endsWith('/src/routes/subscription.js')) {
            if (request === '../../config') {
                return { BASE_URL: 'https://panel.example.com', PANEL_DOMAIN: 'panel.example.com' };
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
    MAIN_INBOUND_ID,
    isLoopbackAddress,
    isInboundFronted,
    xrayNeedsTls,
    frontClientAlpn,
    frontBasePath,
    buildFrontRoutes,
    assignFrontLoopbackPorts,
    applyFrontInboundLayout,
    releaseFrontInboundLayout,
    normalizeXrayFront,
    validateXrayFront,
} = require('../src/utils/xrayFront');
const { buildCaddyfile } = require('../src/services/edgeFront/caddyfile');
const { applyFrontPatch } = require('../src/services/edgeFront/frontConfig');
const { selectCaddyAsset } = require('../src/services/edgeFront/release');
const { getXrayPublishedInbounds, vlessURIForInbound } = loadSubscription();

const VALID_CONTEXT = { sameVps: false, acmeEmail: 'admin@example.com' };

// Main inbound (xhttp) and one extra (ws), both behind the front.
function makeNode(overrides = {}) {
    return {
        _id: 'n1',
        name: 'Frankfurt',
        flag: '',
        type: 'xray',
        domain: 'de.example.com',
        ip: '203.0.113.10',
        port: 8443,
        xray: {
            listen: '127.0.0.1',
            transport: 'xhttp',
            security: 'none',
            xhttpPath: '/api/sync',
            tlsSource: 'manual',
            manualCert: 'CERT',
            manualKey: 'KEY',
            extraInbounds: [{
                id: 'extra-ws',
                label: 'WS',
                port: 8444,
                listen: '127.0.0.1',
                transport: 'ws',
                security: 'none',
                wsPath: '/live/socket',
                inboundTag: 'vless-ws',
            }],
            front: {
                enabled: true,
                publicPort: 443,
                siteMode: 'nginx',
                inboundIds: [MAIN_INBOUND_ID, 'extra-ws'],
            },
            ...overrides.xray,
        },
        ...overrides,
    };
}

// ---- loopback detection -----------------------------------------------------
{
    assert.strictEqual(isLoopbackAddress('127.0.0.1'), true);
    assert.strictEqual(isLoopbackAddress('127.9.9.9'), true);
    assert.strictEqual(isLoopbackAddress('::1'), true);
    assert.strictEqual(isLoopbackAddress('0.0.0.0'), false);
    assert.strictEqual(isLoopbackAddress(''), false);
}

// ---- route derivation -------------------------------------------------------
{
    const node = makeNode();
    const routes = buildFrontRoutes(node.xray, node.port);
    assert.strictEqual(routes.length, 2);

    // XHTTP appends segments below its base path, but a bare hit counts too.
    assert.deepStrictEqual(routes[0].paths, ['/api/sync', '/api/sync/*']);
    assert.strictEqual(routes[0].upstream, '127.0.0.1:8443');
    assert.strictEqual(routes[0].h2c, true);

    assert.strictEqual(routes[1].transport, 'ws');
    assert.strictEqual(routes[1].h2c, false);
    assert.deepStrictEqual(routes[1].paths, ['/live/socket', '/live/socket/*']);

    assert.deepStrictEqual(buildFrontRoutes({ ...node.xray, front: { enabled: false } }), []);

    assert.strictEqual(frontBasePath({ transport: 'grpc', grpcServiceName: 'tunnel' }), '/tunnel');
    assert.strictEqual(frontBasePath({ transport: 'grpc', grpcServiceName: '/my/tunnel' }), '/my/tunnel');
}

// ---- Caddyfile --------------------------------------------------------------
{
    const caddyfile = buildCaddyfile(makeNode());

    assert.ok(caddyfile.includes('protocols h1 h2'), 'protocols pinned to h1 h2');
    assert.ok(!caddyfile.includes('h3'), 'no h3 anywhere');
    assert.ok(!caddyfile.includes('email'), 'no ACME email for manual TLS');

    assert.ok(caddyfile.includes('https://de.example.com:443 {'), 'site address uses the node domain');
    assert.ok(caddyfile.includes('tls /etc/caddy/tls/cert.pem /etc/caddy/tls/key.pem {'), 'manual PEM files');
    assert.ok(caddyfile.includes('alpn "h2" "http/1.1"'), 'alpn inside the tls block');
    assert.ok(caddyfile.includes('@front0 path "/api/sync" "/api/sync/*"'), 'xhttp matcher');
    assert.ok(caddyfile.includes('reverse_proxy h2c://127.0.0.1:8443'), 'xhttp upstream is h2c');
    assert.ok(caddyfile.includes('reverse_proxy 127.0.0.1:8444'), 'ws upstream is plain http');
    assert.ok(caddyfile.includes('file_server'), 'decoy site is served');
    assert.ok(caddyfile.indexOf('@front1') < caddyfile.indexOf('file_server'),
        'the catch-all comes after the inbound routes');

    const grpcNode = makeNode();
    grpcNode.xray.transport = 'grpc';
    grpcNode.xray.grpcServiceName = 'tunnel';
    const grpcCaddyfile = buildCaddyfile(grpcNode);
    assert.ok(grpcCaddyfile.includes('header_up X-Real-IP {remote_host}'), 'grpc forwards X-Real-IP');

    // The panel cert is issued for the panel domain, which is also the SNI.
    const panelNode = makeNode();
    panelNode.xray.tlsSource = 'panel';
    assert.ok(buildCaddyfile(panelNode).includes('https://panel.example.com:443 {'));

    const acmeNode = makeNode();
    acmeNode.xray.tlsSource = 'acme';
    acmeNode.xray.acmeEmail = 'ops@example.com';
    const acmeCaddyfile = buildCaddyfile(acmeNode);
    assert.ok(acmeCaddyfile.includes('email ops@example.com'));
    assert.ok(acmeCaddyfile.includes('tls {'), 'no PEM files under acme');

    const injected = makeNode();
    injected.xray.xhttpPath = '/api" { respond "pwned';
    assert.throws(() => buildCaddyfile(injected), /FRONT_CONFIG_INVALID/);

    const rootNode = makeNode();
    rootNode.xray.xhttpPath = '/';
    assert.throws(() => buildCaddyfile(rootNode), /FRONT_CONFIG_INVALID/);

    assert.strictEqual(buildCaddyfile(makeNode()), buildCaddyfile(makeNode()),
        'stable output, otherwise the fingerprint re-provisions on every save');
}

// ---- validation -------------------------------------------------------------
{
    const node = makeNode();
    assert.strictEqual(validateXrayFront(node.xray, node, VALID_CONTEXT), null);

    const check = (mutate, pattern) => {
        const bad = makeNode();
        mutate(bad);
        const error = validateXrayFront(bad.xray, bad, VALID_CONTEXT);
        assert.ok(error, `expected an error for ${pattern}`);
        assert.ok(pattern.test(error), `"${error}" should match ${pattern}`);
    };

    check(n => { n.xray.transport = 'tcp'; }, /raw TLS/);
    check(n => { n.xray.listen = '0.0.0.0'; }, /127\.0\.0\.1/);
    check(n => { n.xray.security = 'tls'; }, /security 'none'/);
    check(n => { n.xray.xhttpPath = '/'; }, /other than '\/'/);
    check(n => { n.xray.extraInbounds[0].wsPath = '/api/sync'; }, /more than one inbound/);
    check(n => { n.xray.extraInbounds[0].wsPath = '/api/sync/ws'; }, /prefix of/);
    check(n => { n.xray.tlsSource = 'self-signed'; }, /self-signed/);
    check(n => { n.domain = ''; }, /requires a domain/);
    check(n => { n.xray.front.inboundIds = []; }, /at least one inbound/);
    check(n => { n.xray.front.inboundIds = ['ghost']; }, /does not exist/);
    check(n => { n.xray.front.publicPort = 0; }, /1\.\.65535/);
    // Caddy cannot share the public port with an inbound that stays public.
    check(n => {
        n.xray.front.inboundIds = ['extra-ws'];
        n.xray.listen = '0.0.0.0';
        n.xray.security = 'reality';
        n.port = 443;
    }, /already used by the main inbound/);
    check(n => {
        n.xray.extraInbounds.push({
            id: 'reality-in', port: 443, listen: '0.0.0.0', transport: 'tcp', security: 'reality',
        });
    }, /already used by inbound "reality-in"/);
    // Caddy holds port 80 for the challenge, leaving acme.sh nothing to bind.
    check(n => {
        n.xray.tlsSource = 'acme';
        n.xray.extraInbounds.push({ id: 'tls-in', port: 9443, listen: '0.0.0.0', transport: 'ws', security: 'tls' });
    }, /owns port 80/);

    const sameVps = makeNode();
    assert.ok(/same VPS/.test(validateXrayFront(sameVps.xray, sameVps, { ...VALID_CONTEXT, sameVps: true })));

    const acme = makeNode();
    acme.xray.tlsSource = 'acme';
    assert.ok(/ACME email/.test(validateXrayFront(acme.xray, acme, { sameVps: false, acmeEmail: '' })));

    // A disabled front is never validated.
    const off = makeNode();
    off.xray.front.enabled = false;
    off.xray.listen = '0.0.0.0';
    assert.strictEqual(validateXrayFront(off.xray, off, VALID_CONTEXT), null);
}

// ---- normalization ----------------------------------------------------------
{
    const normalized = normalizeXrayFront({
        enabled: 'on',
        publicPort: '8443',
        siteMode: 'custom',
        inboundIds: ['main', 'extra-ws', 'main'],
    });
    assert.strictEqual(normalized.enabled, true);
    assert.strictEqual(normalized.publicPort, 8443);
    assert.strictEqual(normalized.siteMode, 'custom');
    assert.deepStrictEqual(normalized.inboundIds, ['main', 'extra-ws']);

    // Defaults apply to omitted values only; a bad port reaches validation.
    assert.strictEqual(normalizeXrayFront({}).publicPort, 443);
    assert.ok(!Number.isInteger(normalizeXrayFront({ publicPort: 'abc' }).publicPort));
}

// ---- inbound layout ---------------------------------------------------------
{
    // A public node: the layout has to move both inbounds to loopback.
    const node = {
        domain: 'de.example.com',
        port: 443,
        xray: {
            listen: '0.0.0.0',
            transport: 'ws',
            security: 'tls',
            wsPath: '/live/socket',
            tlsSource: 'panel',
            extraInbounds: [{
                id: 'extra-xhttp',
                port: 443,
                listen: '0.0.0.0',
                transport: 'xhttp',
                security: 'tls',
                xhttpPath: '/api/sync',
            }],
            front: {
                enabled: true,
                publicPort: 443,
                inboundIds: ['main', 'extra-xhttp'],
            },
        },
    };

    const ports = assignFrontLoopbackPorts(node.xray, node);
    assert.deepStrictEqual([...ports.values()], [8443, 8444], 'ports are deterministic');

    applyFrontInboundLayout(node.xray, node);
    assert.strictEqual(node.xray.listen, '127.0.0.1');
    assert.strictEqual(node.xray.security, 'none');
    assert.strictEqual(node.port, 8443, 'the front takes over the public port');
    assert.strictEqual(node.xray.extraInbounds[0].listen, '127.0.0.1');
    assert.strictEqual(node.xray.extraInbounds[0].security, 'none');
    assert.strictEqual(node.xray.extraInbounds[0].port, 8444);
    assert.strictEqual(validateXrayFront(node.xray, node, VALID_CONTEXT), null);

    // Re-applying must not shuffle ports, otherwise every save re-provisions.
    const portBefore = node.port;
    applyFrontInboundLayout(node.xray, node);
    assert.strictEqual(node.port, portBefore);
    assert.strictEqual(node.xray.extraInbounds[0].port, 8444);

    // Without a public listener back the node would go dark.
    releaseFrontInboundLayout(node.xray, ['main', 'extra-xhttp']);
    assert.strictEqual(node.xray.listen, '0.0.0.0');
    assert.strictEqual(node.xray.security, 'tls');
    assert.strictEqual(node.xray.extraInbounds[0].listen, '0.0.0.0');
    assert.strictEqual(node.xray.extraInbounds[0].security, 'tls');
}

// ---- partial front patch ----------------------------------------------------
{
    // REST and MCP write the front subdocument whole, so everything the caller
    // cannot send — the decoy page and the provisioning state — has to survive.
    const node = makeNode();
    const previousFront = {
        ...node.xray.front,
        siteMode: 'custom',
        siteHtml: Buffer.from('<html>decoy</html>'),
        appliedFingerprint: 'abc123',
        status: 'active',
        caddyVersion: '2.8.4',
    };
    node.xray.front = { enabled: true, publicPort: 443, siteMode: 'custom', inboundIds: [MAIN_INBOUND_ID, 'extra-ws'] };

    assert.strictEqual(applyFrontPatch(node.xray, node, previousFront), null);
    assert.strictEqual(node.xray.front.siteHtml.toString(), '<html>decoy</html>');
    assert.strictEqual(node.xray.front.appliedFingerprint, 'abc123');
    assert.strictEqual(node.xray.front.status, 'active');
    assert.strictEqual(node.xray.front.caddyVersion, '2.8.4');

    // A patch is still a patch: sent fields win over the stored ones.
    assert.strictEqual(node.xray.front.publicPort, 443);
}

// ---- TLS material detection -------------------------------------------------
{
    assert.strictEqual(xrayNeedsTls(makeNode().xray), true);
    assert.strictEqual(xrayNeedsTls({ security: 'reality', extraInbounds: [] }), false);
    assert.strictEqual(xrayNeedsTls({ security: 'reality', extraInbounds: [{ security: 'tls' }] }), true);
}

// ---- release assets ---------------------------------------------------------
{
    const asset = selectCaddyAsset('2.8.4', 'x86_64');
    assert.strictEqual(asset.archiveName, 'caddy_2.8.4_linux_amd64.tar.gz');
    assert.ok(asset.archiveUrl.startsWith('https://github.com/caddyserver/caddy/releases/download/v2.8.4/'));
    assert.ok(asset.checksumsUrl.endsWith('caddy_2.8.4_checksums.txt'));
    assert.strictEqual(selectCaddyAsset('2.8.4', 'sparc64'), null);
    assert.strictEqual(selectCaddyAsset('nightly', 'x86_64'), null);
}

// ---- subscription publication ----------------------------------------------
{
    const node = makeNode();
    assert.strictEqual(isInboundFronted(node.xray, null), true);
    assert.strictEqual(isInboundFronted(node.xray, 'extra-ws'), true);
    assert.strictEqual(isInboundFronted(node.xray, 'other'), false);

    const published = getXrayPublishedInbounds(node);
    assert.strictEqual(published.length, 2);
    for (const inbound of published) {
        assert.strictEqual(inbound.port, 443);
        assert.strictEqual(inbound.security, 'tls');
        assert.strictEqual(inbound.address, 'de.example.com');
    }

    // The front offers both protocols, so the client ALPN is what decides the
    // HTTP version — and WebSocket cannot be upgraded over h2.
    assert.deepStrictEqual(published[0].alpn, ['h2', 'http/1.1'], 'xhttp takes either');
    assert.deepStrictEqual(published[1].alpn, ['http/1.1'], 'ws must not negotiate h2');
    assert.deepStrictEqual(frontClientAlpn('grpc'), ['h2'], 'grpc exists only over h2');

    const uri = vlessURIForInbound({ userId: 'u1', xrayUuid: '11111111-1111-1111-1111-111111111111' }, node, published[0]);
    assert.ok(uri.includes('@de.example.com:443?'), 'URI points at the front');
    assert.ok(uri.includes('security=tls'));
    assert.ok(uri.includes('type=xhttp'));
    assert.ok(uri.includes('alpn=h2%2Chttp%2F1.1'));
    assert.ok(!uri.includes('8443'), 'the loopback port is never published');

    // Caddy picks its site block by Host, which gRPC sends as :authority. With
    // a panel cert the SNI is the panel domain, so the authority must follow.
    const grpc = makeNode();
    grpc.xray.tlsSource = 'panel';
    grpc.xray.transport = 'grpc';
    grpc.xray.grpcServiceName = 'tunnel';
    const grpcPublished = getXrayPublishedInbounds(grpc)[0];
    assert.strictEqual(grpcPublished.grpcAuthority, 'panel.example.com');
    const grpcUri = vlessURIForInbound({ userId: 'u1', xrayUuid: '11111111-1111-1111-1111-111111111111' }, grpc, grpcPublished);
    assert.ok(grpcUri.includes('authority=panel.example.com'), 'authority matches the Caddy site');
    assert.ok(grpcUri.includes('sni=panel.example.com'));
    assert.ok(grpcUri.includes('alpn=h2'));

    // Without a panel cert the site block is the node domain instead.
    const grpcOwnDomain = makeNode();
    grpcOwnDomain.xray.transport = 'grpc';
    grpcOwnDomain.xray.grpcServiceName = 'tunnel';
    assert.strictEqual(getXrayPublishedInbounds(grpcOwnDomain)[0].grpcAuthority, 'de.example.com');

    const bare = makeNode();
    bare.xray.front.enabled = false;
    const barePublished = getXrayPublishedInbounds(bare);
    assert.strictEqual(barePublished[0].port, 8443);
    assert.strictEqual(barePublished[0].security, 'none');
}

console.log('test-edge-front: all assertions passed');
