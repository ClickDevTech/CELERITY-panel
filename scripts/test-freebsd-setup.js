'use strict';

const assert = require('assert');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

// Command builders only; avoid loading the optional TOTP stack.
const totpServicePath = require.resolve('../src/services/totpService');
require.cache[totpServicePath] = { exports: {} };

const HyNode = require('../src/models/hyNodeModel');
const nodeSetup = require('../src/services/nodeSetup');

const BASHISMS = [/systemctl/, /journalctl/, /apt-get/, /\byum\b/, /\bdnf\b/, /\[\[/, /&>/, /<\(/, /\bbash\b/, /\bss -/];
const assertPosixNoSystemd = (script, label) => {
    for (const re of BASHISMS) {
        assert.ok(!re.test(script), `${label} must not contain ${re}`);
    }
};

// --- osFamily detection / model -------------------------------------------
assert.strictEqual(nodeSetup.normalizeOsFamily('FreeBSD\n'), 'freebsd');
assert.strictEqual(nodeSetup.normalizeOsFamily('Linux'), 'linux');
assert.strictEqual(nodeSetup.normalizeOsFamily('Darwin'), 'linux');
assert.strictEqual(nodeSetup.normalizeOsFamily(''), 'linux');
assert.strictEqual(nodeSetup.nodeOsFamily({}), 'linux');
assert.strictEqual(nodeSetup.nodeOsFamily({ osFamily: 'freebsd' }), 'freebsd');

const defaultNode = new HyNode({ name: 'n', type: 'xray', ip: '192.0.2.1' });
assert.strictEqual(defaultNode.osFamily, 'linux');
const freebsdNode = new HyNode({ name: 'n', type: 'xray', ip: '192.0.2.1', osFamily: 'freebsd' });
assert.strictEqual(freebsdNode.osFamily, 'freebsd');
assert.ok(new HyNode({ name: 'n', type: 'xray', ip: '192.0.2.1', osFamily: 'darwin' }).validateSync().errors.osFamily);

// --- service command builders ---------------------------------------------
assert.strictEqual(nodeSetup.buildServiceCommand('linux', 'restart', 'xray'), 'systemctl restart xray');
assert.strictEqual(nodeSetup.buildServiceCommand('linux', 'is-active', 'xray'), 'systemctl is-active xray');
assert.strictEqual(nodeSetup.buildServiceCommand('freebsd', 'restart', 'xray'), 'service xray restart </dev/null >/dev/null 2>&1');
assert.strictEqual(nodeSetup.buildServiceCommand('freebsd', 'enable', 'xray'), 'sysrc xray_enable=YES');
assert.strictEqual(nodeSetup.buildServiceCommand('freebsd', 'disable', 'cc_agent'), 'sysrc cc_agent_enable=NO');
assert.strictEqual(
    nodeSetup.buildServiceCommand('freebsd', 'is-active', 'xray'),
    'service xray status >/dev/null 2>&1 && echo active || echo inactive'
);

const linuxStop = nodeSetup.buildRuntimeStopScript('linux', 'xray');
assert.ok(linuxStop.includes('systemctl stop xray 2>&1 || true'));
assert.ok(linuxStop.includes('systemctl disable xray 2>&1 || true'));
assert.ok(linuxStop.includes('systemctl list-unit-files xray.service'));
const linuxStart = nodeSetup.buildRuntimeStartScript('linux', 'xray');
assert.ok(linuxStart.includes('systemctl daemon-reload 2>&1 || true\nsystemctl enable xray 2>&1\nsystemctl restart xray 2>&1'));
assert.ok(linuxStart.includes('[ "$STATE" = "active" ]'));

const bsdStop = nodeSetup.buildRuntimeStopScript('freebsd', 'xray');
assertPosixNoSystemd(bsdStop, 'freebsd stop script');
assert.ok(bsdStop.includes('[ -x /usr/local/etc/rc.d/xray ]'));
assert.ok(bsdStop.includes('service xray stop 2>&1 || true'));
assert.ok(bsdStop.includes('sysrc xray_enable=NO'));
assert.ok(bsdStop.includes('[ "$STATE" != "active" ]'));
const bsdStart = nodeSetup.buildRuntimeStartScript('freebsd', 'xray');
assertPosixNoSystemd(bsdStart, 'freebsd start script');
// rc.d refuses `restart` unless the knob is set, so enable must come first.
assert.ok(bsdStart.indexOf('sysrc xray_enable=YES') < bsdStart.indexOf('service xray restart'));
assert.ok(bsdStart.includes('[ "$STATE" = "active" ]'));

assert.strictEqual(nodeSetup.buildXrayLogsCommand('linux', 50), 'journalctl -u xray -n 50 --no-pager');
assertPosixNoSystemd(nodeSetup.buildXrayLogsCommand('freebsd', 50), 'freebsd logs command');
assert.ok(nodeSetup.buildXrayLogsCommand('freebsd', 50).includes('service xray status'));

// --- FreeBSD install / start scripts ---------------------------------------
const install = nodeSetup.XRAY_INSTALL_SCRIPT_FREEBSD;
assertPosixNoSystemd(install, 'freebsd install script');
assert.ok(install.includes('pkg install -y xray-core curl'));
assert.ok(install.includes('mkdir -p /usr/local/etc/xray'));
assert.ok(install.includes('pkg install -y xray-core curl unzip'));
assert.ok(!install.startsWith('#!/bin/bash'));
assert.ok(nodeSetup.XRAY_INSTALL_SCRIPT.startsWith('#!/bin/bash'), 'linux install script unchanged');

const start = nodeSetup.buildFreebsdXrayStartScript([443, 8443]);
assertPosixNoSystemd(start, 'freebsd xray start script');
assert.ok(start.includes('sysrc xray_enable=YES'));
assert.ok(start.includes('sysrc xray_config=/usr/local/etc/xray'));
assert.ok(!start.includes('sysctl.conf'));
assert.ok(nodeSetup.xrayPermsSnippet('freebsd').includes('id -gn v2ray'));
assert.ok(nodeSetup.xrayPermsSnippet('freebsd').includes('chmod 640'));
assert.ok(start.indexOf('sysrc xray_enable=YES') < start.indexOf('service xray restart'));
assert.ok(start.includes('service xray status'));
assert.ok(start.includes('for p in 443 8443; do'));
assert.ok(start.includes('sockstat -46l -p "$p"'));
assert.ok(start.includes('listening on 443, 8443'));
assert.ok(!nodeSetup.buildFreebsdXrayStartScript([]).includes('listening on'));

// --- ACME: linux output keeps ss/systemctl, freebsd swaps them --------------
const acmeArgs = { domain: 'node.example.com', email: 'a@b.c', nodeIp: '203.0.113.5' };
const acmeLinux = nodeSetup.buildAcmeSetupScript(acmeArgs);
assert.strictEqual(acmeLinux, nodeSetup.buildAcmeSetupScript({ ...acmeArgs, osFamily: 'linux' }));
assert.ok(acmeLinux.includes("if ss -tlnH 'sport = :80' 2>/dev/null | grep -q LISTEN; then"));
assert.ok(acmeLinux.includes('systemctl reload xray 2>/dev/null || systemctl restart xray 2>/dev/null || true'));
assert.ok(acmeLinux.includes('apt-get update && apt-get install -y curl'));
const acmeBsd = nodeSetup.buildAcmeSetupScript({ ...acmeArgs, osFamily: 'freebsd' });
assertPosixNoSystemd(acmeBsd.replace(/^#!\/bin\/bash\n/, ''), 'freebsd acme script');
assert.ok(acmeBsd.includes('sockstat -46l -P tcp -p 80'));
assert.ok(acmeBsd.includes('service xray restart </dev/null >/dev/null 2>&1 || true'));
assert.ok(acmeBsd.includes('pkg install -y curl'));

// --- cc-agent on FreeBSD ----------------------------------------------------
assert.strictEqual(nodeSetup.buildFreebsdAgentDownloadScript(undefined), '');
assert.strictEqual(nodeSetup.buildFreebsdAgentDownloadScript(''), '');
assert.strictEqual(nodeSetup.buildFreebsdAgentDownloadScript('ftp://host/cc-agent'), '');
assert.strictEqual(nodeSetup.buildFreebsdAgentDownloadScript("https://host/x' ; rm -rf /"), '');
const dl = nodeSetup.buildFreebsdAgentDownloadScript(' https://releases.example.com/cc-agent-freebsd-amd64 ');
assertPosixNoSystemd(dl, 'freebsd agent download script');
assert.ok(dl.includes("URL='https://releases.example.com/cc-agent-freebsd-amd64'"));
assert.ok(dl.includes('--max-time 120 "$URL" -o "$tmp"'));
assert.ok(dl.includes('fetch -q -o "$tmp" "$URL"'));
assert.ok(dl.includes('mv -f "$tmp" /usr/local/bin/cc-agent'));

const rc = nodeSetup.buildCcAgentRcScript();
assertPosixNoSystemd(rc, 'cc_agent rc.d script');
assert.ok(rc.startsWith('#!/bin/sh\n'));
assert.ok(rc.includes('# PROVIDE: cc_agent'));
assert.ok(rc.includes('name="cc_agent"'));
assert.ok(rc.includes('rcvar="cc_agent_enable"'));
assert.ok(rc.includes(': ${cc_agent_config:="/etc/cc-agent/config.json"}'));
assert.ok(rc.includes('command="/usr/sbin/daemon"'));
assert.ok(rc.includes('/usr/local/bin/cc-agent -config ${cc_agent_config}'));
assert.ok(rc.includes('-P ${pidfile}'));
assert.ok(rc.includes('run_rc_command "$1"'));
assert.ok(!rc.includes('\\$'), 'rc.d script must not carry JS escape backslashes');

console.log('freebsd setup tests passed');

// host metrics over SSH: FreeBSD variants must not depend on /proc or GNU tools
const NodeSSH = require('../src/utils/nodeOs');
const bsdStats = NodeSSH.buildSystemStatsScript('freebsd');
for (const bad of ['/proc', 'free -b', 'nproc', 'df -B1']) assert.ok(!bsdStats.includes(bad), `freebsd stats script contains ${bad}`);
for (const need of ['kern.cp_time', 'vm.loadavg', 'hw.ncpu', 'hw.physmem', 'df -k', 'kern.boottime', '===CPUSAMPLE===', '===UPTIME===']) assert.ok(bsdStats.includes(need), `freebsd stats script lacks ${need}`);
assert.ok(NodeSSH.buildSystemStatsScript('linux').includes('head -1 /proc/stat'));
assert.ok(NodeSSH.buildNetStatsCommand('freebsd').includes('netstat -ibn'));
assert.ok(!NodeSSH.buildNetStatsCommand('freebsd').includes('/proc/net/dev'));
assert.ok(NodeSSH.buildNetStatsCommand('linux').includes('/proc/net/dev'));
console.log('freebsd host metrics builders ok');
