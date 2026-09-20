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
const { invalidateNodesCache } = require('../../utils/helpers');
const { shellQuote } = require('../../utils/shell');
const nodeSetupLock = require('../../utils/nodeSetupLock');
const { NGINX_WELCOME_BUFFER } = require('../../utils/decoyPage');
const {
    buildFrontRoutes,
    restoreFrontInboundLayout,
} = require('../../utils/xrayFront');
const { resolveCaddyVersion, selectCaddyAsset, normalizeVersion } = require('./release');
const {
    CADDY_BIN,
    CADDYFILE_PATH,
    CADDY_TLS_DIR,
    CADDY_CERT_PATH,
    CADDY_KEY_PATH,
    SITE_ROOT,
    FRONT_SMOKE_HEADER,
    FRONT_SMOKE_VALUE,
    buildCaddyfile,
    frontSiteHost,
} = require('./caddyfile');

const BACKUP_PREFIX = '/var/lib/celerity-front/backup';
const RELEASES_ROOT = '/var/lib/celerity-front/releases';
const TRANSACTION_MARKER = '/var/lib/celerity-front/transaction';
const FRONT_LOCK_PATH = '/var/lock/celerity-front.lock';
const XRAY_CONFIG_PATH = '/usr/local/etc/xray/config.json';
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
    const error = new Error(`FRONT_CONFIG_INVALID: TLS source '${tlsSource}' cannot serve the node domain; use manual PEM or ACME`);
    error.code = 'FRONT_CONFIG_INVALID';
    throw error;
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

UNIT=/etc/systemd/system/caddy.service
if [ -f "$UNIT" ] && ! grep -q '^# Managed by Celerity$' "$UNIT"; then
    if ! grep -q '^ExecStart=${CADDY_BIN} run --config ${CADDYFILE_PATH}$' "$UNIT"; then
        echo "ERROR: an unmanaged caddy.service already exists; refusing to overwrite it" >&2
        exit 1
    fi
fi

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
# Managed by Celerity
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

function buildRuntimeBootstrapScript() {
    return `#!/bin/bash
set -Eeuo pipefail

for command in systemctl flock; do
    command -v "$command" >/dev/null 2>&1 || { echo "ERROR: required command not found: $command"; exit 1; }
done

UNIT=/etc/systemd/system/caddy.service
if [ -f "$UNIT" ] && ! grep -q '^# Managed by Celerity$' "$UNIT"; then
    if ! grep -q '^ExecStart=${CADDY_BIN} run --config ${CADDYFILE_PATH}$' "$UNIT"; then
        echo "ERROR: an unmanaged caddy.service already exists; refusing to overwrite it" >&2
        exit 1
    fi
fi

id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /bin/false caddy
mkdir -p /etc/caddy ${RELEASES_ROOT} ${BACKUP_PREFIX} /var/lib/caddy /usr/local/sbin
chown -R caddy:caddy /etc/caddy /var/lib/caddy /var/lib/celerity-front

cat > /usr/local/sbin/celerity-front-recover <<'RECOVERY'
#!/bin/bash
set -Eeuo pipefail
MODE="\${1:-live}"
MARKER=${TRANSACTION_MARKER}
COMMIT=/run/celerity-front-commit
SKIP_START=/run/celerity-front-do-not-start
[ "$MODE" = "--prestart" ] && [ -e "$SKIP_START" ] && exit 1
[ -s "$MARKER" ] || exit 0
if [ -s "$COMMIT" ]; then
    OWNER="$(cat "$COMMIT" 2>/dev/null || true)"
    if [[ "$OWNER" =~ ^[0-9]+$ ]] && kill -0 "$OWNER" 2>/dev/null; then
        exit 0
    fi
    rm -f "$COMMIT"
fi
exec 9>${FRONT_LOCK_PATH}
flock -w 120 9
ROOT="$(cat "$MARKER")"
[ -d "$ROOT" ] || { rm -f "$MARKER"; exit 1; }

if [ -f "$ROOT/Caddyfile.existed" ]; then
    rm -f ${CADDYFILE_PATH}
    cp -a "$ROOT/Caddyfile" ${CADDYFILE_PATH}
else
    rm -f ${CADDYFILE_PATH}
fi
WAS_ACTIVE=0
[ -f "$ROOT/was-active" ] && WAS_ACTIVE=1
if [ "$MODE" = "live" ]; then
    if [ "$WAS_ACTIVE" = "1" ]; then
        printf '%s' "$$" > "$COMMIT"
        trap 'rm -f "$COMMIT"' EXIT
        systemctl restart caddy
    else
        systemctl stop caddy >/dev/null 2>&1 || true
    fi
fi
if [ -s ${XRAY_CONFIG_PATH}.prev ]; then
    cp -f ${XRAY_CONFIG_PATH}.prev ${XRAY_CONFIG_PATH}
    systemctl restart xray
    systemctl is-active --quiet xray
    rm -f ${XRAY_CONFIG_PATH}.prev
fi
if [ -f "$ROOT/was-enabled" ]; then
    systemctl enable caddy >/dev/null 2>&1 || true
else
    systemctl disable caddy >/dev/null 2>&1 || true
fi
rm -f "$MARKER"
rm -rf "$ROOT"
if [ "$WAS_ACTIVE" = "1" ]; then
    rm -f "$SKIP_START"
else
    touch "$SKIP_START"
    [ "$MODE" = "--prestart" ] && exit 1
fi
RECOVERY
chmod 0755 /usr/local/sbin/celerity-front-recover

cat > /etc/systemd/system/celerity-front-recovery.service <<'RECOVERY_UNIT'
[Unit]
Description=Recover interrupted Celerity front transaction
After=local-fs.target xray.service
Before=caddy.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/celerity-front-recover --boot

[Install]
WantedBy=multi-user.target
RECOVERY_UNIT

cat > "$UNIT" <<'UNIT'
# Managed by Celerity
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStartPre=+/usr/local/sbin/celerity-front-recover --prestart
ExecStart=${CADDY_BIN} run --config ${CADDYFILE_PATH}
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
systemctl enable celerity-front-recovery.service >/dev/null 2>&1
echo "RUNTIME_READY"
`;
}

