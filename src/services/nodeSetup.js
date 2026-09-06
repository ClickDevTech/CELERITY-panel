/**
 * Hysteria node auto-setup service via SSH
 */

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../../config');
const cryptoService = require('./cryptoService');
const Settings = require('../models/settingsModel');
const configGenerator = require('./configGenerator');
const { isServerlessNode } = require('../utils/nodeTypes');

function isLoopbackAddress(value) {
    const address = String(value || '').trim().toLowerCase();
    return /^127\./.test(address)
        || address === '::1'
        || address === '0:0:0:0:0:0:0:1';
}

/**
 * Check if a node is on the same VPS as the panel
 * Uses multiple heuristics: domain match, IP match via DNS, localhost detection
 * @param {Object} node - Node object with ip and domain fields
 * @returns {boolean} true if node appears to be on the same server as the panel
 */
function isSameVpsAsPanel(node) {
    const panelDomain = (config.PANEL_DOMAIN || '').toLowerCase().trim();
    
    // 1. Domain match - most reliable indicator
    if (node.domain && node.domain === panelDomain) {
        logger.debug(`[NodeSetup] Same VPS detected: domain match (${node.domain})`);
        return true;
    }
    
    // 2. Localhost / loopback detection
    const nodeIp = (node.ip || '').toLowerCase().trim();
    if (panelDomain && nodeIp === panelDomain) {
        logger.debug(`[NodeSetup] Same VPS detected: node IP/host matches panel domain (${nodeIp})`);
        return true;
    }
    if (nodeIp === 'localhost' || nodeIp === '127.0.0.1' || nodeIp === '::1') {
        logger.debug(`[NodeSetup] Same VPS detected: localhost IP (${nodeIp})`);
        return true;
    }
    
    // 3. Try to resolve panel domain and compare with node IP
    // This is a sync check using cached DNS or env variable
    const panelIpFromEnv = process.env.PANEL_IP || '';
    if (panelIpFromEnv && panelIpFromEnv === nodeIp) {
        logger.debug(`[NodeSetup] Same VPS detected: IP match via PANEL_IP env (${nodeIp})`);
        return true;
    }
    
    return false;
}

/**
 * Read panel's SSL certificates from Greenlock or Caddy directory
 * @param {string} domain - Panel domain
 * @returns {Object|null} { cert, key } or null if not found
 */
function getPanelCertificates(domain) {
    try {
        let cert, key;
        
        // Try Caddy certificates first (when USE_CADDY=true)
        // Caddy stores certs in /caddy_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/{domain}/
        const caddyDir = path.join('/caddy_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory', domain);
        const caddyCertPath = path.join(caddyDir, `${domain}.crt`);
        const caddyKeyPath = path.join(caddyDir, `${domain}.key`);
        
        if (fs.existsSync(caddyCertPath) && fs.existsSync(caddyKeyPath)) {
            cert = fs.readFileSync(caddyCertPath, 'utf8');
            key = fs.readFileSync(caddyKeyPath, 'utf8');
            logger.info(`[NodeSetup] Found Caddy certificates for ${domain}`);
            return { cert, key };
        }
        
        // Try Greenlock certificates (when USE_CADDY is not set)
        // Greenlock stores certs in greenlock.d/live/{domain}/:
        //   - cert.pem      : leaf certificate only (1 BEGIN CERTIFICATE)
        //   - fullchain.pem : leaf + intermediates (the bundle TLS servers must serve)
        //   - privkey.pem   : private key
        // We MUST prefer fullchain.pem; otherwise Hysteria serves an incomplete TLS
        // chain and strict clients (insecure=false) fail with x509: certificate
        // signed by unknown authority. See issue #63.
        const greenlockDir = path.join(__dirname, '../../greenlock.d/live', domain);
        const certPath = path.join(greenlockDir, 'cert.pem');
        const keyPath = path.join(greenlockDir, 'privkey.pem');
        const fullchainPath = path.join(greenlockDir, 'fullchain.pem');
        
        if (fs.existsSync(fullchainPath)) {
            cert = fs.readFileSync(fullchainPath, 'utf8');
            logger.info(`[NodeSetup] Using Greenlock fullchain.pem for ${domain}`);
        } else if (fs.existsSync(certPath)) {
            cert = fs.readFileSync(certPath, 'utf8');
            logger.warn(`[NodeSetup] fullchain.pem missing for ${domain}, falling back to cert.pem (TLS chain may be incomplete)`);
        }
        
        if (fs.existsSync(keyPath)) {
            key = fs.readFileSync(keyPath, 'utf8');
        }
        
        if (cert && key) {
            logger.info(`[NodeSetup] Found Greenlock certificates for ${domain}`);
            return { cert, key };
        }
        
        logger.warn(`[NodeSetup] Panel certificates not found (checked Caddy: ${caddyDir}, Greenlock: ${greenlockDir})`);
        return null;
        
    } catch (error) {
        logger.error(`[NodeSetup] Error reading panel certificates: ${error.message}`);
        return null;
    }
}

// Reusable shell snippet: persist iptables rules across reboots
const IPTABLES_SAVE_SNIPPET = `
if command -v netfilter-persistent &> /dev/null; then
    netfilter-persistent save 2>/dev/null
    echo "Done: Rules saved with netfilter-persistent"
elif [ -f /etc/debian_version ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y netfilter-persistent iptables-persistent 2>/dev/null || true
    netfilter-persistent save 2>/dev/null || true
elif command -v iptables-save &> /dev/null; then
    mkdir -p /etc/iptables
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true
    echo "Done: Rules saved with iptables-save"
fi`;

const INSTALL_SCRIPT = `#!/bin/bash
set -e

echo "=== [0/5] System diagnostics ==="
echo "--- OS info ---"
cat /etc/os-release 2>/dev/null | grep -E "^(NAME|VERSION|ID)=" || echo "(os-release not found)"
uname -a 2>/dev/null || true
echo "--- Disk space ---"
df -h / 2>/dev/null || true
echo "--- Memory ---"
free -h 2>/dev/null || true
echo "--- Network interfaces ---"
ip addr show 2>/dev/null | grep -E "^[0-9]+:|inet " || ifconfig 2>/dev/null | grep -E "^[a-z]|inet " || true
echo "--- Checking required tools ---"

MISSING_TOOLS=""

if command -v curl &> /dev/null; then
    echo "OK: curl $(curl --version 2>&1 | head -1)"
else
    echo "MISSING: curl is not installed — trying to install..."
    if command -v apt-get &> /dev/null; then
        apt-get update -qq && apt-get install -y curl
        if command -v curl &> /dev/null; then
            echo "Done: curl installed via apt-get"
        else
            echo "ERROR: Failed to install curl via apt-get"
            MISSING_TOOLS="$MISSING_TOOLS curl"
        fi
    elif command -v yum &> /dev/null; then
        yum install -y curl
        if command -v curl &> /dev/null; then
            echo "Done: curl installed via yum"
        else
            echo "ERROR: Failed to install curl via yum"
            MISSING_TOOLS="$MISSING_TOOLS curl"
        fi
    elif command -v dnf &> /dev/null; then
        dnf install -y curl
        if command -v curl &> /dev/null; then
            echo "Done: curl installed via dnf"
        else
            echo "ERROR: Failed to install curl via dnf"
            MISSING_TOOLS="$MISSING_TOOLS curl"
        fi
    else
        echo "ERROR: No package manager found (apt-get/yum/dnf). Cannot install curl."
        MISSING_TOOLS="$MISSING_TOOLS curl"
    fi
fi

if command -v bash &> /dev/null; then
    echo "OK: bash $(bash --version 2>&1 | head -1)"
else
    echo "ERROR: bash is not available — this is very unusual"
    MISSING_TOOLS="$MISSING_TOOLS bash"
fi

if command -v systemctl &> /dev/null; then
    echo "OK: systemctl available ($(systemctl --version 2>&1 | head -1))"
else
    echo "WARNING: systemctl not found — service management may fail"
fi

if command -v openssl &> /dev/null; then
    echo "OK: openssl $(openssl version 2>&1)"
else
    echo "WARNING: openssl not installed (needed for self-signed cert)"
fi

if [ -n "$MISSING_TOOLS" ]; then
    echo "ERROR: Required tools are missing:$MISSING_TOOLS"
    echo "Cannot continue setup. Please install missing tools and try again."
    exit 1
fi

echo "--- Checking connectivity ---"
if curl -s --max-time 5 https://get.hy2.sh/ -o /dev/null -w "HTTPS connectivity: HTTP %{http_code}\\n"; then
    echo "OK: HTTPS connectivity confirmed"
else
    echo "WARNING: Could not reach get.hy2.sh — internet access may be limited"
fi

echo "=== [1/5] Checking Hysteria installation ==="

if ! command -v hysteria &> /dev/null; then
    echo "Hysteria not found. Installing..."
    echo "Running: bash <(curl -fsSL https://get.hy2.sh/)"
    INSTALL_EXIT=0
    bash <(curl -fsSL https://get.hy2.sh/) || INSTALL_EXIT=$?
    if [ "$INSTALL_EXIT" -ne 0 ]; then
        echo "WARNING: Install script exited with code $INSTALL_EXIT"
    fi
    if command -v hysteria &> /dev/null; then
        echo "Done: Hysteria installed successfully"
    else
        echo "ERROR: Hysteria binary not found after installation script"
        echo "Install script exit code: $INSTALL_EXIT"
        echo "Checking common paths:"
        ls -la /usr/local/bin/hysteria 2>/dev/null || echo "  /usr/local/bin/hysteria — not found"
        ls -la /usr/bin/hysteria 2>/dev/null || echo "  /usr/bin/hysteria — not found"
        echo "Checking PATH:"
        echo "  PATH=$PATH"
        which hysteria 2>/dev/null || echo "  which hysteria — not found"
        exit 1
    fi
else
    echo "Done: Hysteria already installed"
fi

mkdir -p /etc/hysteria
echo "Done: Directory /etc/hysteria ready"

echo "Hysteria version:"
hysteria version
`;

