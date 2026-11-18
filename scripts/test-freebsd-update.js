'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const service = require('../src/services/xrayVersionService');

// Exercise the generated scripts in a temporary node filesystem. The staged
// target config is valid even though the installed config uses the old syntax.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'celerity-freebsd-test-'));
const tools = path.join(root, 'commands');
const id = '123e4567-e89b-42d3-a456-426614174000';
const backup = path.join(root, 'updates', id);
const binary = path.join(root, 'xray');
const config = path.join(root, 'config.json');
const checksum = 'a'.repeat(64);
const release = { tag: 'v26.7.28', version: '26.7.28' };
const asset = { archiveUrl: 'https://example.com/xray.zip', digestUrl: 'https://example.com/xray.zip.dgst' };

function tool(name, body) {
    fs.writeFileSync(path.join(tools, name), '#!/bin/sh\nset -eu\n' + body + '\n', { mode: 0o755 });
}
function run(script, env = {}) {
    const localized = script.replaceAll('/usr/local/bin/xray', binary)
        .replaceAll('/usr/local/etc/xray/config.json', config)
        .replaceAll('/var/lib/celerity-xray-updates', path.join(root, 'updates'))
        .replaceAll('/tmp/celerity-xray-update.', path.join(root, 'tmp.'));
    return spawnSync('/bin/sh', ['-s'], { input: localized, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: tools + ':' + process.env.PATH, ROOT: root, DIGEST: checksum, ...env } });
}
try {
    fs.mkdirSync(tools);
    tool('curl', `for dest do :; done
case "$*" in *.dgst*) printf 'SHA2-256= %s\\n' "$DIGEST" > "$dest";; *) echo archive > "$dest";; esac`);
    tool('sha256', 'echo ' + checksum);
    tool('unzip', 'for dest do :; done\ncp "$ROOT/new" "$dest/xray"');
    tool('service', 'exit 0');
    tool('pgrep', 'exit 1');
    tool('sleep', 'exit 0');
    tool('pkg', `case "$1" in
which) echo security/xray-core;; query) cat "$ROOT/lock";;
lock) echo 1 > "$ROOT/lock";; unlock) echo 0 > "$ROOT/lock";; *) exit 1;; esac`);
    fs.writeFileSync(path.join(root, 'new'), '#!/bin/sh\nif [ "$1" = version ]; then echo "Xray 26.7.28"; else for config do :; done; grep -q new-format "$config"; fi\n');
    fs.writeFileSync(binary, 'old binary', { mode: 0o755 });
    fs.writeFileSync(config, 'old-format');
    fs.writeFileSync(path.join(root, 'lock'), '0\n');
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'candidate-config.json'), 'new-format');

    const update = service.buildUpdateScript({ release, asset, requestId: id, osFamily: 'freebsd' });
    let result = run(update);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /SWAPPED=1/);
    assert.equal(fs.readFileSync(path.join(root, 'lock'), 'utf8'), '0\n');
    result = run(service._test.buildVerificationScript(id, release.version, 'freebsd'));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(fs.readFileSync(path.join(root, 'lock'), 'utf8'), '1\n');
    result = run(service.buildRollbackScript(id, 'freebsd'));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(fs.readFileSync(binary, 'utf8'), 'old binary');
    assert.equal(fs.readFileSync(config, 'utf8'), 'old-format');
    assert.equal(fs.readFileSync(path.join(root, 'lock'), 'utf8'), '0\n');

    result = run(update, { DIGEST: '0'.repeat(64) });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /checksum mismatch/);
    assert.equal(fs.readFileSync(binary, 'utf8'), 'old binary');
    assert.equal(fs.existsSync(backup), false);
    console.log('FreeBSD update, package lock, rollback and checksum tests passed');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
