'use strict';

// Transactional provisioning of the Caddy front: stage, validate, swap, smoke
// test, roll back on failure. Keyed by a fingerprint of the desired state so a
// config push does not reinstall a node that already matches.
//
// Caddy may take the public port only after the inbounds have moved to
// loopback, so reconciliation runs after the Xray config push (see syncService).

const crypto = require('crypto');

const nodeSetup = require('../nodeSetup');
const HyNode = require('../../models/hyNodeModel');
const logger = require('../../utils/logger');
const appConfig = require('../../../config');
const { shellQuote } = require('../../utils/shell');
const { NGINX_WELCOME_BUFFER } = require('../../utils/decoyPage');
const { buildFrontRoutes } = require('../../utils/xrayFront');
const { resolveCaddyVersion, selectCaddyAsset, normalizeVersion } = require('./release');
const {
    CADDY_BIN,
    CADDYFILE_PATH,
    CADDY_TLS_DIR,
    CADDY_CERT_PATH,
    CADDY_KEY_PATH,
    SITE_ROOT,
    buildCaddyfile,
    frontSiteHost,
} = require('./caddyfile');

const BACKUP_PREFIX = '/var/lib/celerity-front/backup';
const TASK_TTL_MS = 60 * 60 * 1000;
const TASK_ID_RE = /^[0-9a-f-]{36}$/i;
const MAX_TASK_LOGS = 300;

const tasks = new Map();

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

// Null for 'acme': Caddy obtains and renews the certificate itself.
function resolveTlsMaterial(node) {
    const tlsSource = node?.xray?.tlsSource || 'panel';
    if (tlsSource === 'acme') return null;
    if (tlsSource === 'manual') {
        const cert = String(node?.xray?.manualCert || '');
        const key = String(node?.xray?.manualKey || '');
        if (!cert || !key) throw new Error('Manual TLS is selected but the certificate or key is missing');
        return { cert, key };
    }
    const panelCerts = nodeSetup.getPanelCertificates(appConfig.PANEL_DOMAIN);
    if (!panelCerts?.cert || !panelCerts?.key) {
        throw new Error(`Panel certificates for ${appConfig.PANEL_DOMAIN} are not available on the panel host`);
    }
    return { cert: panelCerts.cert, key: panelCerts.key };
}

// The Caddy version is left out of the fingerprint: a new upstream release
// must not silently re-provision every node.
function buildDesiredState(node) {
    const front = node?.xray?.front || {};
    const caddyfile = buildCaddyfile(node);
    const site = front.siteMode === 'custom' && front.siteHtml?.length
        ? Buffer.from(front.siteHtml)
        : NGINX_WELCOME_BUFFER;
    const tls = resolveTlsMaterial(node);

    const fingerprint = sha256([
        sha256(caddyfile),
        sha256(site),
        tls ? sha256(`${tls.cert}\n${tls.key}`) : 'acme',
    ].join(':'));

    return { caddyfile, site, tls, fingerprint };
}

function buildInstallScript(asset) {
    return `#!/bin/bash
set -Eeuo pipefail

ARCHIVE_URL=${shellQuote(asset.archiveUrl)}
CHECKSUMS_URL=${shellQuote(asset.checksumsUrl)}
ARCHIVE_NAME=${shellQuote(asset.archiveName)}
TMP_DIR="$(mktemp -d /tmp/celerity-front-install.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

for command in curl tar sha512sum systemctl; do
    command -v "$command" >/dev/null 2>&1 || { echo "ERROR: required command not found: $command"; exit 1; }
done

curl -fL --connect-timeout 15 --max-time 300 "$ARCHIVE_URL" -o "$TMP_DIR/$ARCHIVE_NAME"
curl -fL --connect-timeout 15 --max-time 60 "$CHECKSUMS_URL" -o "$TMP_DIR/checksums.txt"
# The file covers every asset of the release, hence --ignore-missing.
(cd "$TMP_DIR" && sha512sum --ignore-missing -c checksums.txt)
echo "CHECKSUM: verified"

tar -xzf "$TMP_DIR/$ARCHIVE_NAME" -C "$TMP_DIR" caddy
install -m 0755 "$TMP_DIR/caddy" ${CADDY_BIN}

id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /bin/false caddy
mkdir -p ${CADDY_TLS_DIR} ${SITE_ROOT} /var/lib/caddy
chown -R caddy:caddy /etc/caddy /var/lib/caddy /var/lib/celerity-front
chmod 0750 ${CADDY_TLS_DIR}

cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=${CADDY_BIN} run --config ${CADDYFILE_PATH}
ExecReload=${CADDY_BIN} reload --config ${CADDYFILE_PATH} --force
Restart=on-abnormal
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

echo "INSTALLED=$(${CADDY_BIN} version 2>/dev/null | awk 'NR==1 {print $1}')"
`;
}