function getPortHoppingScript(portRange, mainPort) {
    if (!portRange || !portRange.includes('-')) return '';
    
    const [start, end] = portRange.split('-').map(p => parseInt(p.trim()));
    
    return `
echo "=== [4/5] Setting up port hopping ${start}-${end} -> ${mainPort} ==="

# Clear old rules
iptables -D INPUT -p udp --dport ${start}:${end} -j ACCEPT 2>/dev/null || true
ip6tables -D INPUT -p udp --dport ${start}:${end} -j ACCEPT 2>/dev/null || true
iptables -t nat -D PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
ip6tables -t nat -D PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true

# Clear legacy interface-specific rules
for iface in eth0 eth1 ens3 ens5 enp0s3 eno1; do
    iptables -t nat -D PREROUTING -i $iface -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
    ip6tables -t nat -D PREROUTING -i $iface -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
done

# Open hop range in firewall before redirecting it
iptables -C INPUT -p udp --dport ${start}:${end} -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport ${start}:${end} -j ACCEPT
ip6tables -C INPUT -p udp --dport ${start}:${end} -j ACCEPT 2>/dev/null || ip6tables -I INPUT -p udp --dport ${start}:${end} -j ACCEPT 2>/dev/null || true
echo "Done: INPUT rules added"

# Add new rules (no interface binding)
iptables -t nat -C PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || iptables -t nat -A PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort}
ip6tables -t nat -C PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || ip6tables -t nat -A PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
echo "Done: iptables NAT rules added"

# Open ports in firewall (ufw)
if command -v ufw &> /dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow ${start}:${end}/udp 2>/dev/null || true
    echo "Done: UFW rules added"
fi

# Save rules
if command -v netfilter-persistent &> /dev/null; then
    netfilter-persistent save 2>/dev/null
    echo "Done: Rules saved with netfilter-persistent"
elif [ -f /etc/debian_version ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y netfilter-persistent 2>/dev/null || true
    netfilter-persistent save 2>/dev/null || true
elif command -v iptables-save &> /dev/null; then
    mkdir -p /etc/iptables
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true
    echo "Done: Rules saved with iptables-save"
fi

echo "Done: Port hopping configured: ${start}-${end} -> ${mainPort}"
`;
}

const SELF_SIGNED_CERT_SCRIPT = `
echo "=== [2/5] Generating self-signed certificate ==="

if ! command -v openssl &> /dev/null; then
    echo "Installing openssl..."
    apt-get update && apt-get install -y openssl
fi

echo "Checking existing certificates..."
ls -la /etc/hysteria/*.pem 2>/dev/null || echo "No existing cert files"

CERT_VALID=0
if [ -f /etc/hysteria/cert.pem ] && [ -s /etc/hysteria/cert.pem ] && [ -f /etc/hysteria/key.pem ] && [ -s /etc/hysteria/key.pem ]; then
    if openssl x509 -in /etc/hysteria/cert.pem -noout 2>/dev/null; then
        echo "Done: Valid certificate already exists"
        CERT_VALID=1
        openssl x509 -in /etc/hysteria/cert.pem -noout -subject -dates
    else
        echo "Warning: Certificate file exists but is invalid, regenerating..."
    fi
fi

if [ "$CERT_VALID" = "0" ]; then
    echo "Generating new certificate..."
    
    rm -f /etc/hysteria/cert.pem /etc/hysteria/key.pem /tmp/ecparam.pem
    mkdir -p /etc/hysteria
    
    echo "Step 1: Generating EC parameters..."
    openssl ecparam -name prime256v1 -out /tmp/ecparam.pem
    if [ ! -f /tmp/ecparam.pem ]; then
        echo "Error: Failed to create EC parameters"
        exit 1
    fi
    echo "Done: EC parameters created"
    
    echo "Step 2: Generating certificate..."
    openssl req -x509 -nodes -newkey ec:/tmp/ecparam.pem \\
        -keyout /etc/hysteria/key.pem \\
        -out /etc/hysteria/cert.pem \\
        -subj "/CN=bing.com" \\
        -days 36500 2>&1
    
    if [ ! -f /etc/hysteria/cert.pem ] || [ ! -s /etc/hysteria/cert.pem ]; then
        echo "Error: Certificate file not created or empty!"
        echo "Trying alternative method with RSA..."
        
        openssl req -x509 -nodes -newkey rsa:2048 \\
            -keyout /etc/hysteria/key.pem \\
            -out /etc/hysteria/cert.pem \\
            -subj "/CN=bing.com" \\
            -days 36500 2>&1
    fi
    
    if [ ! -f /etc/hysteria/key.pem ] || [ ! -s /etc/hysteria/key.pem ]; then
        echo "Error: Key file not created or empty!"
        exit 1
    fi
    
    # Set correct ownership for hysteria user (if exists)
    if id "hysteria" &>/dev/null; then
        chown hysteria:hysteria /etc/hysteria/key.pem /etc/hysteria/cert.pem
        echo "Done: Ownership set to hysteria:hysteria"
    fi
    chmod 600 /etc/hysteria/key.pem
    chmod 644 /etc/hysteria/cert.pem
    rm -f /tmp/ecparam.pem
    
    echo "Step 3: Verifying certificate..."
    if openssl x509 -in /etc/hysteria/cert.pem -noout 2>/dev/null; then
        echo "Done: Certificate generated successfully!"
        openssl x509 -in /etc/hysteria/cert.pem -noout -subject -dates
        ls -la /etc/hysteria/*.pem
    else
        echo "Error: Certificate verification failed!"
        cat /etc/hysteria/cert.pem
        exit 1
    fi
fi
`;

function connectSSH(node) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        
        const connConfig = {
            host: node.ip,
            port: node.ssh?.port || 22,
            username: node.ssh?.username || 'root',
            readyTimeout: 30000,
        };
        
        if (node.ssh?.privateKey) {
            connConfig.privateKey = cryptoService.decryptPrivateKey(node.ssh.privateKey);
        } else if (node.ssh?.password) {
            connConfig.password = cryptoService.decryptSafe(node.ssh.password);
        } else {
            return reject(new Error('SSH credentials not provided'));
        }
        
        conn.on('ready', () => resolve(conn));
        conn.on('error', (err) => reject(err));
        conn.connect(connConfig);
    });
}

