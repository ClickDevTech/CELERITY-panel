'use strict';

// Backup archive verification: real tar.gz round-trip, corrupt/empty rejection.
// Skips gracefully when no `tar` binary is available (e.g. minimal Windows).

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function hasTar() {
    try {
        await execFileAsync('tar', ['--version']);
        return true;
    } catch {
        return false;
    }
}

(async () => {
    if (!(await hasTar())) {
        console.log('backup verify tests skipped (no tar binary)');
        return;
    }
    const { verifyArchive } = require('../src/services/backupService');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-backup-test-'));
    try {
        // Valid archive with the manifest entry.
        const name = 'celerity-backup-2026-01-01T00-00-00';
        const src = path.join(dir, name);
        fs.mkdirSync(src, { recursive: true });
        fs.writeFileSync(path.join(src, 'dump.bson'), 'fake');
        fs.writeFileSync(path.join(src, 'celerity-meta.json'), '{}');
        const archive = path.join(dir, name + '.tar.gz');
        await execFileAsync('tar', ['-czf', archive, '-C', dir, name]);
        const ok = await verifyArchive(archive, name);
        assert.strictEqual(ok.ok, true);
        assert.ok(ok.entries >= 3, 'dump + meta + dir entries, got ' + ok.entries);

        // Truncated archive must throw.
        const buf = fs.readFileSync(archive);
        const cut = path.join(dir, 'cut.tar.gz');
        fs.writeFileSync(cut, buf.subarray(0, Math.floor(buf.length / 2)));
        await assert.rejects(() => verifyArchive(cut, name), /verification failed/);

        // Garbage file must throw.
        const garbage = path.join(dir, 'garbage.tar.gz');
        fs.writeFileSync(garbage, 'not a tarball at all');
        await assert.rejects(() => verifyArchive(garbage, name), /verification failed/);

        // Archive without the manifest must throw.
        const src2 = path.join(dir, 'other');
        fs.mkdirSync(src2, { recursive: true });
        fs.writeFileSync(path.join(src2, 'x.txt'), 'x');
        const noMeta = path.join(dir, 'nometa.tar.gz');
        await execFileAsync('tar', ['-czf', noMeta, '-C', dir, 'other']);
        await assert.rejects(() => verifyArchive(noMeta, 'other'), /manifest/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('backup verify tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
