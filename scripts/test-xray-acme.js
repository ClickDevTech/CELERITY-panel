/**
 * Xray acme.sh (tlsSource 'acme' without the front) tests, no network or MongoDB.
 *
 * Verifies:
 *   - which configurations need TCP 80 and when validation refuses them
 *     (panel server, an inbound on :80), including TLS on an extra inbound only,
 *   - setupXrayNode opens and persists TCP 80 before acme.sh runs and keeps
 *     :80 in the general firewall step for renewals,
 *   - setup refuses the panel server when only an extra inbound uses TLS,
 *   - the acme.sh script keeps an existing certificate when :80 is busy, names
 *     Xray as the holder and explains a closed port 80.
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';

const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');

const { xrayAcmeNeedsPort80, validateXrayAcme, findPort80Inbound } = require('../src/utils/xrayAcme');

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

const state = { commands: [] };

class FakeClient extends EventEmitter {
    connect() {
        setImmediate(() => this.emit('ready'));
    }

    exec(command, cb) {
        state.commands.push(command);
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(null, stream);
        setImmediate(() => {
            if (command === 'uname -s') stream.emit('data', Buffer.from('Linux\n'));
            stream.emit('close', 0);
        });
    }

    sftp(cb) {
        cb(null, {
            createWriteStream() {
                const ws = new EventEmitter();
                ws.write = () => {};
                ws.end = () => setImmediate(() => ws.emit('close'));
                return ws;
            },
            chmod(remotePath, mode, done) { done(); },
            end() {},
        });
    }

    end() {}
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
const originalLoad = Module._load;

function loadNodeSetup() {
    Module._load = function patchedLoad(request, parent, isMain) {
        if (normalizePath(parent?.filename).endsWith('/src/services/nodeSetup.js')) {
            if (request === 'ssh2') return { Client: FakeClient };
            if (request === '../../config') {
                return { PANEL_DOMAIN: 'panel.example.com', BASE_URL: 'https://panel.example.com', ACME_EMAIL: 'ops@example.com' };
            }
            if (request === './cryptoService') return { decryptSafe: v => v, decryptPrivateKey: v => v };
            if (request === '../models/settingsModel') {
                return { get: async () => ({ nodeAuth: { insecure: true } }), update: async () => {} };
            }
            if (request === './configGenerator') {
                return {
                    generateXrayConfig: () => '{"inbounds":[]}',
                    generateXraySystemdService: () => '[Service]\nUser=nobody\n',
                };
            }
            if (request === './syncService') {
                return { ensureManualKeyLoaded: async () => {}, _getUsersForNode: async () => [] };
            }
            if (request === '../utils/logger') return quietLogger;
        }
        return originalLoad(request, parent, isMain);
    };
    const modulePath = require.resolve('../src/services/nodeSetup');
    delete require.cache[modulePath];
    return require(modulePath);
}

function acmeNode(xray = {}, overrides = {}) {
    return {
        _id: 'x1',
        name: 'xray-acme',
        ip: '203.0.113.10',
        port: 443,
        type: 'xray',
        domain: 'node.example.net',
        ssh: { password: 'pw' },
        xray: { security: 'tls', tlsSource: 'acme', transport: 'xhttp', acmeEmail: 'ops@example.com', ...xray },
        ...overrides,
    };
}

const realityWithTlsExtra = {
    security: 'reality',
    tlsSource: 'acme',
    extraInbounds: [{ id: 'e1', label: 'xhttp-tls', port: 8443, security: 'tls', transport: 'xhttp' }],
};

(async () => {
    // --- which nodes need :80 ----------------------------------------------
    assert.strictEqual(xrayAcmeNeedsPort80({ security: 'tls', tlsSource: 'acme' }), true);
    assert.strictEqual(xrayAcmeNeedsPort80(realityWithTlsExtra), true, 'TLS on an extra inbound only still needs :80');
    assert.strictEqual(xrayAcmeNeedsPort80({ security: 'tls', tlsSource: 'panel' }), false);
    assert.strictEqual(xrayAcmeNeedsPort80({ security: 'reality', tlsSource: 'acme' }), false, 'no TLS inbound, no acme.sh');
    assert.strictEqual(xrayAcmeNeedsPort80({ security: 'tls', tlsSource: 'acme', front: { enabled: true } }), false,
        'the front obtains the certificate itself');

    // --- validation on the final state ----------------------------------------
    const tls = { security: 'tls', tlsSource: 'acme' };
    assert.strictEqual(validateXrayAcme(tls, { port: 443 }), null);
    assert.match(validateXrayAcme(tls, { port: 443 }, { sameVps: true }), /panel server/);
    assert.match(validateXrayAcme(realityWithTlsExtra, { port: 443 }, { sameVps: true }), /panel server/);
    assert.match(validateXrayAcme(tls, { port: 80 }), /"main" listens on port 80/);
    assert.strictEqual(validateXrayAcme({ ...tls, listen: '127.0.0.1' }, { port: 80 }), null, 'loopback :80 does not block HTTP-01');
    const extraOn80 = { ...tls, extraInbounds: [{ id: 'e2', label: 'plain', port: 80, security: 'none' }] };
    assert.match(validateXrayAcme(extraOn80, { port: 443 }), /"plain" listens on port 80/);
    assert.strictEqual(findPort80Inbound({ extraInbounds: [{ port: 80, listen: '::1' }] }, 443), null);
    assert.strictEqual(validateXrayAcme({ security: 'tls', tlsSource: 'panel' }, { port: 80 }, { sameVps: true }), null,
        'other TLS sources are not affected');

    const nodeSetup = loadNodeSetup();

    // Panel-side entry point: the same rules through isSameVpsAsPanel.
    const frontConfig = require('../src/services/edgeFront/frontConfig');
    assert.match(frontConfig.validateAcme(realityWithTlsExtra, { port: 443, ip: '127.0.0.1' }), /panel server/);
    assert.match(frontConfig.validateAcme(realityWithTlsExtra, { port: 443, ip: '203.0.113.10', domain: 'panel.example.com' }), /panel server/);
    assert.strictEqual(frontConfig.validateAcme(realityWithTlsExtra, { port: 443, ip: '203.0.113.10', domain: 'node.example.net' }), null);
    assert.match(frontConfig.validateAcme(tls, { port: 80, ip: '203.0.113.10' }), /listens on port 80/);

    // --- setup: TCP 80 opened and persisted before acme.sh --------------------
    state.commands = [];
    let result = await nodeSetup.setupXrayNode(acmeNode());
    assert.strictEqual(result.success, true, result.error);
    const port80Idx = state.commands.findIndex(c => c.includes('for the ACME HTTP-01 challenge'));
    const acmeIdx = state.commands.findIndex(c => c.includes('=== ACME setup for'));
    assert.ok(port80Idx !== -1, 'TCP 80 is opened');
    assert.ok(acmeIdx !== -1 && port80Idx < acmeIdx, 'TCP 80 is opened before acme.sh runs');
    const port80Script = state.commands[port80Idx];
    assert.ok(port80Script.includes('iptables -C INPUT -p tcp --dport 80 -j ACCEPT'), 'the rule is not duplicated');
    assert.ok(port80Script.includes('|| iptables -I INPUT -p tcp --dport 80 -j ACCEPT'));
    assert.ok(port80Script.includes('ufw allow 80/tcp') && port80Script.includes('Status: active'));
    assert.ok(port80Script.includes('netfilter-persistent save'), 'the rule survives a reboot');
    assert.ok(!/--dport 80 .*udp|-p udp --dport 80/.test(port80Script), 'HTTP-01 needs TCP only');
    const firewall = state.commands.find(c => c.includes('=== Opening firewall ports ==='));
    assert.ok(firewall.includes('--dport 80 -j ACCEPT'), 'renewals keep :80 in the general firewall step');

    // Reality-only node: no :80.
    state.commands = [];
    result = await nodeSetup.setupXrayNode(acmeNode({ security: 'reality', tlsSource: 'panel', realityPrivateKey: 'p', realityPublicKey: 'q', realityShortIds: ['', 'ab'] }));
    assert.strictEqual(result.success, true, result.error);
    assert.ok(!state.commands.some(c => c.includes('for the ACME HTTP-01 challenge')));
    assert.ok(!state.commands.find(c => c.includes('=== Opening firewall ports ===')).includes('--dport 80 '));

    // FreeBSD: no host firewall managed by the panel.
    state.commands = [];
    const bsdLoad = FakeClient.prototype.exec;
    FakeClient.prototype.exec = function exec(command, cb) {
        if (command === 'uname -s') {
            state.commands.push(command);
            const stream = new EventEmitter();
            stream.stderr = new EventEmitter();
            cb(null, stream);
            setImmediate(() => { stream.emit('data', Buffer.from('FreeBSD\n')); stream.emit('close', 0); });
            return;
        }
        bsdLoad.call(this, command, cb);
    };
    result = await nodeSetup.setupXrayNode({ ...acmeNode(), osFamily: 'freebsd' });
    FakeClient.prototype.exec = bsdLoad;
    assert.strictEqual(result.success, true, result.error);
    assert.ok(!state.commands.some(c => c.includes('iptables')), 'FreeBSD never runs iptables');

    // --- setup refusals -------------------------------------------------------
    state.commands = [];
    result = await nodeSetup.setupXrayNode(acmeNode(realityWithTlsExtra, { ip: '127.0.0.1', port: 9443 }));
    assert.strictEqual(result.success, false, 'TLS only on an extra inbound is refused on the panel server');
    assert.match(result.error, /panel server/);
    assert.deepStrictEqual(state.commands, [], 'refused before connecting');

    result = await nodeSetup.setupXrayNode(acmeNode({ extraInbounds: [{ id: 'e2', label: 'plain', port: 80, security: 'none' }] }));
    assert.strictEqual(result.success, false, 'an inbound on :80 is refused');
    assert.match(result.error, /listens on port 80/);

    // --- acme.sh script -------------------------------------------------------
    for (const osFamily of ['linux', 'freebsd']) {
        const script = nodeSetup.buildAcmeSetupScript({ domain: 'node.example.net', email: 'a@b.c', nodeIp: '203.0.113.10', osFamily });
        const certIdx = script.indexOf('CERT_FILE="${HOME}/.acme.sh/${DOMAIN}_ecc/${DOMAIN}.cer"');
        const busyIdx = script.indexOf('# Pre-flight 2');
        assert.ok(certIdx !== -1 && certIdx < busyIdx, `${osFamily}: the certificate path is known before the port check`);
        assert.ok(script.includes('WARN: Port 80 is held by ${PORT80_HOLDER}. Keeping the existing certificate'),
            `${osFamily}: an existing certificate is kept when :80 is busy`);
        assert.ok(/exit 12\n {4}fi\nfi/.test(script), `${osFamily}: no certificate and busy :80 still fails`);
        assert.ok(script.includes('PORT80_HOLDER="Xray itself'), `${osFamily}: Xray as the holder is named`);
        assert.ok(script.includes("grep -qiE 'Timeout during connect|Connection refused'"));
        assert.ok(script.includes('closed by a firewall or by the hosting provider'), `${osFamily}: closed :80 is explained`);
        assert.ok(script.includes('exit 14'));
        assert.strictEqual(script.split('"${ACME}" --issue ').length - 1, 1, `${osFamily}: one issue call`);
    }
    assert.ok(nodeSetup.buildAcmeSetupScript({ domain: 'n.example.net', email: 'a@b.c', nodeIp: '1.2.3.4' })
        .includes(`ss -tlnpH 'sport = :80' 2>/dev/null | grep -q '"xray"'`));
    assert.ok(nodeSetup.buildAcmeSetupScript({ domain: 'n.example.net', email: 'a@b.c', nodeIp: '1.2.3.4', osFamily: 'freebsd' })
        .includes("awk 'NR > 1 {print $2}' | grep -qx xray"));

    console.log('xray acme tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Module._load = originalLoad;
});