function execSSH(conn, command) {
    return new Promise((resolve, reject) => {
        conn.exec(command, (err, stream) => {
            if (err) return reject(err);
            
            let stdout = '';
            let stderr = '';
            
            stream.on('close', (code) => {
                const output = stdout + (stderr ? '\n[STDERR]:\n' + stderr : '');
                
                if (code === 0) {
                    resolve({ success: true, output, code });
                } else {
                    resolve({ success: false, output, code, error: `Exit code: ${code}` });
                }
            });
            
            stream.on('data', (data) => { stdout += data.toString(); });
            stream.stderr.on('data', (data) => { stderr += data.toString(); });
        });
    });
}

function resolveNodeServiceCandidates(node) {
    if (!node || isServerlessNode(node)) return [];
    if (node.type === 'xray') return ['xray'];
    return ['hysteria-server', 'hysteria'];
}

function hasSshCredentials(node) {
    return !!(node?.ssh?.password || node?.ssh?.privateKey);
}

function serviceExistsCommand(serviceName) {
    return `systemctl list-unit-files ${serviceName}.service --no-legend 2>/dev/null | grep -q . || systemctl status ${serviceName} >/dev/null 2>&1`;
}

async function runRuntimeServiceCommand(node, action, buildCommand) {
    const candidates = resolveNodeServiceCandidates(node);
    if (candidates.length === 0) {
        return { success: true, attempted: false, reason: 'virtual node' };
    }

    if (!hasSshCredentials(node)) {
        return { success: false, attempted: false, reason: 'SSH credentials not configured' };
    }

    let conn;
    const failures = [];
    try {
        conn = await connectSSH(node);

        for (const service of candidates) {
            const command = buildCommand(service);
            const result = await execSSH(conn, command);
            const output = (result.output || '').trim();
            const missing = result.code === 3 || output.includes(`SERVICE_MISSING ${service}`);

            if (missing && candidates.length > 1) {
                failures.push({ service, output, error: 'Service not found' });
                continue;
            }

            if (result.success) {
                return { success: true, attempted: true, action, service, output };
            }

            failures.push({
                service,
                output,
                error: result.error || `${action} failed`,
            });
        }
    } catch (error) {
        failures.push({ error: error.message });
    } finally {
        if (conn) conn.end();
    }

    const last = failures[failures.length - 1] || {};
    return {
        success: false,
        attempted: true,
        action,
        service: last.service || candidates[candidates.length - 1],
        output: last.output || '',
        error: last.error || `${action} failed`,
        failures,
    };
}

async function stopNodeRuntime(node) {
    return runRuntimeServiceCommand(node, 'stop', service => `
${serviceExistsCommand(service)} || { echo "SERVICE_MISSING ${service}"; exit 3; }
systemctl stop ${service} 2>&1 || true
systemctl disable ${service} 2>&1 || true
sleep 1
STATE="$(systemctl is-active ${service} 2>/dev/null || true)"
echo "STATE:$STATE"
[ "$STATE" != "active" ]
`);
}

async function startNodeRuntime(node) {
    return runRuntimeServiceCommand(node, 'start', service => `
${serviceExistsCommand(service)} || { echo "SERVICE_MISSING ${service}"; exit 3; }
systemctl daemon-reload 2>&1 || true
systemctl enable ${service} 2>&1
systemctl restart ${service} 2>&1
sleep 2
STATE="$(systemctl is-active ${service} 2>/dev/null || true)"
echo "STATE:$STATE"
[ "$STATE" = "active" ]
`);
}

function uploadFile(conn, content, remotePath) {
    return new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) return reject(err);
            
            const writeStream = sftp.createWriteStream(remotePath);
            writeStream.on('close', () => resolve());
            writeStream.on('error', (err) => reject(err));
            writeStream.write(content);
            writeStream.end();
        });
    });
}

/**
 * Execute a user-defined init script on the remote node via SSH.
 * Non-fatal: failures are logged but do not abort the main setup.
 * Injects NODE_IP, NODE_NAME, NODE_TYPE, NODE_DOMAIN as env variables.
 *
 * @param {Object} conn - Active SSH connection
 * @param {Object} node - Node document
 * @param {Function} log - Logging function from the parent setup context
 * @param {Array} logs - Log accumulator from the parent setup context
 */
