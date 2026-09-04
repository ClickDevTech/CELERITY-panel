'use strict';

const assert = require('assert');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const service = require('../src/services/xrayVersionService');

assert.deepStrictEqual(service.parseVersion('v26.7.28'), [26, 7, 28]);
assert.strictEqual(service.normalizeVersion('26.03.027'), '26.3.27');
assert.strictEqual(service.normalizeVersion('latest'), '');
assert.strictEqual(service.compareVersions('26.7.28', '26.3.27'), 1);
assert.strictEqual(service.compareVersions('1.8.24', '26.3.27'), -1);

const fixture = [
    {
        tag_name: 'v26.3.27',
        name: 'Stable',
        body: 'Stable release',
        draft: false,
        prerelease: false,
        published_at: '2026-03-27T00:00:00Z',
        html_url: 'https://github.com/XTLS/Xray-core/releases/tag/v26.3.27',
        assets: [
            {
                name: 'Xray-linux-64.zip',
                browser_download_url: 'https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip',
            },
            {
                name: 'Xray-linux-64.zip.dgst',
                browser_download_url: 'https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip.dgst',
            },
        ],
    },
    {
        tag_name: 'v26.7.28',
        name: 'Preview',
        body: 'Preview release',
        draft: false,
        prerelease: true,
        published_at: '2026-07-28T00:00:00Z',
        html_url: 'https://github.com/XTLS/Xray-core/releases/tag/v26.7.28',
        assets: [
            {
                name: 'Xray-linux-64.zip',
                browser_download_url: 'https://github.com/XTLS/Xray-core/releases/download/v26.7.28/Xray-linux-64.zip',
            },
            {
                name: 'Xray-linux-64.zip.dgst',
                browser_download_url: 'https://github.com/XTLS/Xray-core/releases/download/v26.7.28/Xray-linux-64.zip.dgst',
            },
        ],
    },
    { tag_name: 'v99.0.0', draft: true, prerelease: false, assets: [] },
    { tag_name: 'latest; rm -rf /', draft: false, prerelease: false, assets: [] },
];

const releases = service.normalizeReleases(fixture);
assert.deepStrictEqual(releases.map(release => release.version), ['26.7.28', '26.3.27']);
assert.strictEqual(releases[0].prerelease, true);
assert.strictEqual(releases[1].prerelease, false);

const asset = service.selectReleaseAsset(releases[0], 'x86_64');
assert.ok(asset);
assert.strictEqual(asset.archiveName, 'Xray-linux-64.zip');
assert.strictEqual(service.selectReleaseAsset(releases[0], 'unknown-arch'), null);

const poisonedRelease = {
    ...releases[0],
    assets: releases[0].assets.map(item => ({
        ...item,
        url: item.url.replace('https://github.com/', 'https://example.com/'),
    })),
};
assert.strictEqual(service.selectReleaseAsset(poisonedRelease, 'x86_64'), null);

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const script = service.buildUpdateScript({
    release: releases[0],
    asset,
    requestId,
});
assert.match(script, /SHA2-256/);
assert.match(script, /checksum mismatch/);
assert.match(script, /run -test -config/);
assert.match(script, /ROLLBACK: previous Xray binary restored/);
assert.match(script, /mv -f "\$BIN\.new" "\$BIN"/);
assert.match(script, /^echo "SWAPPED=1"$/m);
// The swap keeps the running process alive; restarting is the sync step's job,
// so a successful run must cost exactly one restart.
assert.doesNotMatch(script, /systemctl (stop|start|restart) xray/);


const rollback = service.buildRollbackScript(requestId);
assert.match(rollback, /previous Xray version restored/);
assert.match(rollback, /systemctl start xray/);

assert.throws(() => service.buildUpdateScript({
    release: { ...releases[0], tag: 'v26.7.28; touch /tmp/pwned' },
    asset,
    requestId,
}), /Invalid Xray update parameters/);
assert.throws(() => service.buildRollbackScript('../../etc'), /Invalid Xray update task id/);