function buildApplyScript({ requestId, host, publicPort, routePaths }) {
    if (!TASK_ID_RE.test(requestId)) throw new Error('Invalid front request id');

    const smokePaths = routePaths.map(shellQuote).join(' ');
    return `#!/bin/bash
set -Eeuo pipefail

CADDYFILE=${CADDYFILE_PATH}
SITE=${SITE_ROOT}
BACKUP_ROOT=${shellQuote(`${BACKUP_PREFIX}/${requestId}`)}
HOST=${shellQuote(host)}
PORT=${publicPort}
SWAPPED=0

rollback() {
    local code=$?
    trap - EXIT HUP INT TERM
    set +e
    if [ "$code" = "0" ]; then
        rm -rf "$BACKUP_ROOT"
        exit 0
    fi
    if [ "$SWAPPED" = "1" ]; then
        if [ -f "$BACKUP_ROOT/Caddyfile" ]; then
            cp -a "$BACKUP_ROOT/Caddyfile" "$CADDYFILE"
            if [ -f "$BACKUP_ROOT/was-active" ]; then
                systemctl reload caddy || systemctl restart caddy
            else
                systemctl stop caddy
            fi
            echo "ROLLBACK: previous Caddyfile restored"
        else
            # Nothing to restore: the front was not configured before.
            systemctl disable --now caddy
            rm -f "$CADDYFILE"
            echo "ROLLBACK: front removed"
        fi
    fi
    rm -rf "$BACKUP_ROOT" "$CADDYFILE.new" "$SITE/index.html.new" ${CADDY_CERT_PATH}.new ${CADDY_KEY_PATH}.new
    exit "$code"
}

# EXIT, not ERR: the checks below bail out with an explicit exit.
trap rollback EXIT HUP INT TERM

command -v curl >/dev/null 2>&1 || { echo "ERROR: required command not found: curl"; exit 1; }
[ -s "$CADDYFILE.new" ] || { echo "ERROR: staged Caddyfile is missing"; exit 1; }
${CADDY_BIN} validate --adapter caddyfile --config "$CADDYFILE.new"
echo "VALIDATED"

mkdir -p "$BACKUP_ROOT"
if [ -f "$CADDYFILE" ]; then
    cp -a "$CADDYFILE" "$BACKUP_ROOT/Caddyfile"
fi
if systemctl is-active --quiet caddy; then
    touch "$BACKUP_ROOT/was-active"
fi

mv -f "$CADDYFILE.new" "$CADDYFILE"
if [ -f "$SITE/index.html.new" ]; then
    mv -f "$SITE/index.html.new" "$SITE/index.html"
fi
if [ -f ${CADDY_CERT_PATH}.new ]; then
    mv -f ${CADDY_CERT_PATH}.new ${CADDY_CERT_PATH}
    mv -f ${CADDY_KEY_PATH}.new ${CADDY_KEY_PATH}
    chmod 0640 ${CADDY_CERT_PATH} ${CADDY_KEY_PATH}
fi
if id caddy >/dev/null 2>&1; then
    chown -R caddy:caddy /etc/caddy /var/lib/celerity-front
fi
SWAPPED=1

systemctl enable caddy >/dev/null 2>&1 || true
if systemctl is-active --quiet caddy; then
    systemctl reload caddy
else
    systemctl start caddy
fi
sleep 2
systemctl is-active --quiet caddy || {
    journalctl -u caddy -n 30 --no-pager 2>/dev/null || true
    echo "ERROR: caddy is not running after apply"
    exit 1
}

# Retried: an ACME certificate takes a few seconds on the first start.
SITE_CODE=""
for attempt in 1 2 3 4 5 6; do
    SITE_CODE="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 \\
        --resolve "$HOST:$PORT:127.0.0.1" "https://$HOST:$PORT/" || true)"
    if [ "$SITE_CODE" = "200" ]; then
        break
    fi
    sleep 5
done
echo "SMOKE / -> \${SITE_CODE:-no response}"
[ "$SITE_CODE" = "200" ] || { echo "ERROR: the decoy site did not answer on port $PORT"; exit 1; }

for path in ${smokePaths}; do
    CODE="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \\
        --resolve "$HOST:$PORT:127.0.0.1" "https://$HOST:$PORT$path" || true)"
    echo "SMOKE $path -> \${CODE:-no response}"
    # 404 means the file server answered, so the inbound route did not match.
    if [ "$CODE" = "404" ]; then
        echo "ERROR: $path is served by the decoy site instead of the inbound"
        exit 1
    fi
done

echo "APPLIED"
`;
}

