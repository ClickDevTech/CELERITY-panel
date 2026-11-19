'use strict';

/**
 * Build cascade and node configs from fixtures and load them in real Xray
 * cores (`xray run -test`). With --e2e, also run every cascade variant on
 * localhost and fetch a page through it.
 *
 * Needs network: cores are downloaded from GitHub releases and cached.
 *
 *   npm run test:xray-matrix
 *   npm run test:xray-matrix -- 26.3.27,latest,prerelease --e2e
 *
 * Versions: comma-separated list; "latest", "prerelease" and "floor"
 * (MIN_CASCADE_XRAY_VERSION) are resolved. Default: floor, mKCP floor,
 * latest, prerelease. A config is only required to pass on versions at or
 * above the requirement of its link (linkXrayRequirement).
 * Env: XRAY_MATRIX_CACHE (cache dir), GITHUB_TOKEN (API rate limit).
 */

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const HyNode = require('../src/models/hyNodeModel');
const CascadeLink = require('../src/models/cascadeLinkModel');
const gen = require('../src/services/configGenerator');
const { compareVersions } = require('../src/services/xrayVersionService');
const {
    MIN_CASCADE_XRAY_VERSION,
    MIN_KCP_XRAY_VERSION,
    validateTransportSecurity,
    linkXrayRequirement,
} = require('../src/utils/cascadeTransport');

const args = process.argv.slice(2);
const E2E = args.includes('--e2e');
const VERBOSE = args.includes('--verbose');
const ALL = args.includes('--all');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').slice('--only='.length);
const versionArg = args.find(a => !a.startsWith('--'));
const CACHE = process.env.XRAY_MATRIX_CACHE || path.join(os.tmpdir(), 'celerity-xray-matrix');
const IS_WIN = process.platform === 'win32';
const BIN = IS_WIN ? 'xray.exe' : 'xray';
const PANEL_DOMAIN = process.env.PANEL_DOMAIN;

function assetName() {
    const arch = process.arch === 'arm64' ? 'arm64-v8a' : '64';
    if (IS_WIN) return `Xray-windows-${arch}.zip`;
    if (process.platform === 'darwin') return `Xray-macos-${arch}.zip`;
    return `Xray-linux-${arch}.zip`;
}

