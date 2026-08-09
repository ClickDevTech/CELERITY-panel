#!/bin/sh
# Celerity Probe installer (Linux with systemd, macOS with launchd).
#
# Usage (the panel generates this line with a single-use token):
#   curl -fsSL .../celerity-probe-install.sh | sudo PANEL_URL='https://panel' ENROLL_TOKEN='ce_...' sh
#
# Installs the probe binary, fetches a sing-box core, enrolls once and registers
# a service. The probe needs no privileges on any node: it only holds client
# subscription credentials.

set -eu

PANEL_URL="${PANEL_URL:-}"
ENROLL_TOKEN="${ENROLL_TOKEN:-}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
RELEASE_BASE="${RELEASE_BASE:-https://github.com/ClickDevTech/CELERITY-panel/releases/latest/download}"

if [ -z "$PANEL_URL" ] || [ -z "$ENROLL_TOKEN" ]; then
    echo "ERROR: PANEL_URL and ENROLL_TOKEN are required" >&2
    exit 1
fi

# The probe token and every measurement travel over this URL. Plain HTTP would
# hand both to anyone on the path, so it is only allowed against a loopback
# panel and only when explicitly requested.
case "$PANEL_URL" in
    https://*) ;;
    http://127.0.0.1*|http://localhost*) ;;
    *)
        if [ "${PROBE_ALLOW_INSECURE:-0}" != "1" ]; then
            echo "ERROR: PANEL_URL must use https (set PROBE_ALLOW_INSECURE=1 to override)" >&2
            exit 1
        fi
        ;;
esac

if [ "$(id -u)" != "0" ]; then
    echo "ERROR: run as root" >&2
    exit 1
fi

case "$(uname -s)" in
    Linux)  OS="linux" ;;
    Darwin) OS="darwin" ;;
    *) echo "ERROR: unsupported system $(uname -s), use install.ps1 on Windows" >&2; exit 1 ;;
esac

case "$(uname -m)" in
    x86_64|amd64)   ARCH="amd64" ;;
    aarch64|arm64)  ARCH="arm64" ;;
    *) echo "ERROR: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

if [ "$OS" = "darwin" ]; then
    DATA_DIR="${DATA_DIR:-/usr/local/var/celerity-probe}"
else
    DATA_DIR="${DATA_DIR:-/var/lib/celerity-probe}"
fi

echo "==> Installing celerity-probe ($OS/$ARCH)"

# A reinstall runs against a live service: it holds the data directory open and
# would keep reporting with the old credentials while this script rewrites them.
if [ "$OS" = "darwin" ]; then
    launchctl unload /Library/LaunchDaemons/tech.clickdev.celerity-probe.plist >/dev/null 2>&1 || true
elif command -v systemctl >/dev/null 2>&1; then
    systemctl stop celerity-probe >/dev/null 2>&1 || true
fi

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

PROBE_URL="$RELEASE_BASE/celerity-probe-$OS-$ARCH"
echo "==> Downloading $PROBE_URL"
# Downloading straight onto the target fails with ETXTBSY while an older probe
# is still executing that file. Write beside it and rename: the rename succeeds
# even then, because the running process keeps the old inode.
PROBE_TMP="$BIN_DIR/.celerity-probe.new"
curl -fsSL --max-time 180 "$PROBE_URL" -o "$PROBE_TMP"
if [ ! -s "$PROBE_TMP" ]; then
    rm -f "$PROBE_TMP"
    echo "ERROR: probe download failed" >&2
    exit 1
fi
chmod 755 "$PROBE_TMP"
mv -f "$PROBE_TMP" "$BIN_DIR/celerity-probe"

# The core must be the same build the Click Connect clients run: sing-box-lx,
# built with `with_xhttp`. Upstream sing-box refuses a configuration containing
# an XHTTP outbound, so a probe on upstream cannot check an XHTTP node — and
# a probe that checks something other than what users run is worthless.
CORE_REPO="${CORE_REPO:-Leadaxe/sing-box-lx}"
CORE_BIN="$DATA_DIR/sing-box"

core_is_usable() {
    [ -x "$CORE_BIN" ] || return 1
    # Covers the upgrade path from an earlier install that pulled upstream.
    "$CORE_BIN" version 2>/dev/null | grep -q "with_xhttp" || return 1
    return 0
}

if core_is_usable; then
    echo "==> Core already installed: $("$CORE_BIN" version 2>/dev/null | head -n 1)"