function buildTeardownScript() {
    return `#!/bin/bash
set -euo pipefail
systemctl disable --now caddy >/dev/null 2>&1 || true
rm -f ${CADDYFILE_PATH} ${CADDY_CERT_PATH} ${CADDY_KEY_PATH}
echo "FRONT: stopped"
`;
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

// An existing installation is left alone: upgrading is an explicit operation.
async function ensureCaddyInstalled(conn, log) {
    const preflight = await execRequired(conn, `
ARCH="$(uname -m)"
INSTALLED="$(${CADDY_BIN} version 2>/dev/null | awk 'NR==1 {print $1}')"
echo "ARCH=$ARCH"
echo "INSTALLED=$INSTALLED"
command -v systemctl >/dev/null 2>&1
`, 'Front preflight');

    const architecture = preflight.match(/^ARCH=(.+)$/m)?.[1]?.trim() || '';
    const installed = normalizeVersion(preflight.match(/^INSTALLED=(.+)$/m)?.[1]?.trim() || '');
    if (installed) {
        log(`Caddy ${installed} is already installed`);
        return installed;
    }

    const version = await resolveCaddyVersion();
    const asset = selectCaddyAsset(version, architecture);
    if (!asset) {
        throw new Error(`Caddy ${version} has no release asset for ${architecture || 'this architecture'}`);
    }

    log(`Installing Caddy ${version} for ${architecture}`);
    const output = await execRequired(conn, buildInstallScript(asset), 'Caddy installation');
    log(output);
    return normalizeVersion(output.match(/^INSTALLED=(.+)$/m)?.[1]?.trim() || '') || version;
}

async function provisionFront(node, desired, log) {
    const front = node.xray.front;
    const host = frontSiteHost(node);
    const publicPort = front.publicPort || 443;
    const routes = buildFrontRoutes(node.xray, node.port);
    const requestId = crypto.randomUUID();

    let conn;
    try {
        conn = await nodeSetup.connectSSH(node);
        const caddyVersion = await ensureCaddyInstalled(conn, log);

        log('Staging Caddyfile and decoy page');
        await execRequired(
            conn,
            `mkdir -p ${SITE_ROOT} ${CADDY_TLS_DIR} ${BACKUP_PREFIX}`,
            'Front directory setup'
        );
        await nodeSetup.uploadFile(conn, desired.caddyfile, `${CADDYFILE_PATH}.new`);
        await nodeSetup.uploadFile(conn, desired.site, `${SITE_ROOT}/index.html.new`);
        if (desired.tls) {
            await nodeSetup.uploadFile(conn, desired.tls.cert, `${CADDY_CERT_PATH}.new`);
            await nodeSetup.uploadFile(conn, desired.tls.key, `${CADDY_KEY_PATH}.new`);
        }

        log(`Applying front on ${host}:${publicPort} for ${routes.length} inbound(s)`);
        const output = await execRequired(conn, buildApplyScript({
            requestId,
            host,
            publicPort,
            // The bare base path is enough to prove the route matches.
            routePaths: routes.map(route => route.paths[0]),
        }), 'Front apply');
        log(output);

        return { fingerprint: desired.fingerprint, caddyVersion };
    } finally {
        if (conn) conn.end();
    }
}

async function teardownFront(node, log) {
    let conn;
    try {
        conn = await nodeSetup.connectSSH(node);
        log('Stopping the front on the node');
        log(await execRequired(conn, buildTeardownScript(), 'Front teardown'));
    } finally {
        if (conn) conn.end();
    }
}

// manualKey and siteHtml are select:false everywhere else.
function loadNodeForFront(nodeId) {
    return HyNode.findById(nodeId).select('+xray.manualKey +xray.front.siteHtml');
}

async function saveFrontState(nodeId, patch) {
    const update = {};
    for (const [key, value] of Object.entries(patch)) {
        update[`xray.front.${key}`] = value;
    }
    await HyNode.updateOne({ _id: nodeId }, { $set: update });
}

// Provisions, tears down or skips one node's front, depending on its state.
async function reconcileFront(nodeOrId, { force = false, log = () => {} } = {}) {
    const nodeId = nodeOrId?._id || nodeOrId;
    const node = await loadNodeForFront(nodeId);
    if (!node || node.type !== 'xray') return { changed: false, skipped: 'not-an-xray-node' };

    const front = node.xray?.front;
    if (!front?.enabled) {
        // Nothing was ever applied, so there is nothing to stop.
        if (!front?.appliedFingerprint) return { changed: false, skipped: 'disabled' };
        try {
            await teardownFront(node, log);
            await saveFrontState(nodeId, {
                status: 'disabled',
                appliedFingerprint: '',
                lastError: '',
            });
            return { changed: true };
        } catch (error) {
            const message = error.remoteOutput ? `${error.message}: ${error.remoteOutput}` : error.message;
            logger.warn(`[Front] ${node.name}: teardown failed - ${message}`);
            await saveFrontState(nodeId, { status: 'error', lastError: message.slice(0, 1000) });
            return { changed: false, error: message };
        }
    }

    if (!node.ssh?.password && !node.ssh?.privateKey) {
        return { changed: false, skipped: 'no-ssh-credentials' };
    }

    let desired;
    try {
        desired = buildDesiredState(node);
    } catch (error) {
        await saveFrontState(nodeId, { status: 'error', lastError: error.message.slice(0, 1000) });
        return { changed: false, error: error.message };
    }

    if (!force && desired.fingerprint === front.appliedFingerprint && front.status === 'active') {
        return { changed: false, skipped: 'up-to-date' };
    }

    await saveFrontState(nodeId, { status: 'pending' });
    try {
        const applied = await provisionFront(node, desired, log);
        await saveFrontState(nodeId, {
            status: 'active',
            appliedFingerprint: applied.fingerprint,
            caddyVersion: applied.caddyVersion,
            lastError: '',
        });
        logger.info(`[Front] ${node.name}: front active on port ${front.publicPort || 443}`);
        return { changed: true };
    } catch (error) {
        const message = error.remoteOutput ? `${error.message}: ${error.remoteOutput}` : error.message;
        // appliedFingerprint is left untouched: the remote trap restored the
        // previous Caddyfile, so the node still matches what it had before.
        await saveFrontState(nodeId, { status: 'error', lastError: message.slice(0, 1000) });
        logger.error(`[Front] ${node.name}: apply failed - ${message}`);
        return { changed: false, error: message };
    }
}

function appendLog(task, message) {
    const text = String(message || '').trim();
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
        task.logs.push(line.slice(0, 1000));
    }
    if (task.logs.length > MAX_TASK_LOGS) {
        task.logs.splice(0, task.logs.length - MAX_TASK_LOGS);
    }
}

