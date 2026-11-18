/**
 * Hysteria config rollback (no network).
 *
 * Verifies NodeSSH.updateConfig:
 *   - a config that passes `hysteria check` but fails to start is replaced by
 *     the previous one and the service is started again,
 *   - without a previous config (first upload) nothing is restored, and a stale
 *     .bak from an earlier run is removed instead of being restored later,
 *   - a config rejected by `hysteria check` is rolled back without a restart,
 *   - a successful restart keeps the new config.
 */

const assert = require('assert');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const NodeSSH = require('../src/services/nodeSSH');
const sshPool = require('../src/services/sshPoolService');

const CONFIG = '/etc/hysteria/config.yaml';

function fakeNode({ hasConfig = true, checkOutput = '', restarts = [true] } = {}) {
    const ssh = new NodeSSH({ _id: 'h1', name: 'hy-test', paths: { config: CONFIG } });
    const calls = [];
    const results = [...restarts];
    ssh.exec = async (command) => {
        calls.push(command);
        if (command.startsWith(`if [ -f ${CONFIG} ]`)) {
            return { code: 0, stdout: hasConfig ? 'CC_BACKUP_OK\n' : '', stderr: '' };
        }
        if (command.includes('hysteria check')) return { code: 0, stdout: checkOutput, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
    };
    ssh.writeFile = async (remotePath) => { calls.push(`write ${remotePath}`); };
    ssh.reloadHysteria = async () => {
        calls.push('restart');
        return results.length ? results.shift() : true;
    };
    return { ssh, calls };
}

const restore = `mv -f ${CONFIG}.bak ${CONFIG}`;

(async () => {
    try {
        // Restart fails after a passed check: previous config is restored and started.
        let { ssh, calls } = fakeNode({ restarts: [false, true] });
        assert.strictEqual(await ssh.updateConfig('listen: :443\n'), false);
        assert.ok(calls.includes(restore), 'previous config is restored');
        assert.deepStrictEqual(calls.filter(c => c === 'restart').length, 2, 'service is started again');
        assert.ok(calls.indexOf(restore) < calls.lastIndexOf('restart'), 'restore happens before the second start');

        // First upload: there is nothing to restore, and a stale .bak is removed.
        ({ ssh, calls } = fakeNode({ hasConfig: false, restarts: [false] }));
        assert.strictEqual(await ssh.updateConfig('listen: :443\n'), false);
        assert.ok(calls[0].includes(`rm -f ${CONFIG}.bak`), 'stale backup is dropped');
        assert.ok(!calls.some(c => c.startsWith('mv ')), 'nothing is restored without a backup');
        assert.strictEqual(calls.filter(c => c === 'restart').length, 1);

        // Check rejects the config: rolled back, no restart.
        ({ ssh, calls } = fakeNode({ checkOutput: 'error: invalid config' }));
        assert.strictEqual(await ssh.updateConfig('bad'), false);
        assert.ok(calls.includes(`mv ${CONFIG}.bak ${CONFIG}`));
        assert.ok(!calls.includes('restart'), 'rejected config is never started');

        // Success keeps the new config.
        ({ ssh, calls } = fakeNode({ restarts: [true] }));
        assert.strictEqual(await ssh.updateConfig('listen: :443\n'), true);
        assert.ok(!calls.some(c => c.startsWith('mv')), 'nothing is restored on success');

        console.log('test-hysteria-rollback: OK');
    } finally {
        sshPool.closeAll();
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
