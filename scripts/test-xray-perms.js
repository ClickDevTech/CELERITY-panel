/**
 * Node setup permissions and start verification (no network, no MongoDB).
 *
 * Verifies:
 *   - the Xray permission snippet pins 750/640 root:<nobody group>, checks that
 *     nobody can read the config and refuses unsafe directory paths,
 *   - setupXrayNode uploads the config as 0640, pins permissions after the
 *     config/certificates and before the restart, and fails when the snippet
 *     fails (no restart onto an unreadable config),
 *   - setup fails with the journal tail when xray / hysteria-server is not
 *     active after the restart, instead of reporting success,
 *   - ACME hands the Xray key to root:<nobody group> 640, never to nobody/600,
 *   - the Hysteria ACME directory is 700, never world-writable,
 *   - the installer's xray.service (User=xray), which would lose access to the
 *     re-owned config, is replaced by the panel's unit without touching the
 *     service state; units running as nobody or root are left alone,
 *   - when run as root on Linux, the snippet really produces the expected
 *     modes and ownership on a scratch directory.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

const state = { commands: [], uploads: [], rule: () => null };

class FakeClient extends EventEmitter {
    connect() {
        setImmediate(() => this.emit('ready'));
    }

    exec(command, cb) {
        state.commands.push(command);
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(null, stream);
        const res = state.rule(command) || { code: 0, out: '' };
        setImmediate(() => {
            if (res.out) stream.emit('data', Buffer.from(res.out));
            stream.emit('close', res.code);
        });
    }

    sftp(cb) {
        cb(null, {
            createWriteStream(remotePath, opts) {
                const ws = new EventEmitter();
                let content = '';
                ws.write = (chunk) => { content += chunk; };
                ws.end = () => {
                    state.uploads.push({ path: remotePath, mode: opts && opts.mode, content });
                    setImmediate(() => ws.emit('close'));
                };
                return ws;
            },
            chmod(remotePath, mode, done) { done(); },
            end() {},
        });
    }

    end() {}
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
const PANEL_UNIT = '[Unit]\nDescription=Xray Service\n\n[Service]\nUser=nobody\n';

const originalLoad = Module._load;

// The patch stays active for the whole run: nodeSetup requires syncService
// lazily inside setupXrayNode.
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
                    generateXraySystemdService: () => PANEL_UNIT,
                    generateNodeConfig: () => 'listen: :443\n',
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

function reset(rule = () => null) {
    state.commands = [];
    state.uploads = [];
    state.rule = rule;
}

function xrayNode(xray = {}) {
    return {
        _id: 'x1',
        name: 'xray-test',
        ip: '203.0.113.10',
        port: 443,
        type: 'xray',
        ssh: { password: 'pw' },
        xray: {
            security: 'reality',
            realityPrivateKey: 'priv',
            realityPublicKey: 'pub',
            realityShortIds: ['', 'abcd'],
            ...xray,
        },
    };
}

const isInstall = c => c.includes('Installing Xray-core');
const isPermsOnly = c => c.includes("XRAY_DIR='/usr/local/etc/xray'") && !isInstall(c);
const isRestart = c => c.includes('systemctl restart xray');

(async () => {
    const nodeSetup = loadNodeSetup();

    // Snippet content and path guard.
    const snippet = nodeSetup.XRAY_PERMS_SNIPPET;
    assert.ok(snippet.includes('id -gn nobody'), 'group of nobody is detected per distro');
    assert.ok(snippet.includes('chmod 750 "$XRAY_DIR"'));
    assert.ok(snippet.includes('chmod 640 "$XRAY_DIR/$f"'));
    assert.ok(/for f in config\.json config\.json\.prev key\.pem/.test(snippet), 'secrets are 640');
    assert.ok(snippet.includes('runuser -u nobody -- test -r'), 'readability is verified as nobody');
    assert.ok(!/chmod (6|7)[0-7]7/.test(snippet), 'nothing becomes world-writable');
    assert.ok(nodeSetup.buildXrayPermsScript('/usr/local/etc/xray-bridge').includes("XRAY_DIR='/usr/local/etc/xray-bridge'"));
    for (const bad of ['relative/dir', "/tmp/x'; rm -rf /", '/tmp/$(id)', '/tmp/a b']) {
        assert.throws(() => nodeSetup.buildXrayPermsScript(bad), /unsafe directory path/);
    }

    // The installer's xray.service (User=xray) is moved onto nobody before the
    // directory changes hands, never disabled.
    assert.ok(snippet.indexOf('xray_unit_prop User') < snippet.indexOf('chown root:"$XRAY_GROUP" "$XRAY_DIR"'),
        'the unit user is aligned before permissions change');
    assert.ok(snippet.includes(Buffer.from(PANEL_UNIT).toString('base64')), "the panel's unit is installed");
    assert.throws(() => nodeSetup.buildXrayUnitUserScript('/tmp/$(id)'), /unsafe directory path/);
    assert.ok(!snippet.includes('--value'), 'works on systemd < 230');
    assert.ok(!/systemctl (disable|stop|restart)/.test(snippet), 'service state is not changed');

    // Successful Xray setup: order and modes.
    reset();
    let result = await nodeSetup.setupXrayNode(xrayNode());
    assert.strictEqual(result.success, true, result.error);
    assert.ok(state.commands.some(c => isInstall(c) && c.includes('chmod 750 "$XRAY_DIR"')),
        'the install script pins the directory left by the upstream installer');
    const configUpload = state.uploads.find(u => u.path === '/usr/local/etc/xray/config.json');
    assert.strictEqual(configUpload.mode, 0o640, 'config is uploaded without world read access');
    const permsIdx = state.commands.findIndex(isPermsOnly);
    const restartIdx = state.commands.findIndex(isRestart);
    assert.ok(permsIdx !== -1 && restartIdx !== -1 && permsIdx < restartIdx, 'permissions pinned before restart');
    assert.ok(/systemctl is-active --quiet xray\s*$/.test(state.commands[restartIdx]),
        'the restart script exit code is the service state');

    // Xray not active after restart: setup fails with the journal tail.
    reset(c => (isRestart(c)
        ? { code: 3, out: 'Journal (last 15 lines):\nFailed to start: open /usr/local/etc/xray/config.json: permission denied\n' }
        : null));
    result = await nodeSetup.setupXrayNode(xrayNode());
    assert.strictEqual(result.success, false, 'a dead service is not reported as success');
    assert.ok(/xray is not active after restart/.test(result.error));
    assert.ok(/permission denied/.test(result.error), 'the journal tail explains the failure');

    // Permission snippet fails: no restart onto an unreadable config.
    reset(c => (isPermsOnly(c) ? { code: 21, out: 'ERROR: user nobody cannot read /usr/local/etc/xray/config.json\n' } : null));
    result = await nodeSetup.setupXrayNode(xrayNode());
    assert.strictEqual(result.success, false);
    assert.ok(/not readable|readable by the service user/.test(result.error));
    assert.ok(!state.commands.some(isRestart), 'Xray is not restarted');

    // ACME: key handed to root:<nobody group> 640.
    reset();
    result = await nodeSetup.setupXrayNode({
        ...xrayNode({ security: 'tls', tlsSource: 'acme', acmeEmail: 'ops@example.com', transport: 'tcp' }),
        domain: 'node.example.net',
    });
    const acme = state.commands.find(c => c.includes('acme.sh'));
    assert.ok(acme, 'ACME script executed');
    assert.ok(acme.includes('chown "root:${NOBODY_GROUP}"') && acme.includes("chown 'root:${NOBODY_GROUP}'"),
        'initial install and renewal keep root as the owner');
    assert.ok(acme.includes('chmod 640 "${KEY_PATH}"') && acme.includes("chmod 640 '${KEY_PATH}'"));
    assert.ok(!/chown ["']nobody:/.test(acme), 'the key is not handed to nobody');

    // Hysteria: ACME directory is 700 and a dead service fails the setup.
    reset(c => (c.includes('systemctl restart hysteria-server')
        ? { code: 3, out: 'Journal logs (last 20 lines):\nFATAL failed to load server config\n' }
        : null));
    result = await nodeSetup.setupNode({
        _id: 'h1', name: 'hy-test', ip: '203.0.113.20', port: 443, type: 'hysteria',
        domain: 'hy.example.net', ssh: { password: 'pw' },
    }, { setupPortHopping: false });
    const acmePrep = state.commands.find(c => c.includes('Setting up for ACME'));
    assert.ok(acmePrep.includes('chmod 700 /etc/hysteria/acme'));
    assert.ok(!acmePrep.includes('777'), 'no world-writable ACME directory');
    assert.strictEqual(result.success, false);
    assert.ok(/hysteria-server is not active after restart/.test(result.error));
    assert.ok(/failed to load server config/.test(result.error));

    // Real run of the unit snippet against a fake systemctl (Linux only). The
    // fake reports the User= line of the unit file, unless a drop-in overrides it.
    if (process.platform === 'linux') {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-unit-'));
        const bin = path.join(root, 'bin');
        const unitDir = path.join(root, 'units');
        const unitFile = path.join(unitDir, 'xray.service');
        const calls = path.join(root, 'calls.log');
        fs.mkdirSync(bin);
        fs.mkdirSync(unitDir);
        fs.writeFileSync(path.join(bin, 'systemctl'), [
            '#!/bin/sh',
            `echo "$*" >> '${calls}'`,
            `U="$(sed -n 's/^User=//p' '${unitFile}' 2>/dev/null)"`,
            '[ -n "$FAKE_DROPIN_USER" ] && U="$FAKE_DROPIN_USER"',
            'case "$*" in',
            '  "show -p User xray") echo "User=$U" ;;',
            '  "show -p Group xray") echo "Group=$FAKE_GROUP" ;;',
            '  "show -p LoadState xray") echo "LoadState=$FAKE_LOAD" ;;',
            'esac',
            'exit 0',
            '',
        ].join('\n'), { mode: 0o755 });
        const script = nodeSetup.buildXrayUnitUserScript(unitDir);
        const installerUnit = '[Service]\nUser=xray\n';
        const runUnit = (unit, env = {}) => {
            fs.writeFileSync(unitFile, unit);
            fs.rmSync(calls, { force: true });
            let code = 0;
            try {
                execFileSync('bash', ['-c', script], {
                    stdio: 'pipe',
                    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOAD: 'loaded', ...env },
                });
            } catch (err) {
                code = err.status;
            }
            const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
            return { code, unit: fs.readFileSync(unitFile, 'utf8'), reloaded: log.includes('daemon-reload') };
        };

        let run = runUnit(installerUnit);
        assert.strictEqual(run.code, 0);
        assert.strictEqual(run.unit, PANEL_UNIT, 'installer unit (User=xray) is replaced by the panel unit');
        assert.strictEqual(run.reloaded, true);
        assert.ok(!fs.existsSync(`${unitFile}.tmp`), 'no temporary file is left behind');
        for (const unit of [PANEL_UNIT, '[Service]\nExecStart=/usr/local/bin/xray\n']) {
            run = runUnit(unit);
            assert.strictEqual(run.code, 0);
            assert.strictEqual(run.unit, unit, 'units running as nobody or root are left alone');
            assert.strictEqual(run.reloaded, false);
        }
        run = runUnit(installerUnit, { FAKE_LOAD: 'not-found' });
        assert.strictEqual(run.unit, installerUnit, 'a unit systemd does not know is left alone');
        assert.strictEqual(runUnit(installerUnit, { FAKE_DROPIN_USER: 'xray' }).code, 22,
            'a drop-in that keeps User=xray fails loudly');
        assert.strictEqual(runUnit(installerUnit, { FAKE_GROUP: 'xray' }).code, 22,
            'a drop-in that keeps Group=xray fails loudly');
        fs.rmSync(root, { recursive: true, force: true });
        console.log('test-xray-perms: real unit snippet run OK');
    }

    // Real run of the snippet (root on Linux only).
    const canRunReal = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
    if (canRunReal) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-perms-'));
        fs.chmodSync(dir, 0o700);
        fs.writeFileSync(path.join(dir, 'config.json'), '{}', { mode: 0o600 });
        fs.writeFileSync(path.join(dir, 'key.pem'), 'k', { mode: 0o600 });
        fs.writeFileSync(path.join(dir, 'cert.pem'), 'c', { mode: 0o600 });
        execFileSync('bash', ['-c', nodeSetup.buildXrayPermsScript(dir)], { stdio: 'pipe' });
        const group = execFileSync('id', ['-g', 'nobody']).toString().trim();
        const check = (name, mode) => {
            const st = fs.statSync(name ? path.join(dir, name) : dir);
            assert.strictEqual(st.mode & 0o777, mode, `${name || 'dir'} mode`);
            assert.strictEqual(st.uid, 0, `${name || 'dir'} owner`);
            assert.strictEqual(String(st.gid), group, `${name || 'dir'} group`);
        };
        check('', 0o750);
        check('config.json', 0o640);
        check('key.pem', 0o640);
        check('cert.pem', 0o644);
        fs.rmSync(dir, { recursive: true, force: true });
        console.log('test-xray-perms: real snippet run OK');
    }

    Module._load = originalLoad;
    console.log('test-xray-perms: OK');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