async function simulateVersionChange({ currentVersion, release, syncSuccess, scriptFailure = 'none' }) {
    const HyNode = require('../src/models/hyNodeModel');
    const nodeSetup = require('../src/services/nodeSetup');
    const syncService = require('../src/services/syncService');
    const logger = require('../src/utils/logger');
    const originals = {
        findById: HyNode.findById,
        updateOne: HyNode.updateOne,
        connectSSH: nodeSetup.connectSSH,
        execSSH: nodeSetup.execSSH,
        updateXrayNodeConfig: syncService.updateXrayNodeConfig,
        loggerInfo: logger.info,
        loggerError: logger.error,
    };
    const commands = [];
    const node = {
        _id: '507f1f77bcf86cd799439011',
        name: 'test-node',
        type: 'xray',
        status: 'online',
        cascadeRole: 'standalone',
        ssh: { password: 'encrypted' },
        xray: {},
    };
    const task = {
        id: '123e4567-e89b-42d3-a456-426614174000',
        nodeId: String(node._id),
        state: 'running',
        step: 'queued',
        currentVersion: null,
        targetVersion: release.version,
        error: null,
        rollbackSucceeded: false,
        logs: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
    };

    try {
        HyNode.findById = async () => node;
        HyNode.updateOne = async () => ({ acknowledged: true });
        nodeSetup.connectSSH = async () => ({ end() {} });
        nodeSetup.execSSH = async (_conn, command) => {
            commands.push(command);
            if (command.includes('ARCH="$(uname -m)"')) {
                return { success: true, output: `ARCH=x86_64\nVERSION=${currentVersion}\n` };
            }
            if (command.includes('VERSION="$(xray version')) {
                return { success: true, output: `VERSION=${release.version}\n` };
            }
            if (command.includes('curl -fL')) {
                if (scriptFailure === 'before-swap') {
                    return { success: false, output: 'ERROR: Xray archive checksum mismatch\n' };
                }
                if (scriptFailure === 'after-swap') {
                    return {
                        success: false,
                        output: 'SWAPPED=1\nERROR: installed version does not match target\n'
                            + 'ROLLBACK: previous Xray binary restored\n',
                    };
                }
                return { success: true, output: `SWAPPED=1\nUPDATED_VERSION=${release.version}\n` };
            }
            if (command.includes('previous Xray version restored')) {
                return { success: true, output: 'ROLLBACK: previous Xray version restored\n' };
            }
            return { success: true, output: '' };
        };
        syncService.updateXrayNodeConfig = async () => syncSuccess;
        logger.info = () => {};
        logger.error = () => {};
        await service._test.runVersionChange(task, release);
        return { task, commands };
    } finally {
        HyNode.findById = originals.findById;
        HyNode.updateOne = originals.updateOne;
        nodeSetup.connectSSH = originals.connectSSH;
        nodeSetup.execSSH = originals.execSSH;
        syncService.updateXrayNodeConfig = originals.updateXrayNodeConfig;
        logger.info = originals.loggerInfo;
        logger.error = originals.loggerError;
    }
}

(async () => {
    const upgraded = await simulateVersionChange({
        currentVersion: '1.8.24',
        release: releases[1],
        syncSuccess: true,
    });
    assert.strictEqual(upgraded.task.state, 'done');
    assert.strictEqual(upgraded.task.currentVersion, '1.8.24');

    const reinstalled = await simulateVersionChange({
        currentVersion: '26.3.27',
        release: releases[1],
        syncSuccess: true,
    });
    assert.strictEqual(reinstalled.task.state, 'done');

    const rolledBack = await simulateVersionChange({
        currentVersion: '26.7.28',
        release: releases[1],
        syncSuccess: false,
    });
    assert.strictEqual(rolledBack.task.state, 'error');
    assert.strictEqual(rolledBack.task.rollbackSucceeded, true);
    assert.strictEqual(rolledBack.task.nodeUnchanged, false);
    assert.ok(rolledBack.commands.some(command => command.includes('previous Xray version restored')));

    // Failing before the swap must not be reported as a failed rollback: the
    // remote script never touched the binary.
    const abortedEarly = await simulateVersionChange({
        currentVersion: '26.3.27',
        release: releases[1],
        syncSuccess: true,
        scriptFailure: 'before-swap',
    });
    assert.strictEqual(abortedEarly.task.state, 'error');
    assert.strictEqual(abortedEarly.task.nodeUnchanged, true);
    assert.strictEqual(abortedEarly.task.rollbackSucceeded, false);

    // Failing after the swap: the script's own trap restored the binary.
    const selfHealed = await simulateVersionChange({
        currentVersion: '26.3.27',
        release: releases[1],
        syncSuccess: true,
        scriptFailure: 'after-swap',
    });
    assert.strictEqual(selfHealed.task.state, 'error');
    assert.strictEqual(selfHealed.task.nodeUnchanged, false);
    assert.strictEqual(selfHealed.task.rollbackSucceeded, true);

    // The version list must stay lightweight: changelog bodies are fetched
    // per release instead of being shipped with every status response.
    const cacheService = require('../src/services/cacheService');
    const originalIsConnected = cacheService.isConnected;
    const originalFetch = global.fetch;
    try {
        cacheService.isConnected = () => false;
        global.fetch = async () => ({ ok: true, json: async () => fixture });
        const info = await service.getVersionInfo({ force: true });
        assert.ok(info.releases.length > 0);
        assert.ok(info.releases.every(item => item.body === undefined));
        assert.strictEqual(info.releases[0].hasChangelog, true);
        const changelog = await service.getReleaseChangelog('26.3.27');
        assert.strictEqual(changelog.body, 'Stable release');
        assert.strictEqual(await service.getReleaseChangelog('0.0.1'), null);
    } finally {
        cacheService.isConnected = originalIsConnected;
        global.fetch = originalFetch;
    }

    console.log('xray version service tests passed');
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
