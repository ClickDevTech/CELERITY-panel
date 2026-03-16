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

/**
 * Decrypt a stored private key.
 * Handles both encrypted (AES via cryptoService) and legacy plaintext keys.
 */
function decryptPrivateKey(key) {
    try {
        const decrypted = cryptoService.decrypt(key);
        if (decrypted && decrypted.includes('-----BEGIN')) return decrypted;
    } catch (_) {
        // Not encrypted — fall through
    }
    return key;
}

/**
 * Check if a node is on the same VPS as the panel
 * Uses multiple heuristics: domain match, IP match via DNS, localhost detection
 * @param {Object} node - Node object with ip and domain fields
 * @returns {boolean} true if node appears to be on the same server as the panel
 */
function isSameVpsAsPanel(node) {
    const panelDomain = config.PANEL_DOMAIN;
    
    // 1. Domain match - most reliable indicator
    if (node.domain && node.domain === panelDomain) {
        logger.debug(`[NodeSetup] Same VPS detected: domain match (${node.domain})`);
        return true;
    }
    
    // 2. Localhost / loopback detection
    const nodeIp = (node.ip || '').toLowerCase().trim();
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
        // Greenlock stores certs in greenlock.d/live/{domain}/
        const greenlockDir = path.join(__dirname, '../../greenlock.d/live', domain);
        const certPath = path.join(greenlockDir, 'cert.pem');
        const keyPath = path.join(greenlockDir, 'privkey.pem');
        const fullchainPath = path.join(greenlockDir, 'fullchain.pem');
        
        if (fs.existsSync(certPath)) {
            cert = fs.readFileSync(certPath, 'utf8');
        } else if (fs.existsSync(fullchainPath)) {
            cert = fs.readFileSync(fullchainPath, 'utf8');
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

const INSTALL_SCRIPT = `#!/bin/bash
set -e

echo "=== [1/5] Checking Hysteria installation ==="

if ! command -v hysteria &> /dev/null; then
    echo "Hysteria not found. Installing..."
    bash <(curl -fsSL https://get.hy2.sh/)
    echo "Done: Hysteria installed"
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
iptables -t nat -D PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
ip6tables -t nat -D PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true

# Clear legacy interface-specific rules
for iface in eth0 eth1 ens3 ens5 enp0s3 eno1; do
    iptables -t nat -D PREROUTING -i $iface -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
    ip6tables -t nat -D PREROUTING -i $iface -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
done

# Add new rules (no interface binding)
iptables -t nat -A PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort}
ip6tables -t nat -A PREROUTING -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort}
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
    apt-get install -y iptables-persistent 2>/dev/null || true
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
            connConfig.privateKey = decryptPrivateKey(node.ssh.privateKey);
        } else if (node.ssh?.password) {
            connConfig.password = cryptoService.decrypt(node.ssh.password);
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
        
        if (installHysteria) {
            log('Installing Hysteria...');
            const installResult = await execSSH(conn, INSTALL_SCRIPT);
            logs.push(installResult.output);
            
            if (!installResult.success) {
                throw new Error(`Hysteria installation failed: ${installResult.error}`);
            }
            log('Hysteria installed');
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

/**
 * Generate x25519 keys for Xray Reality via SSH
 * Supports multiple output formats:
 * - Old: "Private key: xxx\nPublic key: xxx"
 * - New: "PrivateKey: xxx\nPublicKey: xxx"
 * @returns {{ privateKey: string, publicKey: string } | null}
 */
async function generateX25519Keys(conn) {
    const result = await execSSH(conn, 'xray x25519');
    if (!result.success) {
        throw new Error(`Failed to generate x25519 keys: ${result.output}`);
    }
    const output = result.output;
    
    // Try different formats (case-insensitive, with/without space)
    const privMatch = output.match(/Private\s*[Kk]ey:\s*(\S+)/i);
    const pubMatch = output.match(/Public\s*[Kk]ey:\s*(\S+)/i);
    
    if (!privMatch || !pubMatch) {
        // Fallback: try to extract first two base64-like strings
        const base64Pattern = /:\s*([A-Za-z0-9_-]{40,})/g;
        const matches = [...output.matchAll(base64Pattern)];
        if (matches.length >= 2) {
            return { privateKey: matches[0][1], publicKey: matches[1][1] };
        }
        throw new Error(`Could not parse x25519 output: ${output}`);
    }
    return { privateKey: privMatch[1], publicKey: pubMatch[1] };
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
    const { restartService = true } = options;

    const logs = [];
    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}`;
        logs.push(line);
        logger.info(`[XraySetup] ${msg}`);
    };

    log(`Starting Xray setup for ${node.name} (${node.ip})`);

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

    if (sameVps) {
        log(`Same-VPS setup detected (node port: ${nodePort}, panel domain: ${config.PANEL_DOMAIN})`);
    }

    let conn;
    let generatedKeys = null;

    try {
        log('Connecting via SSH...');
        conn = await connectSSH(node);
        log('SSH connected');

        // Install Xray
        log('Installing Xray-core...');
        const installResult = await execSSH(conn, XRAY_INSTALL_SCRIPT);
        logs.push(installResult.output);
        if (!installResult.success) {
            throw new Error(`Xray installation failed: ${installResult.error}`);
        }
        log('Xray-core installed');

        // Generate Reality keys and shortId if needed
        const xrayCfg = node.xray || {};
        if (xrayCfg.security === 'reality') {
            const updates = {};
            let needsUpdate = false;

            // Generate x25519 keys if not set
            if (!xrayCfg.realityPrivateKey) {
                log('Generating x25519 Reality keys...');
                generatedKeys = await generateX25519Keys(conn);
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
        const users = await syncService._getUsersForNode(node);
        const configContent = configGenerator.generateXrayConfig(node, users);
        const configPath = '/usr/local/etc/xray/config.json';

        await uploadFile(conn, configContent, configPath);
        log(`Config uploaded to ${configPath} (${users.length} users)`);
        logs.push('--- Config preview ---');
        logs.push(configContent.substring(0, 500) + (configContent.length > 500 ? '\n...' : ''));
        logs.push('--- End config preview ---');

        // Open firewall ports
        const mainPort = node.port || 443;
        const apiPort = (node.xray || {}).apiPort || 61000;
        log(`Opening firewall ports (${mainPort}, api:${apiPort})...`);
        const firewallResult = await execSSH(conn, `
echo "=== Opening firewall ports ==="
if command -v iptables &> /dev/null; then
    iptables -I INPUT -p tcp --dport ${mainPort} -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p udp --dport ${mainPort} -j ACCEPT 2>/dev/null || true
    echo "Done: iptables rules added"
fi
if command -v ufw &> /dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow ${mainPort}/tcp 2>/dev/null || true
    ufw allow ${mainPort}/udp 2>/dev/null || true
    echo "Done: UFW rules added"
fi
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
 * Install and configure cc-agent on an Xray node via SSH.
 *
 * Flow:
 *  1. Download binary from GitHub releases (or fallback URL)
 *  2. Write /etc/cc-agent/config.json with token + TLS settings
 *  3. If TLS: generate self-signed cert with openssl
 *  4. Open port in firewall only for the panel's IP
 *  5. Install & start cc-agent.service
 *
 * @param {Object} conn  - Active ssh2 connection
 * @param {Object} node  - Node document
 * @param {string} token - Pre-generated agent token
 * @param {string} panelIp - Panel's outbound IP (for firewall whitelist)
 * @param {Function} log - Logging callback
 * @returns {{ success, agentVersion }}
 */
async function installCCAgent(conn, node, token, panelIp, log) {
    const agentPort = (node.xray || {}).agentPort || 62080;
    const useTls = (node.xray || {}).agentTls !== false;
    const apiPort = (node.xray || {}).apiPort || 61000;
    const inboundTag = (node.xray || {}).inboundTag || 'vless-in';

    const agentConfig = {
        listen: `0.0.0.0:${agentPort}`,
        token: token,
        xray_api: `127.0.0.1:${apiPort}`,
        inbound_tag: inboundTag,
        data_dir: '/var/lib/cc-agent',
        tls: {
            enabled: useTls,
            cert: '/etc/cc-agent/cert.pem',
            key: '/etc/cc-agent/key.pem',
        },
    };

    const configJson = JSON.stringify(agentConfig, null, 2);

    // TLS setup: generate self-signed certificate with openssl
    const tlsSetupScript = useTls ? `
echo "=== Generating self-signed TLS cert for cc-agent ==="
openssl req -x509 -nodes -newkey rsa:2048 \\
    -keyout /etc/cc-agent/key.pem \\
    -out /etc/cc-agent/cert.pem \\
    -subj "/CN=cc-agent" -days 36500 2>&1
chmod 600 /etc/cc-agent/key.pem /etc/cc-agent/cert.pem
echo "Done: TLS cert generated"
` : `
echo "TLS disabled, skipping cert generation"
`;

    const AGENT_INSTALL = `#!/bin/bash
# NOTE: set -e is intentionally NOT used here so agent install failure
# doesn't break the rest of the script (Xray is already set up).

echo "=== [1/5] Downloading CC Agent ==="
ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    BIN_NAME="cc-agent-linux-arm64"
else
    BIN_NAME="cc-agent-linux-amd64"
fi

GITHUB_URL="https://github.com/ClickDevTech/CELERITY-panel/releases/latest/download/$BIN_NAME"

# Clean up any previous broken/stale binary before downloading
rm -f /usr/local/bin/cc-agent

DOWNLOADED=0

# Primary source: GitHub releases (curl -f exits with code 22 on HTTP errors)
if curl -fsSL --max-time 60 "$GITHUB_URL" -o /usr/local/bin/cc-agent 2>/dev/null && [ -s /usr/local/bin/cc-agent ]; then
    chmod +x /usr/local/bin/cc-agent
    echo "Done: cc-agent downloaded from GitHub"
    DOWNLOADED=1
fi

# Validate the downloaded file is a real ELF binary, not an error page
if [ "$DOWNLOADED" = "1" ]; then
    if command -v file &>/dev/null && ! file /usr/local/bin/cc-agent 2>/dev/null | grep -q "ELF"; then
        echo "WARNING: Downloaded file does not appear to be a valid binary (got: $(file /usr/local/bin/cc-agent 2>/dev/null || echo 'unknown'))"
        rm -f /usr/local/bin/cc-agent
        DOWNLOADED=0
    fi
fi

if [ "$DOWNLOADED" = "0" ]; then
    echo "WARNING: Could not download cc-agent binary."
    echo "Place the binary at /usr/local/bin/cc-agent and restart cc-agent.service"
    echo "Continuing with Xray setup (agent will be missing)..."
    exit 0
fi

echo "=== [2/5] Creating directories ==="
mkdir -p /etc/cc-agent /var/lib/cc-agent

echo "=== [3/5] Writing config ==="
cat > /etc/cc-agent/config.json << 'EOFCONFIG'
${configJson}
EOFCONFIG
echo "Done: config written"

${tlsSetupScript}

echo "=== [4/5] Installing systemd service ==="
cat > /etc/systemd/system/cc-agent.service << 'EOFSVC'
[Unit]
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
EOFSVC

echo "=== [5/5] Opening firewall for panel IP ${panelIp} ==="
if command -v iptables &> /dev/null; then
    iptables -I INPUT -p tcp -s ${panelIp} --dport ${agentPort} -j ACCEPT 2>/dev/null || true
    echo "Done: iptables rule added"
fi
if command -v ufw &> /dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow from ${panelIp} to any port ${agentPort} proto tcp 2>/dev/null || true
    echo "Done: ufw rule added"
fi

echo "=== Starting cc-agent ==="
systemctl daemon-reload
systemctl enable cc-agent
systemctl restart cc-agent
sleep 2
systemctl is-active cc-agent && echo "cc-agent: running" || echo "cc-agent: check logs with: journalctl -u cc-agent -n 30"
echo "Done: cc-agent installed"
`;

    const result = await execSSH(conn, AGENT_INSTALL);
    const agentVersion = result.output.match(/cc-agent[:\s]+(v[\d.]+)/)?.[1] || 'installed';
    return { success: result.success, agentVersion, output: result.output };
}

/**
 * Setup Xray node + CC Agent via SSH.
 * Extends setupXrayNode to also install the agent.
 */
async function setupXrayNodeWithAgent(node, options = {}) {
    const result = await setupXrayNode(node, options);

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
        log('Connecting via SSH for agent installation...');
        conn = await connectSSH(node);

        // Generate agent token if not set
        let agentToken = (node.xray || {}).agentToken;
        if (!agentToken) {
            agentToken = generateAgentToken();
            log(`Generated agent token: ${agentToken.substring(0, 8)}...`);
        }

        // Determine panel IP from config (the IP the node can reach the panel from)
        const panelIpRaw = config.BASE_URL || '';
        const panelIp = panelIpRaw.replace(/^https?:\/\//, '').split(':')[0].split('/')[0] || '0.0.0.0';
        log(`Panel IP for firewall: ${panelIp}`);

        log('Installing CC Agent...');
        const agentResult = await installCCAgent(conn, node, agentToken, panelIp, log);
        result.logs.push(agentResult.output);

        if (!agentResult.success) {
            log(`Agent install warning: may have failed, check logs above`);
        } else {
            log(`Agent installed: ${agentResult.agentVersion}`);
        }

        // Persist agent token and version to DB
        const HyNode = require('../models/hyNodeModel');
        const updates = {
            'xray.agentToken': agentToken,
            agentVersion: agentResult.agentVersion,
            agentStatus: 'unknown', // will be updated on first health check
        };
        await HyNode.updateOne({ _id: node._id }, { $set: updates });
        log('Agent token saved to database');

        result.agentToken = agentToken;

    } catch (error) {
        const line = `[${new Date().toISOString()}] Agent install error: ${error.message}`;
        result.logs.push(line);
        logger.error(`[AgentSetup] ${error.message}`);
        // Don't fail the whole setup if agent install fails
    } finally {
        if (conn) conn.end();
    }

    return result;
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
    generateAgentToken,
    generateX25519Keys,
    checkXrayNodeStatus,
    getXrayNodeLogs,
    getPanelCertificates,
    isSameVpsAsPanel,
};