function buildApplyScript({
    requestId,
    releaseDir,
    host,
    publicPort,
    routePaths,
}) {
    if (!TASK_ID_RE.test(requestId)) throw new Error('Invalid front request id');
    if (releaseDir !== `${RELEASES_ROOT}/${requestId}`) throw new Error('Invalid front release directory');

    const smokePaths = routePaths.map(shellQuote).join(' ');
    return `#!/bin/bash
set -Eeuo pipefail

CADDYFILE=${CADDYFILE_PATH}
RELEASE_DIR=${shellQuote(releaseDir)}
BACKUP_ROOT=${shellQuote(`${BACKUP_PREFIX}/${requestId}`)}
TRANSACTION_MARKER=${TRANSACTION_MARKER}
XRAY_CONFIG=${XRAY_CONFIG_PATH}
HOST=${shellQuote(host)}
PORT=${publicPort}
SMOKE_HEADER=${shellQuote(`${FRONT_SMOKE_HEADER}: ${FRONT_SMOKE_VALUE}`)}
LIVE_MUTATED=0
TRANSACTION_ARMED=0
OWNS_TRANSACTION=0

backup_file() {
    local path="$1"
    local name="$2"
    if [ -e "$path" ]; then
        cp -a "$path" "$BACKUP_ROOT/$name"
        touch "$BACKUP_ROOT/$name.existed"
    fi
}

restore_file() {
    local path="$1"
    local name="$2"
    if [ -f "$BACKUP_ROOT/$name.existed" ]; then
        rm -f "$path"
        cp -a "$BACKUP_ROOT/$name" "$path"
    else
        rm -f "$path"
    fi
}

restore_transaction() {
    local rollback_failed=0
    rm -f /run/celerity-front-do-not-start
    printf '%s' "$$" > /run/celerity-front-commit
    restore_file "$CADDYFILE" Caddyfile || rollback_failed=1
    if [ -f "$BACKUP_ROOT/was-active" ]; then
        systemctl restart caddy || rollback_failed=1
    else
        systemctl stop caddy >/dev/null 2>&1 || rollback_failed=1
    fi
    if [ -s "$XRAY_CONFIG.prev" ]; then
        cp -f "$XRAY_CONFIG.prev" "$XRAY_CONFIG" || rollback_failed=1
        if systemctl restart xray && systemctl is-active --quiet xray; then
            rm -f "$XRAY_CONFIG.prev"
        else
            rollback_failed=1
        fi
    fi
    if [ -f "$BACKUP_ROOT/was-enabled" ]; then
        systemctl enable caddy >/dev/null 2>&1 || rollback_failed=1
    else
        systemctl disable caddy >/dev/null 2>&1 || rollback_failed=1
    fi
    rm -f /run/celerity-front-commit
    return "$rollback_failed"
}

finish() {
    local code=$?
    trap - EXIT HUP INT TERM
    if [ "$code" = "0" ]; then
        rm -f /run/celerity-front-commit
        rm -f "$XRAY_CONFIG.prev"
        if [ "$OWNS_TRANSACTION" = "1" ]; then
            rm -f "$TRANSACTION_MARKER"
            rm -rf "$BACKUP_ROOT"
        fi
        exit 0
    fi

    set +e
    local rollback_failed=0
    if [ "$LIVE_MUTATED" = "1" ] || [ "$TRANSACTION_ARMED" = "1" ]; then
        restore_transaction || rollback_failed=1

        if [ "$rollback_failed" = "0" ]; then
            echo "ROLLBACK: previous Xray and front restored"
        else
            echo "ERROR: rollback could not fully restore the previous runtime; recovery kept at $BACKUP_ROOT" >&2
        fi
    fi
    if [ "$rollback_failed" = "0" ] && [ "$OWNS_TRANSACTION" = "1" ]; then
        rm -f "$TRANSACTION_MARKER"
        rm -rf "$BACKUP_ROOT"
    fi
    rm -f /run/celerity-front-commit
    exit "$code"
}

trap finish EXIT
trap 'exit 1' HUP INT TERM

for command in curl flock; do
    command -v "$command" >/dev/null 2>&1 || { echo "ERROR: required command not found: $command"; exit 1; }
done

exec 9>${FRONT_LOCK_PATH}
flock -w 120 9 || { echo "ERROR: another front transaction is still running"; exit 1; }

# Keep the transaction prepared by prepareFront; recover only an older one.
if [ -s "$TRANSACTION_MARKER" ]; then
    RECOVERY_ROOT="$(cat "$TRANSACTION_MARKER")"
    if [ "$RECOVERY_ROOT" = "$BACKUP_ROOT" ] && [ -d "$BACKUP_ROOT" ]; then
        TRANSACTION_ARMED=1
        OWNS_TRANSACTION=1
    else
        echo "ERROR: another front transaction owns the node" >&2
        exit 1
    fi
fi

[ -s "$RELEASE_DIR/Caddyfile" ] || { echo "ERROR: staged Caddyfile is missing"; exit 1; }

if [ "$TRANSACTION_ARMED" = "0" ]; then
    mkdir -p "$BACKUP_ROOT"
    backup_file "$CADDYFILE" Caddyfile
    if systemctl is-active --quiet caddy; then
        touch "$BACKUP_ROOT/was-active"
    fi
    if systemctl is-enabled --quiet caddy; then
        touch "$BACKUP_ROOT/was-enabled"
    fi
    printf '%s' "$BACKUP_ROOT" > "$TRANSACTION_MARKER.new"
    mv -f "$TRANSACTION_MARKER.new" "$TRANSACTION_MARKER"
    TRANSACTION_ARMED=1
    OWNS_TRANSACTION=1
fi
LIVE_MUTATED=1
rm -f "$CADDYFILE.next"
ln -s "$RELEASE_DIR/Caddyfile" "$CADDYFILE.next"
mv -Tf "$CADDYFILE.next" "$CADDYFILE"

systemctl enable caddy >/dev/null 2>&1 || true
rm -f /run/celerity-front-do-not-start
printf '%s' "$$" > /run/celerity-front-commit
if [ -f "$BACKUP_ROOT/was-active" ]; then
    if ! systemctl restart caddy; then
        journalctl -u caddy -n 30 --no-pager 2>/dev/null || true
        echo "ERROR: caddy restart failed"
        exit 1
    fi
else
    if ! systemctl start caddy; then
        journalctl -u caddy -n 30 --no-pager 2>/dev/null || true
        echo "ERROR: caddy start failed"
        exit 1
    fi
fi
rm -f /run/celerity-front-commit
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
    ROUTE_CODE="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \\
        -H "$SMOKE_HEADER" \\
        --resolve "$HOST:$PORT:127.0.0.1" "https://$HOST:$PORT$path" || true)"
    echo "ROUTE SMOKE $path -> \${ROUTE_CODE:-no response}"
    if [ "$ROUTE_CODE" != "204" ]; then
        echo "ERROR: $path did not reach the expected Caddy route"
        exit 1
    fi

    UPSTREAM_CODE="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \\
        --resolve "$HOST:$PORT:127.0.0.1" "https://$HOST:$PORT$path" || true)"
    echo "UPSTREAM SMOKE $path -> \${UPSTREAM_CODE:-no response}"
    case "$UPSTREAM_CODE" in
        000|502|503|504|'')
            echo "ERROR: $path matched Caddy but the Xray upstream is unavailable"
            exit 1
            ;;
    esac
done

mapfile -t OLD_RELEASES < <(ls -1dt ${RELEASES_ROOT}/* 2>/dev/null || true)
for ((i=3; i<\${#OLD_RELEASES[@]}; i++)); do
    rm -rf "\${OLD_RELEASES[$i]}"
done

echo "APPLIED"
`;
}