async function runInitScript(conn, node, log, logs) {
    const script = (node.initScript || '').trim();
    if (!script) return;

    log('=== Running user init script ===');

    // Single-quote escaping for bash: replace ' with '\'' (end quote, escaped quote, start quote)
    const sq = (v) => "'" + String(v || '').replace(/'/g, "'\\''") + "'";

    const envPrefix = [
        `export NODE_IP=${sq(node.ip)}`,
        `export NODE_NAME=${sq(node.name)}`,
        `export NODE_TYPE=${sq(node.type || 'hysteria')}`,
        `export NODE_DOMAIN=${sq(node.domain)}`,
    ].join('\n');

    const wrappedScript = `#!/bin/bash\nset +e\n${envPrefix}\n\n${script}`;

    try {
        const result = await execSSH(conn, wrappedScript);
        if (result.output) logs.push(result.output);

        if (result.success) {
            log('Init script completed successfully');
        } else {
            log(`Init script exited with code ${result.code} (non-fatal, continuing setup)`);
        }
    } catch (err) {
        log(`Init script error: ${err.message} (non-fatal, continuing setup)`);
    }
}

async function setupNode(node, options = {}) {
    const { installHysteria = true, setupPortHopping = true, restartService = true } = options;
    
    const logs = [];
    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}`;
        logs.push(line);
        logger.info(`[NodeSetup] ${msg}`);
    };
    
    log(`Starting setup for ${node.name} (${node.ip})`);
    
    // Get settings for auth insecure option
    const settings = await Settings.get();
    const authInsecure = settings?.nodeAuth?.insecure ?? true;
    
    const authUrl = `${config.BASE_URL}/api/auth`;
    log(`Auth URL: ${authUrl} (insecure: ${authInsecure})`);
    
    let conn;
    
    try {
        log('Connecting via SSH...');
        conn = await connectSSH(node);
        log('SSH connected');

        await runInitScript(conn, node, log, logs);
        
        if (installHysteria) {
            log('Running system diagnostics and installing Hysteria...');
            const installResult = await execSSH(conn, INSTALL_SCRIPT);
            logs.push(installResult.output);
            
            if (!installResult.success) {
                log(`ERROR: Installation script failed (exit code: ${installResult.code})`);
                log('Last output lines:');
                const lastLines = (installResult.output || '').split('\n').slice(-10).join('\n');
                log(lastLines);
                throw new Error(`Hysteria installation failed (exit code ${installResult.code}): ${installResult.error}`);
            }
            log('System diagnostics passed, Hysteria installed');
        }
        
        // Determine TLS mode: same-VPS (copy panel certs), ACME, or self-signed
        // Use improved detection: checks domain match, localhost, and PANEL_IP env
        const isSameVpsSetup = isSameVpsAsPanel(node);
        let useTlsFiles = false;
        
        if (isSameVpsSetup) {
            // Same server as panel - try to copy panel's certificates
            log(`Same-VPS setup detected (node IP: ${node.ip}, panel domain: ${config.PANEL_DOMAIN})`);
            log('Attempting to copy panel certificates to node...');
            
            const panelCerts = getPanelCertificates(config.PANEL_DOMAIN);
            
            if (panelCerts) {
                // Upload certificates to node
                await uploadFile(conn, panelCerts.cert, '/etc/hysteria/cert.pem');
                await uploadFile(conn, panelCerts.key, '/etc/hysteria/key.pem');
                
                // Set correct permissions
                await execSSH(conn, `
chmod 644 /etc/hysteria/cert.pem
chmod 600 /etc/hysteria/key.pem
if id "hysteria" &>/dev/null; then
    chown hysteria:hysteria /etc/hysteria/cert.pem /etc/hysteria/key.pem
fi
echo "Done: Panel certificates copied to node"
ls -la /etc/hysteria/*.pem
                `);
                
                log('Panel certificates copied successfully');
                useTlsFiles = true;
            } else {
                log('Warning: Could not read panel certificates, falling back to self-signed');
                const certResult = await execSSH(conn, SELF_SIGNED_CERT_SCRIPT);
                logs.push(certResult.output);
                useTlsFiles = true;
            }
            
        } else if (!node.domain) {
            // No domain and not same VPS - use self-signed certificate
            log('No domain specified, generating self-signed certificate...');
            const certResult = await execSSH(conn, SELF_SIGNED_CERT_SCRIPT);
            logs.push(certResult.output);
            
            if (!certResult.success) {
                throw new Error(`Certificate generation failed: ${certResult.error}`);
            }
            log('Certificate ready (self-signed)');
            useTlsFiles = true;
            
        } else {
            // Different domain on different VPS - use ACME
            log(`Domain detected (${node.domain}), ACME will be used`);
            log('⚠️  WARNING: If this node is on the same VPS as the panel, ACME may fail!');
            log('⚠️  Port 80 is used by the panel for its own ACME challenges.');
            log('⚠️  Consider using the panel domain or no domain (self-signed) for same-VPS setup.');
            log('Opening port 80 for ACME HTTP-01 challenge...');
            
            const acmeSetup = await execSSH(conn, `
echo "=== Setting up for ACME ==="

mkdir -p /etc/hysteria/acme
chmod 777 /etc/hysteria/acme
chmod 755 /etc/hysteria
echo "Done: ACME directory created with correct permissions"

ls -la /etc/hysteria/

if command -v iptables &> /dev/null; then
    iptables -I INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p udp --dport 80 -j ACCEPT 2>/dev/null || true
    echo "Done: Port 80 opened in iptables"
fi

if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
    ufw allow 80/tcp 2>/dev/null || true
    ufw allow 80/udp 2>/dev/null || true
    echo "Done: Port 80 opened in ufw"
fi

${IPTABLES_SAVE_SNIPPET}

if ss -tlnp | grep -q ':80 '; then
    echo "⚠️  Warning: Port 80 is already in use (likely by the panel):"
    ss -tlnp | grep ':80 '
    echo "ACME challenge will likely fail if panel is on the same server!"
else
    echo "Done: Port 80 is free"
fi

echo "Done: ACME preparation complete"
echo "Note: Make sure DNS for ${node.domain} points to this server's IP!"
            `);
            logs.push(acmeSetup.output);
            log('ACME preparation done');
        }
        
        log('Uploading config...');
        const hysteriaConfig = configGenerator.generateNodeConfig(node, authUrl, { authInsecure, useTlsFiles });
        await uploadFile(conn, hysteriaConfig, '/etc/hysteria/config.yaml');
        log('Config uploaded to /etc/hysteria/config.yaml');
        logs.push('--- Config content ---');
        logs.push(hysteriaConfig);
        logs.push('--- End config ---');
        
        if (setupPortHopping && node.portRange) {
            if (isSameVpsAsPanel(node)) {
                log('Skipping port hopping for self-hosted node (incompatible with Docker networking)');
            } else {
                log(`Setting up port hopping (${node.portRange})...`);
                const portHoppingScript = getPortHoppingScript(node.portRange, node.port || 443);
                if (portHoppingScript) {
                    const hopResult = await execSSH(conn, portHoppingScript);
                    logs.push(hopResult.output);

                    if (!hopResult.success) {
                        log(`Port hopping setup warning: ${hopResult.error}`);
                    } else {
                        log('Port hopping configured');
                    }
                }
            }
        }
        
        const statsPort = node.statsPort || 9999;
        const mainPort = node.port || 443;
        log(`Opening firewall ports (${mainPort}, ${statsPort})...`);
        const firewallResult = await execSSH(conn, `
echo "=== [5/6] Opening firewall ports ==="

if command -v iptables &> /dev/null; then
    iptables -I INPUT -p tcp --dport ${mainPort} -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p udp --dport ${mainPort} -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p tcp --dport ${statsPort} -j ACCEPT 2>/dev/null || true
    echo "Done: Ports ${mainPort}, ${statsPort} opened in iptables"
fi

if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
    ufw allow ${mainPort}/tcp 2>/dev/null || true
    ufw allow ${mainPort}/udp 2>/dev/null || true
    ufw allow ${statsPort}/tcp 2>/dev/null || true
    echo "Done: Ports ${mainPort}, ${statsPort} opened in ufw"
fi

${IPTABLES_SAVE_SNIPPET}

echo "Done: Firewall configured"
        `);
        logs.push(firewallResult.output);
        log('Firewall ports opened');
        
        if (restartService) {
            log('Restarting Hysteria service...');
            const restartResult = await execSSH(conn, `
echo "=== [6/6] Restarting Hysteria service ==="
systemctl enable hysteria-server 2>/dev/null || true
systemctl restart hysteria-server
sleep 3
echo "Service status:"
systemctl status hysteria-server --no-pager -l || true
echo ""
echo "Journal logs (last 20 lines):"
journalctl -u hysteria-server -n 20 --no-pager || true
            `);
            logs.push(restartResult.output);
            
            if (!restartResult.success) {
                log(`Service restart warning: ${restartResult.error}`);
            } else {
                log('Service restarted');
            }
        }
        
        log('Setup completed successfully!');

        if (node.initScript) {
            await Settings.update({ lastInitScript: node.initScript }).catch(() => {});
        }

        return { success: true, logs, useTlsFiles };
        
    } catch (error) {
        log(`Error: ${error.message}`);
        return { success: false, error: error.message, logs, useTlsFiles: false };
        
    } finally {
        if (conn) {
            conn.end();
        }
    }
}

async function checkNodeStatus(node) {
    try {
        const conn = await connectSSH(node);
        
        try {
            const result = await execSSH(conn, 'systemctl is-active hysteria-server');
            return result.output.trim() === 'active' ? 'online' : 'offline';
        } finally {
            conn.end();
        }
    } catch (error) {
        return 'error';
    }
}

async function getNodeLogs(node, lines = 50) {
    try {
        const conn = await connectSSH(node);
        
        try {
            const result = await execSSH(conn, `journalctl -u hysteria-server -n ${lines} --no-pager`);
            return { success: true, logs: result.output };
        } finally {
            conn.end();
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ==================== XRAY SETUP ====================

const XRAY_INSTALL_SCRIPT = `#!/bin/bash

echo "=== [1/4] Installing Xray-core ==="
echo "Checking system..."
echo "OS: $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'"' -f2 || uname -a)"
echo "Arch: $(uname -m)"

# Check if curl is available
if ! command -v curl &> /dev/null; then
    echo "curl not found, installing..."
    apt-get update && apt-get install -y curl || yum install -y curl || apk add curl
fi

if ! command -v xray &> /dev/null; then
    echo "Xray not found. Installing via official script..."
    curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh -o /tmp/xray-install.sh
    chmod +x /tmp/xray-install.sh
    bash /tmp/xray-install.sh install 2>&1
    INSTALL_EXIT=$?
    rm -f /tmp/xray-install.sh
    if [ $INSTALL_EXIT -ne 0 ]; then
        echo "ERROR: Xray installation script exited with code $INSTALL_EXIT"
        exit 1
    fi
    # Verify installation
    if ! command -v xray &> /dev/null; then
        echo "ERROR: xray command not found after installation"
        exit 1
    fi
    echo "Done: Xray installed ($(xray version | head -1))"
else
    echo "Done: Xray already installed ($(xray version | head -1))"
fi

mkdir -p /usr/local/etc/xray
echo "Done: Directory /usr/local/etc/xray ready"
`;

// ACME (acme.sh) setup for tlsSource='acme': issue LE cert for `domain` via
// HTTP-01 standalone, install to /usr/local/etc/xray/{cert,key}.pem, register
// acme.sh cron for autonomous renewal. Inputs sanitized at the call-site.
function buildAcmeSetupScript({ domain, email, nodeIp }) {
    const safe = (raw, allowed, max) => String(raw || '').replace(allowed, '').slice(0, max);
    const d = safe(domain, /[^A-Za-z0-9.\-]/g, 253);
    const e = safe(email, /[^A-Za-z0-9.\-_+@]/g, 254);
    const ip = safe(nodeIp, /[^A-Za-z0-9.:]/g, 45);
    if (!d) throw new Error('buildAcmeSetupScript: domain is required');
    if (!e) throw new Error('buildAcmeSetupScript: email is required');

    return `#!/bin/bash
set -e
DOMAIN="${d}"
EMAIL="${e}"
NODE_IP="${ip}"
CERT_PATH=/usr/local/etc/xray/cert.pem
KEY_PATH=/usr/local/etc/xray/key.pem

echo "=== ACME setup for \${DOMAIN} ==="

# Pre-flight 1: domain must resolve (warn on mismatch, fail on no resolution).
RESOLVED=$(getent hosts "\${DOMAIN}" 2>/dev/null | awk '{print $1; exit}' || true)
if [ -z "\${RESOLVED}" ]; then
    echo "ERROR: DNS resolution failed for \${DOMAIN}. Set an A record pointing to \${NODE_IP} before retrying."
    exit 11
fi
if [ "\${RESOLVED}" != "\${NODE_IP}" ] && [ -n "\${NODE_IP}" ]; then
    echo "WARN: \${DOMAIN} resolves to \${RESOLVED}, expected \${NODE_IP}. Continuing — anycast/CDN may legitimately differ."
fi

# Pre-flight 2: port 80 must be free for HTTP-01 standalone.
if ss -tlnH 'sport = :80' 2>/dev/null | grep -q LISTEN; then
    echo "ERROR: Port 80 is busy on the node. Stop the listener (nginx/apache/caddy/etc.) and retry."
    ss -tlnp 'sport = :80' 2>/dev/null || true
    exit 12
fi

if [ ! -f "\${HOME}/.acme.sh/acme.sh" ]; then
    echo "Installing acme.sh..."
    if ! command -v curl &> /dev/null; then
        apt-get update && apt-get install -y curl || yum install -y curl || apk add --no-cache curl
    fi
    curl -fsSL https://get.acme.sh | sh -s email="\${EMAIL}" >/dev/null 2>&1 || {
        echo "ERROR: acme.sh installer failed."
        exit 13
    }
fi
ACME="\${HOME}/.acme.sh/acme.sh"

# Pin CA to LE (acme.sh default has flipped between ZeroSSL and LE).
"\${ACME}" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true

# Skip --issue if cert already present; renewals run via acme.sh cron.
CERT_FILE="\${HOME}/.acme.sh/\${DOMAIN}_ecc/\${DOMAIN}.cer"
if [ ! -f "\${CERT_FILE}" ]; then
    echo "Issuing LE cert for \${DOMAIN} via HTTP-01 standalone..."
    "\${ACME}" --issue --standalone --server letsencrypt -d "\${DOMAIN}" --keylength ec-256
else
    echo "Existing cert present for \${DOMAIN}; skipping --issue (renewals run via acme.sh cron)."
fi

mkdir -p /usr/local/etc/xray

# Xray runs as User=nobody; acme.sh writes as root → chown is required for the
# unprivileged service to read the key. Re-applied via --reloadcmd on renewal.
# 'nobody' primary group differs by distro (nogroup on Debian/Ubuntu).
NOBODY_GROUP="\$(id -gn nobody 2>/dev/null || echo nobody)"
RELOAD_CMD="chown 'nobody:\${NOBODY_GROUP}' '\${KEY_PATH}' '\${CERT_PATH}' 2>/dev/null || true; chmod 644 '\${CERT_PATH}' 2>/dev/null || true; chmod 600 '\${KEY_PATH}' 2>/dev/null || true; systemctl reload xray 2>/dev/null || systemctl restart xray 2>/dev/null || true"

"\${ACME}" --install-cert -d "\${DOMAIN}" --ecc \\
    --key-file       "\${KEY_PATH}" \\
    --fullchain-file "\${CERT_PATH}" \\
    --reloadcmd "\${RELOAD_CMD}"

chown "nobody:\${NOBODY_GROUP}" "\${KEY_PATH}" "\${CERT_PATH}" 2>/dev/null || true
chmod 644 "\${CERT_PATH}" 2>/dev/null || true
chmod 600 "\${KEY_PATH}"  2>/dev/null || true

if crontab -l 2>/dev/null | grep -q '\\.acme\\.sh/acme\\.sh.*--cron'; then
    echo "Done: cert installed; acme.sh cron is active."
else
    echo "WARN: acme.sh cron entry missing — auto-renewal may not run. Re-run 'acme.sh --install-cronjob' on the node."
fi

echo "ACME setup completed for \${DOMAIN}"
`;
}

/**
 * Setup Xray node via SSH:
 * 1. Install xray-core
 * 2. Generate x25519 Reality keys (if security=reality and no keys yet)
 * 3. Upload config.json
 * 4. Open firewall ports
 * 5. Enable and restart xray service
 *
 * @param {Object} node - Node document
 * @param {Object} options - { restartService }
 * @returns {{ success, logs, realityKeys? }}
 */
async function setupXrayNode(node, options = {}) {
    const { restartService = true, exitOnly = false } = options;

    const logs = [];
    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}`;
        logs.push(line);
        logger.info(`[XraySetup] ${msg}`);
    };

    log(`Starting Xray setup for ${node.name} (${node.ip})${exitOnly ? ' [exit/bridge mode]' : ''}`);

    if (!exitOnly) {
        // Detect port conflict: Xray on the same VPS as the panel (Caddy) using port 443/80
        const sameVps = isSameVpsAsPanel(node);
        const nodePort = node.port || 443;
        if (sameVps && (nodePort === 443 || nodePort === 80)) {
            const msg = `Port conflict detected: Xray port ${nodePort} is already used by the panel (Caddy) on this server. ` +
                `Use a different port (e.g. 8443) for the Xray node. ` +
                `After changing the port, save the node and run Auto Setup again.`;
            log(`ERROR: ${msg}`);
            return { success: false, error: msg, logs, realityKeys: null };
        }

        // ACME on same-VPS is incompatible (port 80 held by panel Caddy).
        const xrayCfgEarly = node?.xray || {};
        if (sameVps && xrayCfgEarly.security === 'tls' && xrayCfgEarly.tlsSource === 'acme') {
            const msg = `tlsSource='acme' is incompatible with same-VPS deployment: ` +
                `port 80 is held by the panel's Caddy and cannot be used for HTTP-01. ` +
                `Switch the node to tlsSource='panel' (panel's LE cert is reused) or move the node to a separate VPS.`;
            log(`ERROR: ${msg}`);
            return { success: false, error: msg, logs, realityKeys: null };
        }

        if (sameVps) {
            log(`Same-VPS setup detected (node port: ${nodePort}, panel domain: ${config.PANEL_DOMAIN})`);
        }
    }

    let conn;
    let generatedKeys = null;

    try {
        log('Connecting via SSH...');
        conn = await connectSSH(node);
        log('SSH connected');

        await runInitScript(conn, node, log, logs);

        // Install Xray
        log('Installing Xray-core...');
        const installResult = await execSSH(conn, XRAY_INSTALL_SCRIPT);
        logs.push(installResult.output);
        if (!installResult.success) {
            throw new Error(`Xray installation failed: ${installResult.error}`);
        }
        log('Xray-core installed');

        // Exit (Bridge) nodes: skip config, Reality keys, firewall, and service start.
        // Their actual config is deployed via cascade links.
        if (exitOnly) {
            log('Exit node setup completed (Xray binary only). Deploy a cascade link to configure.');
            if (conn) conn.end();
            return { success: true, logs, realityKeys: null };
        }

        // Generate Reality keys and shortId if needed
        const xrayCfg = node.xray || {};
        if (xrayCfg.security === 'reality') {
            const updates = {};
            let needsUpdate = false;

            // Generate x25519 keys if not set (locally, no dependency on xray binary)
            if (!xrayCfg.realityPrivateKey) {
                log('Generating x25519 Reality keys...');
                generatedKeys = cryptoService.generateX25519KeysLocal();
                log(`Reality keys generated. PublicKey: ${generatedKeys.publicKey}`);
                updates['xray.realityPrivateKey'] = generatedKeys.privateKey;
                updates['xray.realityPublicKey'] = generatedKeys.publicKey;
                node.xray = { ...node.xray, realityPrivateKey: generatedKeys.privateKey, realityPublicKey: generatedKeys.publicKey };
                needsUpdate = true;
            }

            // Generate shortId if not set or only contains empty string
            const currentShortIds = xrayCfg.realityShortIds || [''];
            const hasRealShortId = currentShortIds.some(id => id && id.length > 0);
            if (!hasRealShortId) {
                const shortId = require('crypto').randomBytes(8).toString('hex'); // 16 hex chars
                log(`Generated shortId: ${shortId}`);
                updates['xray.realityShortIds'] = ['', shortId]; // empty + random
                node.xray = { ...node.xray, realityShortIds: ['', shortId] };
                needsUpdate = true;
            }

            // Save to DB
            if (needsUpdate) {
                const HyNode = require('../models/hyNodeModel');
                await HyNode.updateOne({ _id: node._id }, { $set: updates });
                log('Reality settings saved to database');
            }
        }

        // Generate and upload config
        log('Generating Xray config...');
        const configGenerator = require('./configGenerator');
        const syncService = require('./syncService');
        // Lazy-load manualKey for nodes using tlsSource==='manual' since the
        // private key is select:false at the schema layer.
        if (typeof syncService.ensureManualKeyLoaded === 'function') {
            await syncService.ensureManualKeyLoaded(node);
        }
        const users = await syncService._getUsersForNode(node);
        let configContent;
        try {
            configContent = configGenerator.generateXrayConfig(node, users);
        } catch (genErr) {
            if (genErr.code === 'PANEL_CERT_UNAVAILABLE' || genErr.code === 'MANUAL_CERT_UNAVAILABLE') {
                const human = genErr.code === 'PANEL_CERT_UNAVAILABLE'
                    ? `Panel certificate is not available on disk yet — issue/renew the panel cert (${config.PANEL_DOMAIN || '<PANEL_DOMAIN unset>'}) and re-run install.`
                    : 'Manual TLS PEM is missing — paste both certificate and private key in the node form before installing.';
                throw new Error(human);
            }
            throw genErr;
        }
        const configPath = '/usr/local/etc/xray/config.json';

        await uploadFile(conn, configContent, configPath);
        log(`Config uploaded to ${configPath} (${users.length} users)`);
        logs.push('--- Config preview ---');
        logs.push(configContent.substring(0, 500) + (configContent.length > 500 ? '\n...' : ''));
        logs.push('--- End config preview ---');

        // Self-signed TLS: openssl is only invoked when explicitly requested.
        // For tlsSource=panel/manual the certificate is inlined into config.json
        // by configGenerator and never written to disk on the remote node.
        if (xrayCfg.security === 'tls' && xrayCfg.tlsSource === 'self-signed') {
            log('Generating self-signed TLS certificate (testing only)...');
            // Strip shell metacharacters from CN (node.sni is admin-only but
            // not strictly validated) and cap at the X.509 64-char CN limit.
            const rawCn = String(node.domain || node.sni || node.ip || 'xray');
            const cn = (rawCn.replace(/[^A-Za-z0-9.\-:]/g, '').slice(0, 64)) || 'xray';
            const certResult = await execSSH(conn, `
mkdir -p /usr/local/etc/xray
if [ ! -f /usr/local/etc/xray/cert.pem ] || [ ! -s /usr/local/etc/xray/cert.pem ] \\
   || [ ! -f /usr/local/etc/xray/key.pem ] || [ ! -s /usr/local/etc/xray/key.pem ]; then
    if openssl ecparam -name prime256v1 -genkey -noout -out /usr/local/etc/xray/key.pem 2>/dev/null; then
        openssl req -x509 -new -key /usr/local/etc/xray/key.pem \\
            -out /usr/local/etc/xray/cert.pem \\
            -subj "/CN=${cn}" -days 36500 2>&1 || true
    fi
    if [ ! -s /usr/local/etc/xray/cert.pem ]; then
        # Fallback to RSA for ancient OpenSSL builds without prime256v1
        openssl req -x509 -nodes -newkey rsa:2048 \\
            -keyout /usr/local/etc/xray/key.pem \\
            -out /usr/local/etc/xray/cert.pem \\
            -subj "/CN=${cn}" -days 36500 2>&1 || true
    fi
    chmod 600 /usr/local/etc/xray/key.pem
    chmod 644 /usr/local/etc/xray/cert.pem
    echo "OK: Self-signed certificate generated for CN=${cn}"
else
    echo "Skipped: certificate already exists"
fi
`);
            logs.push(certResult.output);
            if (!certResult.success) {
                log(`Self-signed cert generation warning: ${certResult.error}`);
            }
        } else if (xrayCfg.security === 'tls' && xrayCfg.tlsSource === 'acme') {
            const domain = String(node.domain || '').trim();
            const email = (String(xrayCfg.acmeEmail || '').trim()) ||
                          (String(config.ACME_EMAIL || '').trim());
            if (!domain) {
                throw new Error('tlsSource=acme requires node.domain to be set in the Network section.');
            }
            if (!email) {
                throw new Error('tlsSource=acme requires acmeEmail (or the panel-wide ACME_EMAIL env var).');
            }
            log(`TLS source: acme — installing acme.sh and issuing LE cert for ${domain}...`);
            const acmeScript = buildAcmeSetupScript({ domain, email, nodeIp: node.ip });
            const acmeResult = await execSSH(conn, acmeScript);
            logs.push(acmeResult.output);
            if (!acmeResult.success) {
                throw new Error(`ACME setup failed: ${acmeResult.error || 'see logs above'}`);
            }
            log('ACME cert installed and auto-renewal cron registered on the node.');
        } else if (xrayCfg.security === 'tls') {
            log(`TLS source: ${xrayCfg.tlsSource || 'panel'} — certificate inlined in config.json (no on-node openssl)`);
        }

        // Collect externally bound client-facing ports. Loopback listeners and
        // apiPort do not need host firewall rules.
        const mainPort = node.port || 443;
        const apiPort = (node.xray || {}).apiPort || 61000;
        const xrayConfig = node.xray || {};
        const externalPorts = [];
        if (!isLoopbackAddress(xrayConfig.listen || '0.0.0.0')) {
            externalPorts.push(mainPort);
        }
        for (const inbound of (xrayConfig.extraInbounds || [])) {
            const port = parseInt(inbound.port, 10);
            if (Number.isInteger(port) && port > 0 && port < 65536
                && !isLoopbackAddress(inbound.listen || '0.0.0.0')) {
                externalPorts.push(port);
            }
        }
        const allPorts = [...new Set(externalPorts)];

        log(`Opening external firewall ports (${allPorts.join(', ') || 'none'}, api:${apiPort} local)...`);
        const portRules = allPorts.map(p => `
    iptables -I INPUT -p tcp --dport ${p} -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p udp --dport ${p} -j ACCEPT 2>/dev/null || true`).join('');
        const ufwRules = allPorts.map(p => `
    ufw allow ${p}/tcp 2>/dev/null || true
    ufw allow ${p}/udp 2>/dev/null || true`).join('');

        const firewallResult = await execSSH(conn, `
echo "=== Opening firewall ports ==="
if command -v iptables &> /dev/null; then${portRules}
    echo "Done: iptables rules added"
fi
if command -v ufw &> /dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then${ufwRules}
    echo "Done: UFW rules added"
fi
${IPTABLES_SAVE_SNIPPET}
echo "Done: Firewall configured"
        `);
        logs.push(firewallResult.output);
        log('Firewall configured');

        if (restartService) {
            log('Installing systemd service and starting Xray...');
            const serviceContent = configGenerator.generateXraySystemdService();
            await uploadFile(conn, serviceContent, '/etc/systemd/system/xray.service');
            const restartResult = await execSSH(conn, `
echo "=== Starting Xray service ==="
systemctl daemon-reload
systemctl enable xray
systemctl restart xray
sleep 2
echo "Service status:"
systemctl status xray --no-pager -l || true
echo ""
echo "Journal (last 15 lines):"
journalctl -u xray -n 15 --no-pager || true
            `);
            logs.push(restartResult.output);
            if (!restartResult.success) {
                log(`Service restart warning: ${restartResult.error}`);
            } else {
                log('Xray service started');
            }
        }

        log('Xray setup completed successfully!');

        if (node.initScript) {
            await Settings.update({ lastInitScript: node.initScript }).catch(() => {});
        }

        return { success: true, logs, realityKeys: generatedKeys };

    } catch (error) {
        log(`Error: ${error.message}`);
        return { success: false, error: error.message, logs, realityKeys: generatedKeys };

    } finally {
        if (conn) conn.end();
    }
}

