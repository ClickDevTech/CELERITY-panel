'use strict';

/**
 * Xray release discovery and transactional per-node binary changes.
 *
 * Release metadata is cached in Redis. A version change downloads an official
 * release asset on the node, verifies its digest, validates the current config
 * with the new binary, then atomically swaps binaries. The previous binary and
 * config remain available until panel-driven user/cascade synchronization has
 * completed, allowing a full rollback on any failure.
 */

const crypto = require('crypto');

const cache = require('./cacheService');
const nodeSetup = require('./nodeSetup');
const HyNode = require('../models/hyNodeModel');
const logger = require('../utils/logger');
const { invalidateNodesCache } = require('../utils/helpers');

const RELEASES_URL = 'https://api.github.com/repos/XTLS/Xray-core/releases?per_page=100';
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/XTLS/Xray-core/releases/download/';
const CACHE_KEY = 'xray:updates:releases';
// A single entry is kept for a long time and reused as the stale fallback when
// GitHub is unreachable; FRESH_TTL_MS decides when a refetch is attempted.
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const FRESH_TTL_MS = 6 * 60 * 60 * 1000;
const TASK_TTL_MS = 60 * 60 * 1000;
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const TASK_ID_RE = /^[0-9a-f-]{36}$/i;

const tasks = new Map();

function parseVersion(value) {
    const match = VERSION_RE.exec(String(value || '').trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function normalizeVersion(value) {
    const parsed = parseVersion(value);
    return parsed ? parsed.join('.') : '';
}

function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) return 0;
    for (let i = 0; i < left.length; i++) {
        if (left[i] > right[i]) return 1;
        if (left[i] < right[i]) return -1;
    }
    return 0;
}

function normalizeReleases(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(release => release && !release.draft && parseVersion(release.tag_name))
        .map(release => ({
            version: normalizeVersion(release.tag_name),
            tag: `v${normalizeVersion(release.tag_name)}`,
            name: String(release.name || release.tag_name || '').slice(0, 200),
            body: String(release.body || '').slice(0, 4000),
            prerelease: !!release.prerelease,
            publishedAt: release.published_at || null,
            htmlUrl: String(release.html_url || '').slice(0, 500),
            assets: Array.isArray(release.assets)
                ? release.assets
                    .filter(asset => asset && typeof asset.name === 'string'
                        && typeof asset.browser_download_url === 'string')
                    .map(asset => ({
                        name: asset.name.slice(0, 200),
                        url: asset.browser_download_url.slice(0, 1000),
                    }))
                : [],
        }))
        .sort((a, b) => compareVersions(b.version, a.version));
}

async function fetchReleasesFromGitHub() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(RELEASES_URL, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'celerity-xray-updater',
            },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`GitHub API returned HTTP ${response.status}`);
        }
        return normalizeReleases(await response.json());
    } finally {
        clearTimeout(timer);
    }
}

async function readCachedReleases() {
    if (!cache.isConnected()) return null;
    const raw = await cache.redis.get(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
        releases: Array.isArray(parsed.releases) ? parsed.releases : [],
        checkedAt: parsed.checkedAt || null,
    };
}

function isFresh(cached) {
    if (!cached?.checkedAt) return false;
    const age = Date.now() - new Date(cached.checkedAt).getTime();
    return Number.isFinite(age) && age >= 0 && age < FRESH_TTL_MS;
}

async function loadReleases({ force = false } = {}) {
    let cached = null;
    try {
        cached = await readCachedReleases();
    } catch (error) {
        logger.warn(`[Xray Update] Release cache read failed: ${error.message}`);
    }
    if (!force && isFresh(cached)) return { ...cached, error: null };

    try {
        const releases = await fetchReleasesFromGitHub();
        const checkedAt = new Date().toISOString();
        if (cache.isConnected()) {
            await cache.redis.setex(
                CACHE_KEY,
                CACHE_TTL_SECONDS,
                JSON.stringify({ releases, checkedAt })
            );
        }
        return { releases, checkedAt, error: null };
    } catch (error) {
        logger.warn(`[Xray Update] Release fetch failed: ${error.message}`);
        return {
            releases: cached?.releases || [],
            checkedAt: cached?.checkedAt || null,
            error: error.message,
        };
    }
}