function taskSnapshot(task) {
    if (!task) return { state: 'idle' };
    return {
        id: task.id,
        nodeId: task.nodeId,
        state: task.state,
        error: task.error,
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

async function runApplyTask(task) {
    try {
        const result = await reconcileFront(task.nodeId, {
            force: true,
            log: message => appendLog(task, message),
        });
        if (result.error) throw new Error(result.error);
        if (result.skipped) {
            appendLog(task, `Nothing to do: ${result.skipped}`);
        }
        task.state = 'done';
    } catch (error) {
        appendLog(task, `ERROR: ${error.message}`);
        task.state = 'error';
        task.error = error.message;
    } finally {
        task.finishedAt = new Date().toISOString();
        scheduleTaskCleanup(task.nodeId, task.id);
    }
}

// Returns the initial snapshot; the panel polls getTask for the rest.
function startFrontApply(nodeId) {
    const key = String(nodeId);
    if (tasks.get(key)?.state === 'running') {
        const error = new Error('A front apply is already running for this node');
        error.statusCode = 409;
        throw error;
    }

    const task = {
        id: crypto.randomUUID(),
        nodeId: key,
        state: 'running',
        error: null,
        logs: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
    };
    tasks.set(key, task);
    setImmediate(() => runApplyTask(task));
    return taskSnapshot(task);
}

module.exports = {
    buildDesiredState,
    buildInstallScript,
    buildApplyScript,
    buildTeardownScript,
    reconcileFront,
    getTask,
    startFrontApply,
};