/**
 * Check Xray service status via SSH
 */
async function checkXrayNodeStatus(node) {
    try {
        const conn = await connectSSH(node);
        try {
            const result = await execSSH(conn, 'systemctl is-active xray');
            return result.output.trim() === 'active' ? 'online' : 'offline';
        } finally {
            conn.end();
        }
    } catch (error) {
        return 'error';
    }
}

/**
 * Get Xray node logs via SSH
 */
async function getXrayNodeLogs(node, lines = 50) {
    try {
        const conn = await connectSSH(node);
        try {
            const result = await execSSH(conn, `journalctl -u xray -n ${lines} --no-pager`);
            return { success: true, logs: result.output };
        } finally {
            conn.end();
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ==================== CC AGENT SETUP ====================

/**
 * Generate a secure random token for the CC Agent
 */
function generateAgentToken() {
    return require('crypto').randomBytes(32).toString('hex');
}

/**
 * Ensure the Xray node has a persisted agent token in MongoDB.
 * MongoDB remains the source of truth; the installer only consumes the saved token.
 *
 * @param {Object} node - Node document
 * @returns {{ node: Object, token: string, created: boolean }}
 */
async function ensureXrayAgentToken(node) {
    if (node.type !== 'xray') {
        throw new Error(`Node ${node.name} is not an Xray node`);
    }

    const existingToken = (node.xray || {}).agentToken;
    if (existingToken) {
        return { node, token: existingToken, created: false };
    }

    const HyNode = require('../models/hyNodeModel');
    const generatedToken = generateAgentToken();

    const updatedNode = await HyNode.findOneAndUpdate(
        {
            _id: node._id,
            $or: [
                { 'xray.agentToken': { $exists: false } },
                { 'xray.agentToken': '' },
            ],
        },
        { $set: { 'xray.agentToken': generatedToken } },
        { new: true }
    );

    const freshNode = updatedNode || await HyNode.findById(node._id);
    const token = freshNode?.xray?.agentToken || '';

    if (!token) {
        throw new Error(`Could not persist agent token for node ${node.name}`);
    }

    return {
        node: freshNode,
        token,
        created: !!updatedNode,
    };
}

/**
 * Install and configure cc-agent on an Xray node via SSH.
 *
 * Flow:
 *  1. Download binary from GitHub releases (or fallback URL)
 *  2. Write /etc/cc-agent/config.json with token + TLS settings
 *  3. If TLS: generate self-signed cert with openssl
 *  4. Open port in firewall for the panel source or local Docker networks
 *  5. Install & start cc-agent.service
 *
 * @param {Object} conn  - Active ssh2 connection
 * @param {Object} node  - Node document
 * @param {string} token - Pre-generated agent token
 * @param {string} panelSource - Panel firewall source (IP/host hint for remote nodes)
 * @param {boolean} sameVps - Whether the node is on the same VPS as the panel
 * @param {Function} log - Logging callback
 * @returns {{ success, agentVersion }}
 */
async function installCCAgent(conn, node, token, panelSource, sameVps, log) {
    const agentPort = (node.xray || {}).agentPort || 62080;
    const useTls = (node.xray || {}).agentTls !== false;
    const apiPort = (node.xray || {}).apiPort || 61000;

    const agentConfig = buildAgentConfig(node, token, agentPort, apiPort, useTls);
    const configJson = JSON.stringify(agentConfig, null, 2);

    // Build firewall rules based on setup type
    let firewallRules = '';
    if (sameVps) {
        firewallRules = `
echo "Same-VPS setup: allowing loopback and Docker networks"
if command -v iptables &> /dev/null; then
    iptables -I INPUT -p tcp -s 127.0.0.1/32 --dport ${agentPort} -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p tcp -s 172.16.0.0/12 --dport ${agentPort} -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p tcp -s 192.168.0.0/16 --dport ${agentPort} -j ACCEPT 2>/dev/null || true
    echo "Done: iptables rules added"
fi
if command -v ufw &> /dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow from 127.0.0.1 to any port ${agentPort} proto tcp 2>/dev/null || true
    ufw allow from 172.16.0.0/12 to any port ${agentPort} proto tcp 2>/dev/null || true
    ufw allow from 192.168.0.0/16 to any port ${agentPort} proto tcp 2>/dev/null || true
    echo "Done: ufw rules added"
fi`;
    } else if (panelSource) {
        firewallRules = `
echo "Remote setup: allowing panel source ${panelSource}"
if command -v iptables &> /dev/null; then
    iptables -I INPUT -p tcp -s ${panelSource} --dport ${agentPort} -j ACCEPT 2>/dev/null || true
    echo "Done: iptables rule added"
fi
if command -v ufw &> /dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow from ${panelSource} to any port ${agentPort} proto tcp 2>/dev/null || true
    echo "Done: ufw rule added"
fi`;
    } else {
        firewallRules = 'echo "WARNING: Panel source unknown, skipping firewall rules"';
    }

    // Persist iptables rules across reboots
    if (firewallRules && !firewallRules.includes('WARNING')) {
        firewallRules += '\n' + IPTABLES_SAVE_SNIPPET;
    }

    // Step 1: Download binary
    log('Downloading cc-agent binary...');
    const downloadResult = await execSSH(conn, `
rm -f /usr/local/bin/cc-agent
ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    BIN="cc-agent-linux-arm64"
else
    BIN="cc-agent-linux-amd64"
fi
URL="https://github.com/ClickDevTech/CELERITY-panel/releases/latest/download/$BIN"
echo "Downloading $URL ..."
curl -fsSL --max-time 120 "$URL" -o /usr/local/bin/cc-agent
if [ ! -s /usr/local/bin/cc-agent ]; then
    echo "ERROR: Download failed or file is empty"
    exit 1
fi
chmod +x /usr/local/bin/cc-agent
echo "OK: cc-agent binary ready"
ls -la /usr/local/bin/cc-agent
`);

    if (!downloadResult.success) {
        log(`Binary download failed: ${downloadResult.output}`);
        return { success: false, agentVersion: '', output: downloadResult.output };
    }
    log('Binary downloaded');

    // Step 2: Write config
    log('Writing agent config...');
    await execSSH(conn, 'mkdir -p /etc/cc-agent /var/lib/cc-agent');
    await uploadFile(conn, configJson, '/etc/cc-agent/config.json');
    await execSSH(conn, 'chmod 600 /etc/cc-agent/config.json');
    log('Config written');

    // Step 3: Generate TLS cert if needed
    if (useTls) {
        log('Generating TLS certificate...');
        await execSSH(conn, `
openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout /etc/cc-agent/key.pem \
    -out /etc/cc-agent/cert.pem \
    -subj "/CN=cc-agent" -days 36500 2>&1
chmod 600 /etc/cc-agent/key.pem /etc/cc-agent/cert.pem
echo "OK: TLS cert generated"
`);
        log('TLS certificate ready');
    }

    // Step 4: Install systemd service
    log('Installing systemd service...');
    const serviceUnit = `[Unit]
Description=CC Xray Agent
After=network.target xray.service

[Service]
Type=simple
ExecStart=/usr/local/bin/cc-agent
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
    await uploadFile(conn, serviceUnit, '/etc/systemd/system/cc-agent.service');
    log('Service unit installed');

    // Step 5: Firewall + start service
    log('Configuring firewall and starting service...');
    const startResult = await execSSH(conn, `
${firewallRules}
systemctl daemon-reload
systemctl enable cc-agent
systemctl restart cc-agent
sleep 2
if systemctl is-active cc-agent > /dev/null 2>&1; then
    echo "OK: cc-agent running"
    /usr/local/bin/cc-agent -version 2>/dev/null || true
else
    echo "ERROR: cc-agent failed to start"
    journalctl -u cc-agent -n 10 --no-pager 2>/dev/null || true
fi
`);

    const allOutput = [downloadResult.output, startResult.output].join('\n');
    const agentVersion = allOutput.match(/cc-agent[:\s]+(v[\d.]+)/)?.[1] || 'installed';
    const isRunning = startResult.output.includes('OK: cc-agent running');

    return { success: isRunning, agentVersion, output: allOutput };
}

/**
 * Setup Xray node + CC Agent via SSH.
 * Extends setupXrayNode to also install the agent.
 */
async function setupXrayNodeWithAgent(node, options = {}) {
    let preparedNode = node;
    let agentToken = '';

    try {
        const ensured = await ensureXrayAgentToken(node);
        preparedNode = ensured.node;
        agentToken = ensured.token;
    } catch (error) {
        const line = `[${new Date().toISOString()}] Agent token error: ${error.message}`;
        logger.error(`[AgentSetup] ${error.message}`);
        return { success: false, error: error.message, logs: [line] };
    }

    const result = await setupXrayNode(preparedNode, options);

    if (!result.success) {
        return result;
    }

    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}`;
        result.logs.push(line);
        logger.info(`[AgentSetup] ${msg}`);
    };

    let conn;
    try {
        if ((node.xray || {}).agentToken !== agentToken) {
            log('Agent token ensured in database');
        }

        log('Connecting via SSH for agent installation...');
        conn = await connectSSH(preparedNode);

        // Same-VPS setups must allow Docker bridge traffic to reach the host agent.
        const sameVps = isSameVpsAsPanel(preparedNode);
        const panelSourceRaw = process.env.PANEL_IP || config.BASE_URL || '';
        const panelSource = panelSourceRaw.replace(/^https?:\/\//, '').split(':')[0].split('/')[0];
        log(`Agent firewall mode: ${sameVps ? 'same-vps' : 'remote'}`);
        if (!sameVps) {
            log(`Panel source for firewall: ${panelSource || 'not provided'}`);
        }

        log('Installing CC Agent...');
        const agentResult = await installCCAgent(conn, preparedNode, agentToken, panelSource, sameVps, log);
        if (agentResult.output) {
            result.logs.push(agentResult.output);
        }

        if (!agentResult.success) {
            throw new Error('CC Agent installation failed');
        }
        log(`Agent installed: ${agentResult.agentVersion}`);

        const HyNode = require('../models/hyNodeModel');
        const updates = {
            'xray.agentToken': agentToken,
            agentVersion: agentResult.agentVersion,
            agentStatus: 'unknown', // will be updated on first health check
        };
        await HyNode.updateOne({ _id: preparedNode._id }, { $set: updates });
        log('Agent metadata saved to database');

        result.agentToken = agentToken;

    } catch (error) {
        const line = `[${new Date().toISOString()}] Agent install error: ${error.message}`;
        result.logs.push(line);
        logger.error(`[AgentSetup] ${error.message}`);
        return { ...result, success: false, error: error.message };
    } finally {
        if (conn) conn.end();
    }

    return result;
}

/**
 * Compute the XTLS flow value for a given inbound config block.
 * Flow only applies to tcp + reality/tls; for other transports it must be
 * empty, otherwise Xray rejects user additions.
 *
 * @param {Object} inbound - Object with `transport`, `security`, `flow` fields
 * @returns {string} The flow string or '' when flow is not applicable
 */
function computeInboundFlow(inbound) {
    if (!inbound) return '';
    const transport = inbound.transport || 'tcp';
    const security = inbound.security || 'reality';
    if ((security === 'reality' || security === 'tls') && transport === 'tcp') {
        return inbound.flow || 'xtls-rprx-vision';
    }
    return '';
}

/**
 * Build the JSON config object written to /etc/cc-agent/config.json on the
 * remote node. Includes both the legacy `inbound_tag` (for old agents) and
 * the new `inbounds[]` array describing per-tag flow for all VLESS inbounds
 * (main + extras). Old agents read inbound_tag; new agents read inbounds[].
 */
function buildAgentConfig(node, token, agentPort, apiPort, useTls, accessLogs) {
    const xray = node.xray || {};
    const mainTag = xray.inboundTag || 'vless-in';

    const inbounds = [
        { tag: mainTag, flow: computeInboundFlow(xray) },
        ...(Array.isArray(xray.extraInbounds) ? xray.extraInbounds : [])
            .filter(i => i && i.inboundTag)
            .map(i => ({ tag: i.inboundTag, flow: computeInboundFlow(i) })),
    ];

    const cfg = {
        listen: `0.0.0.0:${agentPort}`,
        token: token,
        xray_api: `127.0.0.1:${apiPort}`,
        // Legacy single-tag field kept for backward compatibility with cc-agent
        // versions that do not understand `inbounds`.
        inbound_tag: mainTag,
        inbounds,
        data_dir: '/var/lib/cc-agent',
        tls: {
            enabled: useTls,
            cert: '/etc/cc-agent/cert.pem',
            key: '/etc/cc-agent/key.pem',
        },
    };

    // Opt-in access-log module. Only written when a caller supplies the block;
    // otherwise it stays absent so older agents and the disabled state are
    // untouched (the agent treats an absent block as disabled).
    if (accessLogs && typeof accessLogs === 'object') {
        cfg.access_logs = {
            enabled: !!accessLogs.enabled,
            path: accessLogs.path || '/var/log/xray/access.log',
            ingest_url: accessLogs.ingestUrl || '',
            ingest_token: accessLogs.ingestToken || '',
            insecure_tls: !!accessLogs.insecureTls,
            spool_max_bytes: accessLogs.spoolMaxBytes || (200 * 1024 * 1024),
            batch_max_events: accessLogs.batchMaxEvents || 500,
            flush_interval_seconds: accessLogs.flushIntervalSeconds || 5,
            file_max_bytes: accessLogs.fileMaxBytes || (64 * 1024 * 1024),
        };
    }

    return cfg;
}

/**
 * Refresh /etc/cc-agent/config.json on the remote node to reflect the current
 * set of Xray inbounds (main + extras), then restart the agent so it picks
 * up the new tag→flow mapping. Safe to call on every config sync — the
 * payload is idempotent.
 *
 * Uses sftp uploadFile (no shell-substitution of user input) and a fixed
 * `systemctl restart cc-agent` command — no injection surface.
 *
 * @param {Object} node - Node document with xray.agentToken/agentPort/...
 * @param {NodeSSH} ssh - Already-connected NodeSSH wrapper from syncService
 */
async function reloadCcAgent(node, ssh) {
    const xray = node.xray || {};
    const token = xray.agentToken;
    if (!token) {
        return; // Agent not provisioned — nothing to refresh
    }
    const agentPort = xray.agentPort || 62080;
    const apiPort = xray.apiPort || 61000;
    const useTls = xray.agentTls !== false;

    // Resolve the access-log block for this node (best-effort). When the module
    // is disabled or the credential is missing we still write an explicit
    // disabled block so a previously-enabled agent is turned off cleanly.
    let accessLogs;
    try {
        accessLogs = await require('./accessLogs/provisionService').buildNodeAccessLogsConfig(node);
    } catch (e) {
        accessLogs = { enabled: false };
    }

    const agentConfig = buildAgentConfig(node, token, agentPort, apiPort, useTls, accessLogs);
    const configJson = JSON.stringify(agentConfig, null, 2);

    await ssh.uploadContent(configJson, '/etc/cc-agent/config.json');
    await ssh.exec('chmod 600 /etc/cc-agent/config.json');
    // Wait for systemd to confirm cc-agent is active again before returning,
    // so the caller (syncService) can immediately POST /restart to it without
    // racing the bring-up. The loop polls for up to ~5 s and exits 0 as soon
    // as the unit is active again, exit 1 on timeout.
    const waitResult = await ssh.exec(
        'systemctl restart cc-agent && '
        + 'for i in 1 2 3 4 5; do '
        + '  systemctl is-active cc-agent >/dev/null 2>&1 && exit 0; '
        + '  sleep 1; '
        + 'done; '
        + 'exit 1'
    );
    if (waitResult && typeof waitResult.code === 'number' && waitResult.code !== 0) {
        logger.warn(`[Agent] Node ${node.name}: cc-agent did not become active within ~5s (will continue anyway)`);
    }
    logger.info(`[Agent] Node ${node.name}: cc-agent config refreshed (${agentConfig.inbounds.length} inbound(s))`);
}

module.exports = {
    setupNode,
    checkNodeStatus,
    getNodeLogs,
    connectSSH,
    execSSH,
    uploadFile,
    setupXrayNode,
    setupXrayNodeWithAgent,
    installCCAgent,
    buildAgentConfig,
    reloadCcAgent,
    resolveNodeServiceCandidates,
    stopNodeRuntime,
    startNodeRuntime,
    generateAgentToken,
    ensureXrayAgentToken,
    checkXrayNodeStatus,
    getXrayNodeLogs,
    getPanelCertificates,
    isSameVpsAsPanel,
    isLoopbackAddress,
};