/**
 * Release entry for the version list. Changelog bodies are intentionally left
 * out: with ~100 releases they dominate the payload, so the UI pulls the text
 * of a single release on demand through getReleaseChangelog().
 */
function publicRelease(release) {
    return {
        version: release.version,
        tag: release.tag,
        name: release.name,
        hasChangelog: !!release.body,
        prerelease: release.prerelease,
        publishedAt: release.publishedAt,
        htmlUrl: release.htmlUrl,
    };
}

async function getVersionInfo({ force = false } = {}) {
    const data = await loadReleases({ force });
    const stable = data.releases.find(release => !release.prerelease) || null;
    const prerelease = data.releases.find(release => release.prerelease) || null;
    return {
        latestVersion: stable?.version || null,
        latestPrereleaseVersion: prerelease?.version || null,
        releases: data.releases.map(publicRelease),
        checkedAt: data.checkedAt,
        error: data.error,
    };
}

async function getKnownRelease(version) {
    const target = normalizeVersion(version);
    if (!target) return null;
    const data = await loadReleases();
    return data.releases.find(release => release.version === target) || null;
}

async function getReleaseChangelog(version) {
    const release = await getKnownRelease(version);
    if (!release) return null;
    return {
        version: release.version,
        tag: release.tag,
        name: release.name,
        body: release.body,
        htmlUrl: release.htmlUrl,
    };
}

const ARCH_ASSETS = {
    x86_64: 'Xray-linux-64.zip',
    amd64: 'Xray-linux-64.zip',
    i386: 'Xray-linux-32.zip',
    i486: 'Xray-linux-32.zip',
    i586: 'Xray-linux-32.zip',
    i686: 'Xray-linux-32.zip',
    aarch64: 'Xray-linux-arm64-v8a.zip',
    arm64: 'Xray-linux-arm64-v8a.zip',
    armv7l: 'Xray-linux-arm32-v7a.zip',
    armv6l: 'Xray-linux-arm32-v6.zip',
    armv5l: 'Xray-linux-arm32-v5.zip',
    mips: 'Xray-linux-mips32.zip',
    mipsel: 'Xray-linux-mips32le.zip',
    mips64: 'Xray-linux-mips64.zip',
    mips64el: 'Xray-linux-mips64le.zip',
    ppc64: 'Xray-linux-ppc64.zip',
    ppc64le: 'Xray-linux-ppc64le.zip',
    riscv64: 'Xray-linux-riscv64.zip',
    s390x: 'Xray-linux-s390x.zip',
    loongarch64: 'Xray-linux-loong64.zip',
};