else
    echo "==> Resolving latest $CORE_REPO release"
    # Versions look like 1.14.0-lx.22, so the pattern cannot assume digits only.
    SB_URL=$(curl -fsSL --max-time 60 "https://api.github.com/repos/$CORE_REPO/releases/latest" \
        | grep -o "https://[^\"]*/sing-box-[^\"]*-$OS-$ARCH\.tar\.gz" \
        | head -n 1)

    if [ -z "$SB_URL" ]; then
        echo "ERROR: could not resolve a core download URL for $OS/$ARCH" >&2
        exit 1
    fi

    echo "==> Downloading $SB_URL"
    TMP_DIR=$(mktemp -d)
    SB_FILE=$(basename "$SB_URL")
    curl -fsSL --max-time 300 "$SB_URL" -o "$TMP_DIR/$SB_FILE"

    # The release publishes SHA256SUMS; verifying it costs one request and
    # turns a corrupted or substituted archive into a failed install.
    if curl -fsSL --max-time 60 "$(dirname "$SB_URL")/SHA256SUMS" -o "$TMP_DIR/SHA256SUMS" 2>/dev/null; then
        EXPECTED=$(grep " $SB_FILE\$" "$TMP_DIR/SHA256SUMS" | awk '{print $1}' | head -n 1)
        if [ -n "$EXPECTED" ]; then
            if command -v sha256sum >/dev/null 2>&1; then
                ACTUAL=$(sha256sum "$TMP_DIR/$SB_FILE" | awk '{print $1}')
            else
                ACTUAL=$(shasum -a 256 "$TMP_DIR/$SB_FILE" | awk '{print $1}')
            fi
            if [ "$EXPECTED" != "$ACTUAL" ]; then
                rm -rf "$TMP_DIR"
                echo "ERROR: core checksum mismatch" >&2
                exit 1
            fi
            echo "==> Checksum verified"
        fi
    fi

    tar -xzf "$TMP_DIR/$SB_FILE" -C "$TMP_DIR"
    find "$TMP_DIR" -type f -name sing-box -exec cp {} "$CORE_BIN.new" \;
    rm -rf "$TMP_DIR"

    if [ ! -s "$CORE_BIN.new" ]; then
        rm -f "$CORE_BIN.new"
        echo "ERROR: core extraction failed" >&2
        exit 1
    fi
    chmod 755 "$CORE_BIN.new"
    # Same ETXTBSY reasoning as the probe binary above.
    mv -f "$CORE_BIN.new" "$CORE_BIN"
    echo "==> Core installed: $("$CORE_BIN" version 2>/dev/null | head -n 1)"
fi

echo "==> Enrolling with $PANEL_URL"
# The token goes through the environment, never through argv: the process table
# is world-readable and a single-use token is still a live credential.
ENROLL_TOKEN="$ENROLL_TOKEN" "$BIN_DIR/celerity-probe" -dir "$DATA_DIR" -panel "$PANEL_URL"

if [ "$OS" = "darwin" ]; then
    PLIST=/Library/LaunchDaemons/tech.clickdev.celerity-probe.plist
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>tech.clickdev.celerity-probe</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BIN_DIR/celerity-probe</string>
        <string>-dir</string>
        <string>$DATA_DIR</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$DATA_DIR/probe.log</string>
    <key>StandardErrorPath</key>
    <string>$DATA_DIR/probe.log</string>
</dict>
</plist>
EOF
    chmod 644 "$PLIST"
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load -w "$PLIST"
    echo "==> Done. Follow the logs with: tail -f $DATA_DIR/probe.log"
    exit 0
fi

# The probe never needs root at runtime: it dials outbound and writes to its
# own data directory. Running it as a dedicated account keeps a compromise of
# the core or of the panel connection away from the rest of the host.
SERVICE_USER="celerity-probe"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
        || adduser --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
        || SERVICE_USER=""
fi

if [ -n "$SERVICE_USER" ]; then
    chown -R "$SERVICE_USER" "$DATA_DIR"
    SERVICE_IDENTITY="User=$SERVICE_USER"
else
    echo "WARN: could not create a service account, the probe will run as root" >&2
    SERVICE_IDENTITY=""
fi

cat > /etc/systemd/system/celerity-probe.service <<EOF
[Unit]
Description=Celerity Probe
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$SERVICE_IDENTITY
ExecStart=$BIN_DIR/celerity-probe -dir $DATA_DIR
Restart=always
RestartSec=10
# The probe only makes outbound connections and writes to its own data dir.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
# The core is a child process: killing the unit must take it down too.
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable celerity-probe >/dev/null 2>&1 || true
systemctl restart celerity-probe

echo "==> Done. Follow the logs with: journalctl -u celerity-probe -f"