async function fetchReleases() {
    const headers = { 'User-Agent': 'celerity-xray-matrix', Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch('https://api.github.com/repos/XTLS/Xray-core/releases?per_page=40', { headers });
    if (!res.ok) throw new Error(`GitHub releases API: HTTP ${res.status}`);
    return (await res.json()).filter(r => !r.draft);
}

async function resolveVersions() {
    const wanted = (versionArg || 'floor,kcp-floor,latest,prerelease').split(',').map(v => v.trim()).filter(Boolean);
    let releases = null;
    const out = [];
    for (const want of wanted) {
        if (want === 'floor') { out.push(MIN_CASCADE_XRAY_VERSION); continue; }
        if (want === 'kcp-floor') { out.push(MIN_KCP_XRAY_VERSION); continue; }
        if (want !== 'latest' && want !== 'prerelease') { out.push(want.replace(/^v/, '')); continue; }
        releases = releases || await fetchReleases();
        const stable = releases.find(r => !r.prerelease);
        const pick = want === 'latest'
            ? stable
            : releases.find(r => r.prerelease && (!stable || compareVersions(r.tag_name.slice(1), stable.tag_name.slice(1)) > 0));
        if (pick) out.push(pick.tag_name.replace(/^v/, ''));
        else console.log(`(no ${want} release newer than the latest stable, skipped)`);
    }
    return [...new Set(out)].sort(compareVersions);
}

async function ensureCore(version) {
    const dir = path.join(CACHE, version);
    if (fs.existsSync(path.join(dir, BIN))) return dir;
    fs.mkdirSync(dir, { recursive: true });
    const url = `https://github.com/XTLS/Xray-core/releases/download/v${version}/${assetName()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
    const zip = path.join(dir, 'xray.zip');
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    if (IS_WIN) execFileSync('tar', ['-xf', zip, '-C', dir]);
    else execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
    fs.rmSync(zip);
    if (!IS_WIN) fs.chmodSync(path.join(dir, BIN), 0o755);
    return dir;
}

// ─── Panel certificate fixture ──────────────────────────────────────────────

// A self-signed CA cert for PANEL_DOMAIN served as the panel certificate;
// e2e dialers trust it explicitly.
function setupPanelCert(coreDir) {
    const base = path.join(CACHE, `panel-cert-${PANEL_DOMAIN}`);
    if (!fs.existsSync(`${base}.crt`)) {
        execFileSync(path.join(coreDir, BIN), ['tls', 'cert', '--ca', `--domain=${PANEL_DOMAIN}`, `--file=${base}`], { stdio: 'pipe' });
    }
    const redirect = {
        fullchain: `${base}.crt`,
        privkey: `${base}.key`,
    };
    const map = (p) => {
        const s = String(p);
        if (!s.includes(path.join('greenlock.d', 'live', PANEL_DOMAIN))) return p;
        return s.endsWith('fullchain.pem') ? redirect.fullchain : s.endsWith('privkey.pem') ? redirect.privkey : p;
    };
    const { statSync, readFileSync } = fs;
    fs.statSync = (p, ...rest) => statSync(map(p), ...rest);
    fs.readFileSync = (p, ...rest) => readFileSync(map(p), ...rest);
    return redirect.fullchain;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const REALITY = {
    priv: 'gHMbr2ZkQckkPlI9CBBVCyJk9Ie80SvrBMngTkDcx1Y',
    pub: 'lkou23p9D5iNNuClaVRB-FQ6j8n229dch-UoZphTLmQ',
};
const UUID = '5783a3e7-e373-51cd-8642-c83782b807c5';

function node(id, name, ip, xray = {}) {
    return new HyNode({
        _id: id, name, type: 'xray', ip, port: 443,
        xray: {
            transport: 'tcp', security: 'reality', inboundTag: 'vless-in', apiPort: 61000,
            realityPrivateKey: REALITY.priv, realityPublicKey: REALITY.pub,
            realitySni: ['www.google.com'], realityShortIds: ['abcd1234'],
            ...xray,
        },
    }).toObject();
}

// Public (TEST-NET would also count as public) so Xray applies its
// "no plaintext to a public address" rule.
const portal = node('64b0000000000000000000a1', 'portal', '45.10.20.30');
const exit = node('64b0000000000000000000a2', 'exit', '91.200.10.20');

function link(id, mode, transport, security, protocol = 'vless') {
    const doc = new CascadeLink({
        _id: id, name: `${mode}-${transport}-${security}-${protocol}`, mode,
        portalNode: portal._id, bridgeNode: exit._id,
        tunnelUuid: UUID, tunnelPort: 10086, tunnelProtocol: protocol,
        tunnelTransport: transport, tunnelSecurity: security,
        kcpPassword: transport === 'kcp' ? '0123456789abcdef0123456789abcdef' : undefined,
        realityPrivateKey: REALITY.priv, realityPublicKey: REALITY.pub,
        realitySni: ['www.google.com'], realityShortIds: ['abcd1234'], realityDest: 'www.google.com:443',
    }).toObject();
    doc.bridgeNode = exit;
    return doc;
}

function mainWith(apply) {
    const cfg = JSON.parse(gen.generateXrayConfig(portal, []));
    apply(cfg);
    gen.ensurePrivateIpBlock(cfg);
    return cfg;
}

function buildCases() {
    const configs = [];
    const add = (name, minVersion, build) => {
        try {
            const cfg = build();
            configs.push({ name, minVersion, config: typeof cfg === 'string' ? JSON.parse(cfg) : cfg });
        } catch (error) {
            configs.push({ name, minVersion, genError: error.message });
        }
    };
    const variants = [];

    add('node-reality-tcp', null, () => gen.generateXrayConfig(portal, []));
    add('node-none-xhttp', null, () => gen.generateXrayConfig(
        node('64b0000000000000000000b1', 'n2', '45.10.20.31', { security: 'none', transport: 'xhttp', xhttpPath: '/api' }), []));

    let n = 0;
    for (const transport of ['tcp', 'ws', 'grpc', 'xhttp', 'kcp']) {
        for (const security of ['none', 'tls', 'reality']) {
            if (validateTransportSecurity(transport, security)) continue;
            for (const protocol of transport === 'tcp' ? ['vless', 'vmess'] : ['vless']) {
                const tag = `${transport}-${security}${protocol === 'vmess' ? '-vmess' : ''}`;
                const id = String(++n).padStart(2, '0');
                const fwd = link(`64d0000000000000000000${id}`, 'forward', transport, security, protocol);
                const fwdMin = linkXrayRequirement(fwd)?.version || null;
                add(`fwd-head-${tag}`, fwdMin, () => mainWith(cfg => gen.applyForwardChain(cfg, [fwd], ['vless-in'])));
                add(`fwd-hop-${tag}`, fwdMin, () => gen.generateForwardHopConfig(fwd));
                variants.push({ tag: `fwd-${tag}`, link: fwd });

                // VMess has no VLESS Reverse Proxy counterpart; reverse runs VLESS.
                if (protocol === 'vmess') continue;
                const rev = link(`64c0000000000000000000${id}`, 'reverse', transport, security, protocol);
                const down = link(`64e0000000000000000000${id}`, 'reverse', transport, security, protocol);
                const revMin = linkXrayRequirement(rev)?.version || null;
                add(`rev-portal-${tag}`, revMin, () => mainWith(cfg => gen.applyReversePortal(cfg, [rev], ['vless-in'])));
                add(`rev-bridge-${tag}`, revMin, () => gen.generateBridgeConfig(rev, portal));
                add(`rev-relay-${tag}`, revMin, () => gen.generateRelayConfig(rev, portal, [down]));
                variants.push({ tag: `rev-${tag}`, link: rev });
            }
        }
    }

    // Several exits on one portal: vlessRoute rules, geo, balancer + observatory.
    const exits = multiExitLinks();
    const exitsMin = exits.map(l => linkXrayRequirement(l)?.version)
        .filter(Boolean)
        .reduce((max, v) => (!max || compareVersions(v, max) > 0 ? v : max), null);
    for (const [suffix, settings] of [
        ['', { publishMode: 'both' }],
        ['-leastping', { publishMode: 'perExit', balancerStrategy: 'leastPing', fallback: 'block' }],
        ['-leastload', { publishMode: 'both', balancerStrategy: 'leastLoad', fallback: 'block' }],
    ]) {
        add(`rev-portal-multi-exit${suffix}`, exitsMin,
            () => mainWith(cfg => gen.applyReversePortal(cfg, exits, ['vless-in'], settings)));
    }
    return { configs, variants, multiExitMin: exitsMin };
}

function multiExitLinks() {
    return [
        { id: '64f000000000000000000001', transport: 'tcp', security: 'reality' },
        { id: '64f000000000000000000002', transport: 'xhttp', security: 'none' },
        { id: '64f000000000000000000003', transport: 'tcp', security: 'reality', geo: true },
    ].map((spec, i) => ({
        ...link(spec.id, 'reverse', spec.transport, spec.security),
        tunnelPort: 10086 + i,
        routeId: i + 1,
        // The core cache ships geoip.dat only, so no geosite: rules here.
        ...(spec.geo ? { geoRouting: { enabled: true, domains: ['domain:example.com'], geoip: ['geoip:private'] } } : {}),
    }));
}

// ─── Config load test ───────────────────────────────────────────────────────

function runTest(coreDir, file) {
    try {
        execFileSync(path.join(coreDir, BIN), ['run', '-test', '-c', file], {
            env: { ...process.env, XRAY_LOCATION_ASSET: coreDir }, stdio: 'pipe', timeout: 30000,
        });
        return 'OK';
    } catch (error) {
        const text = `${error.stdout || ''}${error.stderr || ''}`;
        const line = text.split(/\r?\n/).find(l => /Failed to start|failed/i.test(l))
            || text.trim().split(/\r?\n/).pop() || error.message;
        return `FAIL: ${line.replace(/^.*?(Failed to start: )?main: failed to load config files: \[[^\]]+\] > /, '').slice(0, 240)}`;
    }
}

// ─── End-to-end tunnel test ─────────────────────────────────────────────────

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// HTTP GET through a SOCKS5 proxy, without dependencies.
function socksGet(socksPort, targetPort, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const sock = net.connect(socksPort, '127.0.0.1');
        let stage = 0;
        let body = Buffer.alloc(0);
        const done = (value) => { sock.destroy(); resolve(value); };
        sock.setTimeout(timeoutMs, () => done(body.toString()));
        sock.on('error', () => done(body.toString()));
        sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
        sock.on('data', (chunk) => {
            if (stage === 0) {
                stage = 1;
                const port = Buffer.alloc(2);
                port.writeUInt16BE(targetPort);
                sock.write(Buffer.concat([Buffer.from([5, 1, 0, 1, 127, 0, 0, 1]), port]));
            } else if (stage === 1) {
                if (chunk[1] !== 0) return done(null);
                stage = 2;
                sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
            } else {
                body = Buffer.concat([body, chunk]);
                if (body.includes('celerity-e2e-ok')) done(body.toString());
            }
        });
        sock.on('end', () => done(body.toString()));
    });
}

/**
 * Bind to loopback and trust the test CA. `pagePorts` opens exactly the test
 * pages on the exit side, which blocks private targets like production does;
 * every other loopback port must stay unreachable through the tunnel.
 */
function localize(config, caFile, pagePorts = []) {
    for (const ib of config.inbounds || []) ib.listen = '127.0.0.1';
    const page = { ip: ['127.0.0.1/32'], port: pagePorts.join(',') };
    for (const ob of config.outbounds || []) {
        if (ob.protocol === 'freedom' && pagePorts.length > 0) {
            ob.settings = { ...ob.settings, finalRules: [{ action: 'allow', ...page }, ...(ob.settings?.finalRules || [])] };
            config.routing.rules.unshift({ type: 'field', ...page, outboundTag: ob.tag });
        }
        const tls = ob.streamSettings?.tlsSettings;
        // Older cores add verify certs only to a self pool, used with disableSystemRoot.
        if (tls && !tls.certificates) {
            tls.certificates = [{ usage: 'verify', certificateFile: caFile }];
            tls.disableSystemRoot = true;
        }
    }
    return config;
}

async function runE2e(coreDir, variant, caFile, httpPort, internalPort, tmpDir) {
    const link = { ...variant.link, tunnelPort: await freePort() };
    const socksPort = await freePort();
    const local = { ...exit, ip: '127.0.0.1' };
    const head = {
        log: { loglevel: 'warning' },
        inbounds: [{ tag: 'client-in', listen: '127.0.0.1', port: socksPort, protocol: 'socks', settings: { udp: false } }],
        outbounds: [{ tag: 'direct', protocol: 'freedom' }],
        routing: { rules: [] },
    };
    let tail;
    if (link.mode === 'forward') {
        gen.applyForwardChain(head, [{ ...link, bridgeNode: local }], ['client-in']);
        tail = JSON.parse(gen.generateForwardHopConfig(link));
    } else {
        gen.applyReversePortal(head, [link], ['client-in']);
        tail = JSON.parse(gen.generateBridgeConfig(link, local));
    }

    const procs = [];
    let log = '';
    try {
        for (const [name, cfg, pagePorts] of [['tail', tail, [httpPort]], ['head', head, []]]) {
            const file = path.join(tmpDir, `${variant.tag}-${name}.json`);
            fs.writeFileSync(file, JSON.stringify(localize(cfg, caFile, pagePorts), null, 2));
            const proc = spawn(path.join(coreDir, BIN), ['run', '-c', file], {
                env: { ...process.env, XRAY_LOCATION_ASSET: coreDir }, stdio: ['ignore', 'pipe', 'pipe'],
            });
            proc.stdout.on('data', d => { log += `[${name}] ${d}`; });
            proc.stderr.on('data', d => { log += `[${name}] ${d}`; });
            procs.push(proc);
        }
        // The reverse bridge dials the portal ~2s after start.
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            const body = await socksGet(socksPort, httpPort);
            if (body && body.includes('celerity-e2e-ok')) {
                const leaked = await socksGet(socksPort, internalPort, 1500);
                return leaked && leaked.includes('celerity-e2e-internal')
                    ? 'FAIL: a loopback service of the exit is reachable through the tunnel'
                    : 'OK';
            }
            if (procs.some(p => p.exitCode !== null)) break;
            await sleep(700);
        }
        if (VERBOSE) console.log(`\n--- ${variant.tag} @ ${path.basename(coreDir)} ---\n${log}`);
        const tailLines = log.trim().split(/\r?\n/).slice(-3).join(' | ');
        return `FAIL: no response through the tunnel${tailLines ? `: ${tailLines.slice(0, 400)}` : ''}`;
    } finally {
        for (const p of procs) p.kill();
    }
}

const USER_UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const routedUuid = route => USER_UUID.replace(/^(\w{8}-\w{4}-)\w{4}/, `$1${route.toString(16).padStart(4, '0')}`);

/**
 * One portal with exits A and B, a client whose SOCKS ports 1080+N send the
 * user UUID with route N. Exit B redirects to its own page, so the response
 * tells which bridge carried the request.
 *   routes: route 1 must reach A and route 2 must reach B.
 *   leastPing/leastLoad: only A runs; the balanced entry (route 0) must keep
 *   working, which a random balancer over a dead exit would not.
 */
async function runMultiExitE2e(coreDir, scenario, caFile, pages, tmpDir) {
    const local = { ...exit, ip: '127.0.0.1' };
    const exitLinks = [];
    for (const [i, id] of ['64f0000000000000000000a1', '64f0000000000000000000a2'].entries()) {
        exitLinks.push({ ...link(id, 'reverse', 'tcp', 'none'), tunnelPort: await freePort(), routeId: i + 1 });
    }
    const portalPort = await freePort();
    const socks = [await freePort(), await freePort(), await freePort()];
    const settings = scenario === 'routes'
        ? { publishMode: 'both' }
        : { publishMode: 'both', balancerStrategy: scenario, fallback: 'block', probeUrl: `http://127.0.0.1:${pages.a}/`, probeInterval: '2s' };

    const portalCfg = {
        log: { loglevel: 'warning' },
        inbounds: [{ tag: 'vless-in', port: portalPort, protocol: 'vless', settings: { clients: [{ id: USER_UUID }], decryption: 'none' } }],
        outbounds: [{ tag: 'direct', protocol: 'freedom' }],
        routing: { rules: [] },
    };
    gen.applyReversePortal(portalCfg, exitLinks, ['vless-in'], settings);
    const clientCfg = {
        log: { loglevel: 'warning' },
        inbounds: socks.map((port, route) => ({ tag: `socks-${route}`, port, protocol: 'socks', settings: { udp: false } })),
        outbounds: socks.map((_, route) => ({
            tag: `user-${route}`,
            protocol: 'vless',
            settings: { address: '127.0.0.1', port: portalPort, id: routedUuid(route), encryption: 'none' },
        })),
        routing: { rules: socks.map((_, route) => ({ type: 'field', inboundTag: [`socks-${route}`], outboundTag: `user-${route}` })) },
    };
    const bridgeB = JSON.parse(gen.generateBridgeConfig(exitLinks[1], local));
    for (const ob of bridgeB.outbounds) {
        if (ob.protocol === 'freedom') ob.settings = { ...ob.settings, redirect: `127.0.0.1:${pages.b}` };
    }
    const pagePorts = [pages.a, pages.b];
    const processes = [
        ['portal', portalCfg, []],
        ['bridge-a', JSON.parse(gen.generateBridgeConfig(exitLinks[0], local)), pagePorts],
        ...(scenario === 'routes' ? [['bridge-b', bridgeB, pagePorts]] : []),
        ['client', clientCfg, []],
    ];

    const procs = [];
    let log = '';
    const fetchVia = async route => (await socksGet(socks[route], pages.a)) || '';
    try {
        for (const [name, cfg, ports] of processes) {
            const file = path.join(tmpDir, `multi-exit-${scenario}-${name}.json`);
            fs.writeFileSync(file, JSON.stringify(localize(cfg, caFile, ports), null, 2));
            const proc = spawn(path.join(coreDir, BIN), ['run', '-c', file], {
                env: { ...process.env, XRAY_LOCATION_ASSET: coreDir }, stdio: ['ignore', 'pipe', 'pipe'],
            });
            proc.stdout.on('data', d => { log += `[${name}] ${d}`; });
            proc.stderr.on('data', d => { log += `[${name}] ${d}`; });
            procs.push(proc);
        }

        const deadline = Date.now() + 40000;
        const expectations = scenario === 'routes' ? [[1, 'exit-a'], [2, 'exit-b']] : [[0, 'exit-a']];
        let verdict = 'no response through the tunnel';
        for (const [route, marker] of expectations) {
            let streak = 0;
            // Balancers need several clean answers in a row: a random pick over a
            // dead exit would fail about half of them.
            const needed = scenario === 'routes' ? 3 : 8;
            while (streak < needed && Date.now() < deadline && procs.every(p => p.exitCode === null)) {
                const body = await fetchVia(route);
                if (body.includes(marker)) {
                    streak++;
                } else {
                    if (body.includes('celerity-e2e-ok')) {
                        verdict = `route ${route} reached the wrong exit`;
                        if (scenario === 'routes') break;
                    }
                    streak = 0;
                    await sleep(500);
                }
            }
            if (streak < needed) {
                if (VERBOSE) console.log(`\n--- multi-exit-${scenario} @ ${path.basename(coreDir)} ---\n${log}`);
                const tailLines = log.trim().split(/\r?\n/).slice(-3).join(' | ');
                return `FAIL: ${verdict}${tailLines ? `: ${tailLines.slice(0, 400)}` : ''}`;
            }
        }
        return 'OK';
    } finally {
        for (const p of procs) p.kill();
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function printTable(title, rows, versions, results) {
    const width = Math.max(...rows.map(r => r.length), 8);
    console.log(`\n${title}\n${'config'.padEnd(width)}  ${versions.map(v => v.padEnd(9)).join(' ')}`);
    for (const row of rows) {
        const cells = versions.map((v) => {
            const r = results[row][v];
            return (r === undefined ? '-' : r === 'OK' ? 'OK' : r.startsWith('FAIL') || r.startsWith('GEN') ? 'FAIL' : r).padEnd(9);
        });
        console.log(`${row.padEnd(width)}  ${cells.join(' ')}`);
    }
}

async function main() {
    const versions = await resolveVersions();
    console.log(`Xray versions: ${versions.join(', ')} (cache: ${CACHE})`);
    const coreDirs = {};
    for (const v of versions) coreDirs[v] = await ensureCore(v);
    const caFile = setupPanelCert(coreDirs[versions[versions.length - 1]]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'celerity-matrix-'));
    const all = buildCases();
    const pick = list => (ONLY ? list.filter(x => new RegExp(ONLY).test(x.name || x.tag)) : list);
    const configs = pick(all.configs);
    const variants = pick(all.variants);
    const results = {};
    const failures = [];
    // --all ignores link requirements, to measure where a floor really is.
    const required = (minVersion, v) => ALL || !minVersion || compareVersions(v, minVersion) >= 0;

    for (const c of configs) {
        results[c.name] = {};
        const file = path.join(tmpDir, `${c.name}.json`);
        if (!c.genError) fs.writeFileSync(file, JSON.stringify(c.config, null, 2));
        for (const v of versions) {
            if (!required(c.minVersion, v)) continue;
            const r = c.genError ? `GEN: ${c.genError}` : runTest(coreDirs[v], file);
            results[c.name][v] = r;
            if (r !== 'OK') failures.push(`${c.name} @ ${v}: ${r}`);
        }
    }
    printTable('xray run -test ("-" = below the link requirement)', configs.map(c => c.name), versions, results);

    if (E2E) {
        const server = http.createServer((req, res) => res.end('celerity-e2e-ok'));
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const httpPort = server.address().port;
        // Stands for cc-agent / Xray API on the exit node: never reachable by clients.
        const internal = http.createServer((req, res) => res.end('celerity-e2e-internal'));
        await new Promise(r => internal.listen(0, '127.0.0.1', r));
        const internalPort = internal.address().port;
        const e2e = {};
        for (const variant of variants) {
            e2e[variant.tag] = {};
            const minVersion = linkXrayRequirement(variant.link)?.version || null;
            for (const v of versions) {
                if (!required(minVersion, v)) continue;
                const r = await runE2e(coreDirs[v], variant, caFile, httpPort, internalPort, tmpDir);
                e2e[variant.tag][v] = r;
                if (r !== 'OK') failures.push(`e2e ${variant.tag} @ ${v}: ${r}`);
            }
        }
        server.close();
        internal.close();

        const pageServers = ['exit-a', 'exit-b'].map(marker => http.createServer((req, res) => res.end(`celerity-e2e-ok ${marker}`)));
        await Promise.all(pageServers.map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
        const pages = { a: pageServers[0].address().port, b: pageServers[1].address().port };
        const multiRows = ['routes', 'leastPing', 'leastLoad']
            .map(scenario => ({ scenario, tag: `multi-exit-${scenario}` }))
            .filter(row => !ONLY || new RegExp(ONLY).test(row.tag));
        for (const { scenario, tag } of multiRows) {
            e2e[tag] = {};
            for (const v of versions) {
                if (!required(all.multiExitMin, v)) continue;
                const r = await runMultiExitE2e(coreDirs[v], scenario, caFile, pages, tmpDir);
                e2e[tag][v] = r;
                if (r !== 'OK') failures.push(`e2e ${tag} @ ${v}: ${r}`);
            }
        }
        pageServers.forEach(s => s.close());
        printTable('end-to-end through the tunnel', [...variants.map(v => v.tag), ...multiRows.map(r => r.tag)], versions, e2e);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (failures.length) {
        console.log(`\n${failures.length} failure(s):`);
        for (const f of failures) console.log(`- ${f}`);
        process.exit(1);
    }
    console.log('\nAll configs passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