function selectReleaseAsset(release, architecture) {
    const archiveName = ARCH_ASSETS[String(architecture || '').trim().toLowerCase()];
    if (!archiveName) return null;
    const digestName = `${archiveName}.dgst`;
    const archive = release?.assets?.find(asset => asset.name === archiveName);
    const digest = release?.assets?.find(asset => asset.name === digestName);
    if (!archive || !digest) return null;

    const expectedPrefix = `${RELEASE_DOWNLOAD_PREFIX}${release.tag}/`;
    if (!archive.url.startsWith(expectedPrefix) || !digest.url.startsWith(expectedPrefix)) {
        return null;
    }
    return {
        archiveName,
        archiveUrl: archive.url,
        digestUrl: digest.url,
    };
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildUpdateScript({ release, asset, requestId }) {
    if (!release || !parseVersion(release.tag) || !TASK_ID_RE.test(requestId)) {
        throw new Error('Invalid Xray update parameters');
    }
    if (!asset || !asset.archiveUrl || !asset.digestUrl) {
        throw new Error('Missing Xray release assets');
    }

    const target = normalizeVersion(release.tag);
    const archiveUrl = shellQuote(asset.archiveUrl);
    const digestUrl = shellQuote(asset.digestUrl);
    const backupRoot = `/var/lib/celerity-xray-updates/${requestId}`;

    return `#!/bin/bash
set -Eeuo pipefail

TARGET=${shellQuote(target)}
ARCHIVE_URL=${archiveUrl}
DIGEST_URL=${digestUrl}
BIN="/usr/local/bin/xray"
CONFIG="/usr/local/etc/xray/config.json"
BACKUP_ROOT=${shellQuote(backupRoot)}
TMP_DIR="$(mktemp -d /tmp/celerity-xray-update.XXXXXX)"
SWAPPED=0

cleanup_tmp() {
    rm -rf "$TMP_DIR"
}

# The binary is swapped by rename while the old process keeps running from its
# own inode, so restoring the file is enough here: the service is restarted
# once later, by the panel-driven configuration sync.
rollback() {
    local code=$?
    trap - ERR HUP INT TERM
    set +e
    if [ "$SWAPPED" = "1" ] && [ -x "$BACKUP_ROOT/xray" ]; then
        install -m 0755 "$BACKUP_ROOT/xray" "$BIN"
        [ -f "$BACKUP_ROOT/config.json" ] && cp -a "$BACKUP_ROOT/config.json" "$CONFIG"
        echo "ROLLBACK: previous Xray binary restored"
    fi
    rm -rf "$BACKUP_ROOT"
    cleanup_tmp
    exit "$code"
}

trap cleanup_tmp EXIT
trap rollback ERR HUP INT TERM

for command in curl unzip sha256sum systemctl; do
    command -v "$command" >/dev/null 2>&1 || {
        echo "ERROR: required command not found: $command"
        exit 1
    }
done
[ -x "$BIN" ] || { echo "ERROR: Xray is not installed"; exit 1; }
[ -f "$CONFIG" ] || { echo "ERROR: Xray config not found at $CONFIG"; exit 1; }

mkdir -p "$BACKUP_ROOT"
cp -a "$BIN" "$BACKUP_ROOT/xray"
cp -a "$CONFIG" "$BACKUP_ROOT/config.json"
if systemctl is-active --quiet xray; then
    touch "$BACKUP_ROOT/was-active"
fi

curl -fL --connect-timeout 15 --max-time 300 "$ARCHIVE_URL" -o "$TMP_DIR/xray.zip"
curl -fL --connect-timeout 15 --max-time 60 "$DIGEST_URL" -o "$TMP_DIR/xray.zip.dgst"
EXPECTED="$(awk '/^SHA2-256=/{print $2; exit}' "$TMP_DIR/xray.zip.dgst")"
[ -n "$EXPECTED" ] || { echo "ERROR: SHA-256 digest missing"; exit 1; }
ACTUAL="$(sha256sum "$TMP_DIR/xray.zip" | awk '{print $1}')"
[ "$ACTUAL" = "$EXPECTED" ] || { echo "ERROR: Xray archive checksum mismatch"; exit 1; }
echo "CHECKSUM: verified"

mkdir -p "$TMP_DIR/unpack"
unzip -q "$TMP_DIR/xray.zip" -d "$TMP_DIR/unpack"
NEW_BIN="$TMP_DIR/unpack/xray"
[ -s "$NEW_BIN" ] || { echo "ERROR: Xray binary missing from archive"; exit 1; }
chmod 0755 "$NEW_BIN"

NEW_VERSION="$("$NEW_BIN" version 2>/dev/null | awk 'NR==1 {print $2}')"
NEW_VERSION="\${NEW_VERSION#v}"
[ "$NEW_VERSION" = "$TARGET" ] || {
    echo "ERROR: downloaded version $NEW_VERSION does not match target $TARGET"
    exit 1
}

if ! XRAY_LOCATION_ASSET=/usr/local/share/xray "$NEW_BIN" run -test -config "$CONFIG" >"$TMP_DIR/config-test.log" 2>&1; then
    if ! XRAY_LOCATION_ASSET=/usr/local/share/xray "$NEW_BIN" -test -config "$CONFIG" >>"$TMP_DIR/config-test.log" 2>&1; then
        cat "$TMP_DIR/config-test.log"
        echo "ERROR: current config is incompatible with Xray $TARGET"
        exit 1
    fi
fi
echo "CONFIG: compatible with Xray $TARGET"

# Atomic rename; a running Xray keeps serving from the old inode until the
# configuration sync restarts it, so the whole change costs one restart.
install -m 0755 "$NEW_BIN" "$BIN.new"
mv -f "$BIN.new" "$BIN"
SWAPPED=1
echo "SWAPPED=1"

INSTALLED_VERSION="$("$BIN" version 2>/dev/null | awk 'NR==1 {print $2}')"
INSTALLED_VERSION="\${INSTALLED_VERSION#v}"
[ "$INSTALLED_VERSION" = "$TARGET" ] || {
    echo "ERROR: installed version $INSTALLED_VERSION does not match target $TARGET"
    exit 1
}

trap - ERR HUP INT TERM
echo "UPDATED_VERSION=$INSTALLED_VERSION"
echo "BACKUP_ROOT=$BACKUP_ROOT"
`;
}

function buildRollbackScript(requestId) {
    if (!TASK_ID_RE.test(requestId)) throw new Error('Invalid Xray update task id');
    const backupRoot = `/var/lib/celerity-xray-updates/${requestId}`;
    return `#!/bin/bash
set -euo pipefail
BACKUP_ROOT=${shellQuote(backupRoot)}
BIN="/usr/local/bin/xray"
CONFIG="/usr/local/etc/xray/config.json"
[ -x "$BACKUP_ROOT/xray" ] || { echo "ERROR: rollback binary not found"; exit 1; }
systemctl stop xray >/dev/null 2>&1 || true
install -m 0755 "$BACKUP_ROOT/xray" "$BIN"
[ -f "$BACKUP_ROOT/config.json" ] && cp -a "$BACKUP_ROOT/config.json" "$CONFIG"
if [ -f "$BACKUP_ROOT/was-active" ]; then
    systemctl start xray
    sleep 2
    systemctl is-active --quiet xray
fi
rm -rf "$BACKUP_ROOT"
echo "ROLLBACK: previous Xray version restored"
`;
}

function buildCleanupScript(requestId) {
    if (!TASK_ID_RE.test(requestId)) throw new Error('Invalid Xray update task id');
    return `rm -rf ${shellQuote(`/var/lib/celerity-xray-updates/${requestId}`)}`;
}

function appendLog(task, message) {
    const text = String(message || '').trim();
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
        task.logs.push(line.slice(0, 1000));
    }
    if (task.logs.length > 300) {
        task.logs.splice(0, task.logs.length - 300);
    }
}