function buildTeardownScript() {
    return `#!/bin/bash
set -euo pipefail
exec 9>${FRONT_LOCK_PATH}
flock -w 120 9
systemctl disable --now caddy >/dev/null 2>&1 || true
rm -f ${CADDYFILE_PATH} ${CADDY_CERT_PATH} ${CADDY_KEY_PATH}
rm -f ${XRAY_CONFIG_PATH}.prev
rm -f ${TRANSACTION_MARKER}
echo "FRONT: stopped"
`;
}

function buildSuspendScript(action) {
    if (action !== 'stop' && action !== 'start') throw new Error('Invalid Caddy suspend action');
    return `#!/bin/bash
set -euo pipefail
exec 9>${FRONT_LOCK_PATH}
flock -w 120 9
systemctl ${action} caddy
echo "FRONT: ${action === 'stop' ? 'suspended' : 'resumed'}"
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
    let caddyVersion = installed;
    if (installed) {
        log(`Caddy ${installed} is already installed`);
    } else {
        const version = await resolveCaddyVersion();
        const asset = selectCaddyAsset(version, architecture);
        if (!asset) {
            throw new Error(`Caddy ${version} has no release asset for ${architecture || 'this architecture'}`);
        }

        log(`Installing Caddy ${version} for ${architecture}`);
        const output = await execRequired(conn, buildInstallScript(asset), 'Caddy installation');
        log(output);
        caddyVersion = normalizeVersion(output.match(/^INSTALLED=(.+)$/m)?.[1]?.trim() || '') || version;
    }

    log(await execRequired(conn, buildRuntimeBootstrapScript(), 'Caddy runtime bootstrap'));
    return caddyVersion;
}

async function prepareFront(node, desired, log) {
    const front = node.xray.front;
    const host = frontSiteHost(node);
    const publicPort = front.publicPort || 443;
    const routes = buildFrontRoutes(node.xray, node.port);
    const requestId = crypto.randomUUID();
    const releaseDir = `${RELEASES_ROOT}/${requestId}`;
    const releaseCertPath = `${releaseDir}/cert.pem`;
    const releaseKeyPath = `${releaseDir}/key.pem`;
    const releaseSiteRoot = `${releaseDir}/site`;
    const releaseCaddyfile = buildCaddyfile(node, {
        certPath: releaseCertPath,
        keyPath: releaseKeyPath,
        siteRoot: releaseSiteRoot,
    });

    let conn;
    try {
        conn = await nodeSetup.connectSSH(node);
        const caddyVersion = await ensureCaddyInstalled(conn, log);
        const recovery = await execRequired(conn, `
if [ -s ${TRANSACTION_MARKER} ]; then
    MARKER_AGE=$(( $(date +%s) - $(stat -c %Y ${TRANSACTION_MARKER}) ))
    if [ "$MARKER_AGE" -lt 600 ]; then
        echo "ERROR: another front transaction is armed" >&2
        exit 1
    fi
    /usr/local/sbin/celerity-front-recover || [ ! -e ${TRANSACTION_MARKER} ]
fi
exec 9>${FRONT_LOCK_PATH}
flock -w 120 9
if [ -s ${XRAY_CONFIG_PATH}.prev ] && ! systemctl is-active --quiet caddy; then
    cp -f ${XRAY_CONFIG_PATH}.prev ${XRAY_CONFIG_PATH}
    systemctl restart xray
    systemctl is-active --quiet xray
    rm -f ${XRAY_CONFIG_PATH}.prev
    echo "RECOVERY: restored Xray after interrupted front cutover"
fi
`, 'Front recovery preflight');
        log(recovery);

        log(`Staging immutable front release ${requestId}`);
        await execRequired(
            conn,
            `mkdir -p ${releaseSiteRoot} ${BACKUP_PREFIX}`,
            'Front directory setup'
        );
        await nodeSetup.uploadFile(conn, releaseCaddyfile, `${releaseDir}/Caddyfile`);
        await nodeSetup.uploadFile(conn, desired.site, `${releaseSiteRoot}/index.html`);
        if (desired.tls) {
            await nodeSetup.uploadFile(conn, desired.tls.cert, releaseCertPath);
            await nodeSetup.uploadFile(conn, desired.tls.key, releaseKeyPath);
        }
        await execRequired(conn, `
chown -R caddy:caddy ${shellQuote(releaseDir)}
chmod 0750 ${shellQuote(releaseDir)}
chmod 0755 ${shellQuote(releaseSiteRoot)}
chmod 0644 ${shellQuote(`${releaseDir}/Caddyfile`)} ${shellQuote(`${releaseSiteRoot}/index.html`)}
${desired.tls ? `chmod 0640 ${shellQuote(releaseCertPath)} ${shellQuote(releaseKeyPath)}` : ''}
${CADDY_BIN} validate --adapter caddyfile --config ${shellQuote(`${releaseDir}/Caddyfile`)}
`, 'Front release validation');
        log('VALIDATED');
        await execRequired(conn, `
exec 9>${FRONT_LOCK_PATH}
flock -w 120 9
BACKUP_ROOT=${shellQuote(`${BACKUP_PREFIX}/${requestId}`)}
[ ! -e ${TRANSACTION_MARKER} ] || { echo "ERROR: another front transaction is armed"; exit 1; }
mkdir -p "$BACKUP_ROOT"
if [ -e ${CADDYFILE_PATH} ]; then
    cp -a ${CADDYFILE_PATH} "$BACKUP_ROOT/Caddyfile"
    touch "$BACKUP_ROOT/Caddyfile.existed"
fi
systemctl is-active --quiet caddy && touch "$BACKUP_ROOT/was-active" || true
systemctl is-enabled --quiet caddy && touch "$BACKUP_ROOT/was-enabled" || true
printf '%s' "$BACKUP_ROOT" > ${TRANSACTION_MARKER}.new
mv -f ${TRANSACTION_MARKER}.new ${TRANSACTION_MARKER}
`, 'Front transaction arm');
        log('TRANSACTION_ARMED');

        return {
            requestId,
            releaseDir,
            host,
            publicPort,
            routes,
            fingerprint: desired.fingerprint,
            caddyVersion,
        };
    } finally {
        if (conn) conn.end();
    }
}

async function activatePreparedFront(node, prepared, log) {
    let conn;
    try {
        conn = await nodeSetup.connectSSH(node);
        log(`Applying front on ${prepared.host}:${prepared.publicPort} for ${prepared.routes.length} inbound(s)`);
        const output = await execRequired(conn, buildApplyScript({
            requestId: prepared.requestId,
            releaseDir: prepared.releaseDir,
            host: prepared.host,
            publicPort: prepared.publicPort,
            routePaths: prepared.routes.map(route => route.paths[0]),
        }), 'Front apply');
        log(output);
        return {
            fingerprint: prepared.fingerprint,
            caddyVersion: prepared.caddyVersion,
        };
    } finally {
        if (conn) conn.end();
    }
}

async function discardPreparedFront(node, prepared) {
    if (!prepared?.releaseDir) return;
    let conn;
    try {
        conn = await nodeSetup.connectSSH(node);
        const backupRoot = `${BACKUP_PREFIX}/${prepared.requestId}`;
        await execRequired(conn, `
set -Eeuo pipefail
if [ -s ${TRANSACTION_MARKER} ] && [ "$(cat ${TRANSACTION_MARKER})" = ${shellQuote(backupRoot)} ]; then
    /usr/local/sbin/celerity-front-recover
    [ ! -e ${TRANSACTION_MARKER} ] || { echo "ERROR: transaction recovery is incomplete"; exit 1; }
fi
exec 9>${FRONT_LOCK_PATH}
flock -w 120 9
ACTIVE_RELEASE="$(readlink -f ${CADDYFILE_PATH} 2>/dev/null || true)"
if [ "$ACTIVE_RELEASE" != ${shellQuote(`${prepared.releaseDir}/Caddyfile`)} ]; then
    rm -rf ${shellQuote(prepared.releaseDir)}
fi
rm -rf ${shellQuote(backupRoot)}
`, 'Prepared front cleanup');
    } finally {
        if (conn) conn.end();
    }
}

async function provisionFront(node, desired, log) {
    const prepared = await prepareFront(node, desired, log);
    try {
        return await activatePreparedFront(node, prepared, log);
    } catch (error) {
        await discardPreparedFront(node, prepared).catch(() => {});
        throw error;
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

async function setFrontSuspended(node, suspended, log = () => {}) {
    let conn;
    try {
        conn = await nodeSetup.connectSSH(node);
        const action = suspended ? 'stop' : 'start';
        log(await execRequired(conn, buildSuspendScript(action), `Front ${action}`));
    } finally {
        if (conn) conn.end();
    }
}

async function completeFrontDisable(node, log = () => {}) {
    await teardownFront(node, log);
    try {
        await saveFrontState(node._id, {
            status: 'disabled',
            appliedFingerprint: '',
            lastError: '',
        });
        await clearFrontRollbackState(node._id);
    } catch (error) {
        error.remoteDisableCompleted = true;
        throw error;
    }
}

// manualKey and siteHtml are select:false everywhere else.
function loadNodeForFront(nodeId) {
    return HyNode.findById(nodeId).select(
        '+xray.manualKey +xray.front.siteHtml '
        + '+xray.front.rollbackSnapshot +xray.accessLogs.ingestTokenEncrypted'
    );
}

async function saveFrontState(nodeId, patch) {
    const update = {};
    for (const [key, value] of Object.entries(patch)) {
        update[`xray.front.${key}`] = value;
    }
    await HyNode.updateOne({ _id: nodeId }, { $set: update });
}

async function clearFrontRollbackState(nodeId) {
    await HyNode.updateOne(
        { _id: nodeId },
        { $unset: { 'xray.front.rollbackSnapshot': '' } }
    );
}

function hasOwn(object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

// The remote scripts restore the previous Xray config and Caddy release. This
// restores the matching MongoDB document so subscriptions cannot advertise a
// desired front that never became active.
async function rollbackFrontDatabaseState(nodeId, message) {
    const node = await loadNodeForFront(nodeId);
    if (!node?.xray?.front) return false;

    const current = node.toObject();
    const front = current.xray?.front || {};
    const saved = front.rollbackSnapshot;

    if (saved?.xray) {
        const restoredXray = { ...saved.xray };
        restoredXray.front = { ...(restoredXray.front || {}) };
        delete restoredXray.front.rollbackSnapshot;

        // REST/MCP snapshots intentionally omit select:false secrets. Preserve
        // their current values while rolling the visible Xray config back.
        if (!hasOwn(restoredXray, 'manualKey') && hasOwn(current.xray, 'manualKey')) {
            restoredXray.manualKey = current.xray.manualKey;
        }
        if (!hasOwn(restoredXray.front, 'siteHtml') && hasOwn(front, 'siteHtml')) {
            restoredXray.front.siteHtml = front.siteHtml;
        }
        if (!restoredXray.accessLogs) restoredXray.accessLogs = {};
        if (!hasOwn(restoredXray.accessLogs, 'ingestTokenEncrypted')
            && hasOwn(current.xray?.accessLogs, 'ingestTokenEncrypted')) {
            restoredXray.accessLogs.ingestTokenEncrypted =
                current.xray.accessLogs.ingestTokenEncrypted;
        }

        restoredXray.front.lastError = String(message || '').slice(0, 1000);
        restoredXray.front.status = restoredXray.front.enabled
            && restoredXray.front.appliedFingerprint
            ? 'active'
            : 'error';

        if (saved.ip !== undefined) node.ip = saved.ip;
        node.port = saved.port;
        node.domain = saved.domain;
        node.xray = restoredXray;
        if (saved.status) node.status = saved.status;
        node.lastError = saved.lastError || '';
        await node.save();
    } else if (!front.appliedFingerprint) {
        // A newly-created or legacy pending front has no earlier active Caddy
        // release. Return its inbounds to the captured direct listener layout.
        const restoredXray = { ...current.xray, front: { ...front } };
        restoreFrontInboundLayout(restoredXray, node, front.layoutSnapshot);
        restoredXray.front.enabled = false;
        restoredXray.front.status = 'error';
        restoredXray.front.lastError = String(message || '').slice(0, 1000);
        delete restoredXray.front.rollbackSnapshot;
        node.xray = restoredXray;
        await node.save();
    } else {
        // A forced re-apply of an unchanged active front has no mutation
        // snapshot. The remote rollback restored that same active release.
        await saveFrontState(nodeId, {
            status: 'active',
            lastError: String(message || '').slice(0, 1000),
        });
        await clearFrontRollbackState(nodeId);
    }

    await invalidateNodesCache();
    return true;
}

async function finalizeAppliedFront(nodeId, applied, log = () => {}) {
    const latest = await loadNodeForFront(nodeId);
    let latestFingerprint = '';
    try {
        latestFingerprint = latest?.xray?.front?.enabled
            ? buildDesiredState(latest).fingerprint
            : '';
    } catch (_) {}

    if (latestFingerprint !== applied.fingerprint) {
        await saveFrontState(nodeId, {
            status: 'pending',
            appliedFingerprint: applied.fingerprint,
            caddyVersion: applied.caddyVersion,
            lastError: 'Front settings changed during apply; reconciliation was queued again.',
        });
        log('Front settings changed during apply; another reconciliation is required');
        return { changed: true, stale: true };
    }

    await saveFrontState(nodeId, {
        status: 'active',
        appliedFingerprint: applied.fingerprint,
        caddyVersion: applied.caddyVersion,
        lastError: '',
    });
    await clearFrontRollbackState(nodeId);
    await invalidateNodesCache();
    return { changed: true };
}

// Promote an unchanged pending front only after the matching Xray update has
// succeeded. Re-read the node so a concurrent edit cannot publish stale state.
async function promotePendingFront(nodeId) {
    const latest = await loadNodeForFront(nodeId);
    const front = latest?.xray?.front;
    if (!front?.enabled) return false;
    if (front.status === 'active') return true;
    if (!front.appliedFingerprint) return false;

    let fingerprint = '';
    try {
        fingerprint = buildDesiredState(latest).fingerprint;
    } catch (_) {
        return false;
    }
    if (fingerprint !== front.appliedFingerprint) return false;

    await saveFrontState(nodeId, { status: 'active', lastError: '' });
    await clearFrontRollbackState(nodeId);
    await invalidateNodesCache();
    return true;
}

async function prepareFrontForSync(nodeOrId, {
    force = false,
    log = () => {},
    deferPublication = false,
} = {}) {
    const nodeId = nodeOrId?._id || nodeOrId;
    const node = await loadNodeForFront(nodeId);
    if (!node || node.type !== 'xray') return { skipped: 'not-an-xray-node' };
    const front = node.xray?.front;
    if (!front?.enabled) return { skipped: 'disabled', node };
    if (node.xray?.tlsSource === 'panel' && front.appliedFingerprint && front.status === 'active') {
        if (!force) return { skipped: 'legacy-panel-front-preserved', node };
        const message = 'Existing Panel TLS front was preserved; select manual PEM or ACME before applying it again.';
        await saveFrontState(nodeId, { lastError: message });
        return { error: message, node };
    }

    let desired;
    try {
        desired = buildDesiredState(node);
    } catch (error) {
        await rollbackFrontDatabaseState(nodeId, error.message);
        return { error: error.message, node };
    }

    if (!force && desired.fingerprint === front.appliedFingerprint) {
        // The Caddy release is unchanged, but Xray settings from the same save
        // may still be in flight. Automatic sync promotes it only after Xray
        // succeeds; standalone reconciliation may promote immediately.
        const publishAfterSync = front.status !== 'active';
        if (publishAfterSync && !deferPublication) {
            await promotePendingFront(nodeId);
        }
        return { skipped: 'up-to-date', publishAfterSync, node };
    }

    await saveFrontState(nodeId, { status: 'pending', lastError: '' });
    await invalidateNodesCache();
    try {
        const prepared = await prepareFront(node, desired, log);
        return { node, desired, prepared };
    } catch (error) {
        const message = error.remoteOutput ? `${error.message}: ${error.remoteOutput}` : error.message;
        await rollbackFrontDatabaseState(nodeId, message);
        return { error: message, node };
    }
}

async function activateFrontForSync(node, prepared, { log = () => {} } = {}) {
    const nodeId = node?._id || prepared?.nodeId;
    try {
        const applied = await activatePreparedFront(node, prepared, log);
        return await finalizeAppliedFront(nodeId, applied, log);
    } catch (error) {
        const message = error.remoteOutput ? `${error.message}: ${error.remoteOutput}` : error.message;
        await discardPreparedFront(node, prepared).catch(() => {});
        await rollbackFrontDatabaseState(nodeId, message);
        return { changed: false, error: message };
    }
}

// Provisions, tears down or skips one node's front, depending on its state.
async function reconcileFront(nodeOrId, {
    force = false,
    log = () => {},
    lockHeld = false,
} = {}) {
    const nodeId = nodeOrId?._id || nodeOrId;
    const lockKey = String(nodeId);
    if (!lockHeld && !nodeSetupLock.acquire(lockKey, 'Caddy front apply')) {
        return { changed: false, skipped: 'node-busy', error: `Node is busy: ${nodeSetupLock.holder(lockKey)} is running` };
    }
    try {
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
            await clearFrontRollbackState(nodeId);
            return { changed: true };
        } catch (error) {
            const message = error.remoteOutput ? `${error.message}: ${error.remoteOutput}` : error.message;
            logger.warn(`[Front] ${node.name}: teardown failed - ${message}`);
            await rollbackFrontDatabaseState(nodeId, message);
            return { changed: false, error: message };
        }
    }

    if (!node.ssh?.password && !node.ssh?.privateKey) {
        return { changed: false, skipped: 'no-ssh-credentials' };
    }

    const staged = await prepareFrontForSync(nodeId, { force, log });
    if (staged.error) return { changed: false, error: staged.error };
    if (staged.skipped) return { changed: false, skipped: staged.skipped };

    // Use the same activation wrapper as automatic sync: besides rolling the
    // database back, it recovers the armed remote transaction and removes the
    // staged release when the second SSH connection or apply script fails.
    const finalized = await activateFrontForSync(staged.node, staged.prepared, { log });
    if (finalized.error) {
        logger.error(`[Front] ${node.name}: apply failed - ${finalized.error}`);
        return finalized;
    }
    if (finalized.stale) {
        const timer = setTimeout(() => {
            reconcileFront(nodeId).catch(error => {
                logger.warn(`[Front] stale-state reconcile failed: ${error.message}`);
            });
        }, 1000);
        timer.unref?.();
    }
    logger.info(`[Front] ${node.name}: front active on port ${front.publicPort || 443}`);
    return finalized;
    } finally {
        if (!lockHeld) nodeSetupLock.release(lockKey);
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
    buildRuntimeBootstrapScript,
    buildApplyScript,
    buildTeardownScript,
    prepareFrontForSync,
    activateFrontForSync,
    discardPreparedFront,
    setFrontSuspended,
    completeFrontDisable,
    clearFrontRollbackState,
    promotePendingFront,
    rollbackFrontDatabaseState,
    reconcileFront,
    getTask,
    startFrontApply,
};