function taskSnapshot(task) {
    if (!task) return { state: 'idle' };
    return {
        id: task.id,
        nodeId: task.nodeId,
        state: task.state,
        step: task.step,
        currentVersion: task.currentVersion,
        targetVersion: task.targetVersion,
        error: task.error,
        rollbackSucceeded: task.rollbackSucceeded,
        nodeUnchanged: task.nodeUnchanged,
        logs: [...task.logs],
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
    };
}

function getTask(nodeId) {
    return taskSnapshot(tasks.get(String(nodeId)));
}

function scheduleTaskCleanup(nodeId, taskId) {
    const timer = setTimeout(() => {
        const task = tasks.get(String(nodeId));
        if (task?.id === taskId && task.state !== 'running') {
            tasks.delete(String(nodeId));
        }
    }, TASK_TTL_MS);
    timer.unref?.();
}

async function execRequired(conn, command, label) {
    const result = await nodeSetup.execSSH(conn, command);
    if (!result.success) {
        const error = new Error(`${label} failed`);
        error.remoteOutput = result.output || result.error || '';
        throw error;
    }
    return result.output || '';
}

function parsePreflight(output) {
    const architecture = output.match(/^ARCH=(.+)$/m)?.[1]?.trim() || '';
    const version = normalizeVersion(output.match(/^VERSION=(.+)$/m)?.[1]?.trim() || '');
    return { architecture, version };
}

async function detectInstalledVersion(node, { forceSsh = false } = {}) {
    if (!node || node.type !== 'xray') return '';
    const storedVersion = normalizeVersion(node.xrayVersion);

    if (node.xray?.agentToken) {
        try {
            const syncService = require('./syncService');
            const response = await syncService._agentRequest(node, 'GET', '/info');
            const version = normalizeVersion(response?.data?.xray_version);
            if (version) {
                await HyNode.updateOne({ _id: node._id }, { $set: { xrayVersion: version } });
                return version;
            }
        } catch (error) {
            logger.debug(`[Xray Update] Agent version lookup failed for ${node.name}: ${error.message}`);
        }
    }

    if (storedVersion && !forceSsh) return storedVersion;
    if (!node.ssh?.password && !node.ssh?.privateKey) return storedVersion;

    let conn;
    try {
        conn = await nodeSetup.connectSSH(node);
        const output = await execRequired(
            conn,
            `xray version 2>/dev/null | awk 'NR==1 {print $2}'`,
            'Xray version detection'
        );
        const version = normalizeVersion(output.trim());
        if (version) {
            await HyNode.updateOne({ _id: node._id }, { $set: { xrayVersion: version } });
            return version;
        }
    } catch (error) {
        logger.debug(`[Xray Update] SSH version lookup failed for ${node.name}: ${error.message}`);
    } finally {
        if (conn) conn.end();
    }
    return storedVersion;
}

async function synchronizeNode(node) {
    if (node.cascadeRole === 'bridge') {
        const cascadeService = require('./cascadeService');
        await cascadeService.redeployAllLinksForNode(node._id);
        return true;
    }
    const syncService = require('./syncService');
    return syncService.updateXrayNodeConfig(node);
}

async function runVersionChange(task, release) {
    let conn = null;
    let changed = false;
    let rollbackSucceeded = false;
    try {
        task.step = 'preflight';
        const node = await HyNode.findById(task.nodeId);
        if (!node) throw new Error('Node not found');
        if (node.type !== 'xray') throw new Error('Node is not an Xray node');
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            throw new Error('SSH credentials are required');
        }

        conn = await nodeSetup.connectSSH(node);
        const preflightOutput = await execRequired(conn, `
ARCH="$(uname -m)"
VERSION="$(xray version 2>/dev/null | awk 'NR==1 {print $2}')"
echo "ARCH=$ARCH"
echo "VERSION=$VERSION"
test -n "$VERSION"
`, 'Xray preflight');
        const preflight = parsePreflight(preflightOutput);
        if (!preflight.version) throw new Error('Could not detect the installed Xray version');
        task.currentVersion = preflight.version;
        appendLog(task, `Current Xray version: ${preflight.version}`);

        const asset = selectReleaseAsset(release, preflight.architecture);
        if (!asset) {
            throw new Error(`Release ${release.tag} has no verified asset for ${preflight.architecture || 'this architecture'}`);
        }

        task.step = 'download';
        appendLog(task, `Installing Xray ${release.tag} for ${preflight.architecture}`);
        const updateOutput = await execRequired(
            conn,
            buildUpdateScript({ release, asset, requestId: task.id }),
            'Xray version change'
        );
        changed = true;
        appendLog(task, updateOutput);
        conn.end();
        conn = null;

        task.step = 'sync';
        const freshNode = await HyNode.findById(task.nodeId);
        const synchronized = await synchronizeNode(freshNode);
        if (!synchronized) throw new Error('Node configuration synchronization failed');

        task.step = 'verify';
        conn = await nodeSetup.connectSSH(freshNode);
        // The swap keeps a running Xray alive on the replaced inode, so the
        // configuration sync above is what activates the new binary. If that
        // restart silently failed, /proc/<pid>/exe still points at the deleted
        // file and the service is restarted here as a fallback.
        const verifyOutput = await execRequired(conn, `
VERSION="$(xray version 2>/dev/null | awk 'NR==1 {print $2}')"
VERSION="\${VERSION#v}"
echo "VERSION=$VERSION"
[ "$VERSION" = ${shellQuote(release.version)} ]
if [ -f ${shellQuote(`/var/lib/celerity-xray-updates/${task.id}/was-active`)} ]; then
    MAIN_PID="$(systemctl show -p MainPID --value xray 2>/dev/null || echo 0)"
    if [ -n "$MAIN_PID" ] && [ "$MAIN_PID" != "0" ]; then
        case "$(readlink "/proc/$MAIN_PID/exe" 2>/dev/null || true)" in
            *"(deleted)"*)
                echo "RESTART: activating the new Xray binary"
                systemctl restart xray
                sleep 2
                ;;
        esac
    fi
    systemctl is-active --quiet xray
fi
`, 'Xray verification');
        appendLog(task, verifyOutput);
        await execRequired(conn, buildCleanupScript(task.id), 'Xray backup cleanup');
        conn.end();
        conn = null;

        await HyNode.updateOne(
            { _id: task.nodeId },
            {
                $set: {
                    xrayVersion: release.version,
                    status: freshNode.cascadeRole === 'bridge' ? freshNode.status : 'online',
                    lastError: '',
                    lastSync: new Date(),
                    healthFailures: 0,
                },
            }
        );
        await invalidateNodesCache();

        task.state = 'done';
        task.step = 'done';
        appendLog(task, `Xray ${release.tag} is running`);
    } catch (error) {
        appendLog(task, error.remoteOutput);
        appendLog(task, `ERROR: ${error.message}`);

        // The remote script swaps the binary only after printing SWAPPED=1 and
        // restores it through its own trap, so a failure inside the script can
        // still leave the node healthy. Trust those markers instead of
        // reporting a rollback failure the operator would have to chase.
        const remoteOutput = String(error.remoteOutput || '');
        const swappedRemotely = /^SWAPPED=1$/m.test(remoteOutput);
        let nodeUnchanged = !changed && !swappedRemotely;
        if (!changed && swappedRemotely) {
            rollbackSucceeded = /ROLLBACK: previous Xray binary restored/.test(remoteOutput);
        }

        if (changed) {
            nodeUnchanged = false;
            task.step = 'rollback';
            try {
                if (!conn) {
                    const node = await HyNode.findById(task.nodeId);
                    conn = await nodeSetup.connectSSH(node);
                }
                const rollbackOutput = await execRequired(
                    conn,
                    buildRollbackScript(task.id),
                    'Xray rollback'
                );
                appendLog(task, rollbackOutput);
                rollbackSucceeded = true;
            } catch (rollbackError) {
                appendLog(task, rollbackError.remoteOutput);
                appendLog(task, `ROLLBACK ERROR: ${rollbackError.message}`);
            }
        }

        task.state = 'error';
        task.step = 'error';
        task.error = error.message;
        task.rollbackSucceeded = rollbackSucceeded;
        task.nodeUnchanged = nodeUnchanged;

        const status = (nodeUnchanged || rollbackSucceeded) ? 'online' : 'error';
        let lastError;
        if (nodeUnchanged) {
            lastError = `Xray version change aborted before the node was modified: ${error.message}`;
        } else if (rollbackSucceeded) {
            lastError = `Xray version change failed; previous version restored: ${error.message}`;
        } else {
            lastError = `Xray version change failed: ${error.message}`;
        }
        await HyNode.updateOne(
            { _id: task.nodeId },
            { $set: { status, lastError, healthFailures: 0 } }
        ).catch(() => {});
        await invalidateNodesCache().catch(() => {});
        logger.error(`[Xray Update] Node ${task.nodeId}: ${lastError}`);
    } finally {
        if (conn) conn.end();
        task.finishedAt = new Date().toISOString();
        scheduleTaskCleanup(task.nodeId, task.id);
    }
}

async function startVersionChange(nodeId, version) {
    const key = String(nodeId);
    const existing = tasks.get(key);
    if (existing?.state === 'running') {
        const error = new Error('An Xray version change is already running for this node');
        error.statusCode = 409;
        throw error;
    }

    const release = await getKnownRelease(version);
    if (!release) {
        const error = new Error('Unknown Xray release');
        error.statusCode = 400;
        throw error;
    }

    const task = {
        id: crypto.randomUUID(),
        nodeId: key,
        state: 'running',
        step: 'queued',
        currentVersion: null,
        targetVersion: release.version,
        error: null,
        rollbackSucceeded: false,
        nodeUnchanged: false,
        logs: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
    };
    tasks.set(key, task);
    setImmediate(() => runVersionChange(task, release));
    return taskSnapshot(task);
}

module.exports = {
    parseVersion,
    normalizeVersion,
    compareVersions,
    normalizeReleases,
    selectReleaseAsset,
    buildUpdateScript,
    buildRollbackScript,
    getVersionInfo,
    getKnownRelease,
    getReleaseChangelog,
    detectInstalledVersion,
    getTask,
    startVersionChange,
    _test: {
        runVersionChange,
    },
};
