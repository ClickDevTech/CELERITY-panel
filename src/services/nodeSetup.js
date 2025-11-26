/**
 * Сервис автоматической настройки нод Hysteria через SSH
 */

const { Client } = require('ssh2');
const logger = require('../utils/logger');
const config = require('../../config');
const cryptoService = require('./cryptoService');

/**
 * Генерирует конфиг Hysteria для ноды
 * ВАЖНО: tls и acme - это два РАЗНЫХ варианта, нельзя использовать оба!
 */
function generateHysteriaConfig(node, authUrl) {
    // TLS секция: либо ACME (автоматические сертификаты), либо ручные сертификаты
    const tlsSection = node.domain 
        ? `# Автоматические сертификаты через ACME (Let's Encrypt)
acme:
  domains:
    - ${node.domain}
  email: admin@${node.domain}
  dir: /etc/hysteria/acme
  listenHost: 0.0.0.0`
        : `# Самоподписанные сертификаты
tls:
  cert: /etc/hysteria/cert.pem
  key: /etc/hysteria/key.pem`;

    return `# Hysteria 2 Config - Auto-generated
# Node: ${node.name}
# Generated: ${new Date().toISOString()}

listen: :${node.port || 443}

${tlsSection}

sniff:
  enable: true
  timeout: 2s
  rewriteDomain: false
  tcpPorts: 80,443,8000-9000
  udpPorts: 443,80,53

quic:
  initStreamReceiveWindow: 8388608
  maxStreamReceiveWindow: 8388608
  initConnReceiveWindow: 20971520
  maxConnReceiveWindow: 20971520
  maxIdleTimeout: 60s
  maxIncomingStreams: 256

auth:
  type: http
  http:
    url: ${authUrl}
    insecure: false

ignoreClientBandwidth: false

masquerade:
  type: string
  string:
    content: "Service Unavailable"
    headers:
      Content-Type: text/plain
    statusCode: 503

acl:
  inline:
    - reject(geoip:cn)

${node.statsSecret ? `trafficStats:
  listen: :${node.statsPort || 9999}
  secret: ${node.statsSecret}` : ''}
`;
}

/**
 * Скрипт установки Hysteria
 */
const INSTALL_SCRIPT = `#!/bin/bash
set -e

echo "=== [1/5] Checking Hysteria installation ==="

# Установка Hysteria если не установлен
if ! command -v hysteria &> /dev/null; then
    echo "Hysteria not found. Installing..."
    bash <(curl -fsSL https://get.hy2.sh/)
    echo "✓ Hysteria installed"
else
    echo "✓ Hysteria already installed"
fi

# Создаём директорию
mkdir -p /etc/hysteria
echo "✓ Directory /etc/hysteria ready"

# Проверяем версию
echo "Hysteria version:"
hysteria version
`;

/**
 * Скрипт настройки port hopping
 */
function getPortHoppingScript(portRange, mainPort) {
    if (!portRange || !portRange.includes('-')) return '';
    
    const [start, end] = portRange.split('-').map(p => parseInt(p.trim()));
    
    return `
echo "=== [4/5] Setting up port hopping ${start}-${end} -> ${mainPort} ==="

# Определяем интерфейс
IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
[ -z "$IFACE" ] && IFACE="eth0"
echo "Using interface: $IFACE"

# Удаляем старые правила если есть
iptables -t nat -D PREROUTING -i $IFACE -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true

# Добавляем новое правило
iptables -t nat -A PREROUTING -i $IFACE -p udp --dport ${start}:${end} -j REDIRECT --to-port ${mainPort}
echo "✓ iptables rule added"

# Сохраняем правила
if command -v netfilter-persistent &> /dev/null; then
    netfilter-persistent save
    echo "✓ Rules saved with netfilter-persistent"
elif [ -f /etc/debian_version ]; then
    apt-get install -y iptables-persistent 2>/dev/null || true
    netfilter-persistent save 2>/dev/null || true
    echo "✓ Attempted to save rules"
fi

echo "✓ Port hopping configured!"
`;
}

/**
 * Скрипт генерации самоподписанного сертификата (совместимый с sh)
 */
const SELF_SIGNED_CERT_SCRIPT = `
echo "=== [2/5] Generating self-signed certificate ==="

# Проверяем наличие openssl
if ! command -v openssl &> /dev/null; then
    echo "Installing openssl..."
    apt-get update && apt-get install -y openssl
fi

# Проверяем существующие файлы
echo "Checking existing certificates..."
ls -la /etc/hysteria/*.pem 2>/dev/null || echo "No existing cert files"

# Проверяем валидность существующего сертификата
CERT_VALID=0
if [ -f /etc/hysteria/cert.pem ] && [ -s /etc/hysteria/cert.pem ] && [ -f /etc/hysteria/key.pem ] && [ -s /etc/hysteria/key.pem ]; then
    if openssl x509 -in /etc/hysteria/cert.pem -noout 2>/dev/null; then
        echo "✓ Valid certificate already exists"
        CERT_VALID=1
        openssl x509 -in /etc/hysteria/cert.pem -noout -subject -dates
    else
        echo "⚠ Certificate file exists but is invalid, regenerating..."
    fi
fi

if [ "$CERT_VALID" = "0" ]; then
    echo "Generating new certificate..."
    
    # Удаляем старые/повреждённые файлы
    rm -f /etc/hysteria/cert.pem /etc/hysteria/key.pem /tmp/ecparam.pem
    
    # Создаём директорию
    mkdir -p /etc/hysteria
    
    # Генерируем EC параметры
    echo "Step 1: Generating EC parameters..."
    openssl ecparam -name prime256v1 -out /tmp/ecparam.pem
    if [ ! -f /tmp/ecparam.pem ]; then
        echo "❌ Failed to create EC parameters"
        exit 1
    fi
    echo "✓ EC parameters created"
    
    # Генерируем сертификат
    echo "Step 2: Generating certificate..."
    openssl req -x509 -nodes -newkey ec:/tmp/ecparam.pem \\
        -keyout /etc/hysteria/key.pem \\
        -out /etc/hysteria/cert.pem \\
        -subj "/CN=bing.com" \\
        -days 36500 2>&1
    
    # Проверяем результат
    if [ ! -f /etc/hysteria/cert.pem ] || [ ! -s /etc/hysteria/cert.pem ]; then
        echo "❌ Certificate file not created or empty!"
        echo "Trying alternative method with RSA..."
        
        # Fallback на RSA если EC не работает
        openssl req -x509 -nodes -newkey rsa:2048 \\
            -keyout /etc/hysteria/key.pem \\
            -out /etc/hysteria/cert.pem \\
            -subj "/CN=bing.com" \\
            -days 36500 2>&1
    fi
    
    if [ ! -f /etc/hysteria/key.pem ] || [ ! -s /etc/hysteria/key.pem ]; then
        echo "❌ Key file not created or empty!"
        exit 1
    fi
    
    # Устанавливаем права
    chmod 600 /etc/hysteria/key.pem
    chmod 644 /etc/hysteria/cert.pem
    
    # Удаляем временный файл
    rm -f /tmp/ecparam.pem
    
    # Финальная проверка
    echo "Step 3: Verifying certificate..."
    if openssl x509 -in /etc/hysteria/cert.pem -noout 2>/dev/null; then
        echo "✓ Certificate generated successfully!"
        openssl x509 -in /etc/hysteria/cert.pem -noout -subject -dates
        ls -la /etc/hysteria/*.pem
    else
        echo "❌ Certificate verification failed!"
        cat /etc/hysteria/cert.pem
        exit 1
    fi
fi
`;

/**
 * Подключение к ноде по SSH
 */
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
            connConfig.privateKey = node.ssh.privateKey;
        } else if (node.ssh?.password) {
            // Расшифровываем пароль
            connConfig.password = cryptoService.decrypt(node.ssh.password);
        } else {
            return reject(new Error('SSH credentials not provided'));
        }
        
        conn.on('ready', () => resolve(conn));
        conn.on('error', (err) => reject(err));
        conn.connect(connConfig);
    });
}

/**
 * Выполнение команды через SSH с возвратом всего вывода
 */
function execSSH(conn, command) {
    return new Promise((resolve, reject) => {
        conn.exec(command, (err, stream) => {
            if (err) return reject(err);
            
            let stdout = '';
            let stderr = '';
            
            stream.on('close', (code) => {
                // Возвращаем весь вывод даже при ошибке (для логирования)
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

/**
 * Загрузка файла через SSH
 */
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
 * Настройка ноды с детальным логированием
 */
async function setupNode(node, options = {}) {
    const { installHysteria = true, setupPortHopping = true, restartService = true } = options;
    
    const logs = [];
    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}`;
        logs.push(line);
        logger.info(`[NodeSetup] ${msg}`);
    };
    
    log(`Starting setup for ${node.name} (${node.ip})`);
    
    const authUrl = `${config.BASE_URL}/api/auth`;
    log(`Auth URL: ${authUrl}`);
    
    let conn;
    
    try {
        // 0. Подключение
        log('Connecting via SSH...');
        conn = await connectSSH(node);
        log('✓ SSH connected');
        
        // 1. Установка Hysteria
        if (installHysteria) {
            log('Installing Hysteria...');
            const installResult = await execSSH(conn, INSTALL_SCRIPT);
            logs.push(installResult.output);
            
            if (!installResult.success) {
                throw new Error(`Hysteria installation failed: ${installResult.error}`);
            }
            log('✓ Hysteria installed');
        }
        
        // 2. Генерация сертификата (если нет домена) или подготовка для ACME
        if (!node.domain) {
            log('Generating self-signed certificate...');
            const certResult = await execSSH(conn, SELF_SIGNED_CERT_SCRIPT);
            logs.push(certResult.output);
            
            if (!certResult.success) {
                throw new Error(`Certificate generation failed: ${certResult.error}`);
            }
            log('✓ Certificate ready');
        } else {
            log(`Domain detected (${node.domain}), ACME will be used`);
            log('Opening port 80 for ACME HTTP-01 challenge...');
            
            // Открываем порт 80 и настраиваем права для ACME
            const acmeSetup = await execSSH(conn, `
echo "=== Setting up for ACME ==="

# Создаём директорию для ACME с правильными правами
mkdir -p /etc/hysteria/acme
chmod 777 /etc/hysteria/acme
chmod 755 /etc/hysteria
echo "✓ ACME directory created with correct permissions"

# Проверяем права
ls -la /etc/hysteria/

# Проверяем/открываем порт 80 (iptables)
if command -v iptables &> /dev/null; then
    iptables -I INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p udp --dport 80 -j ACCEPT 2>/dev/null || true
    echo "✓ Port 80 opened in iptables"
fi

# Проверяем/открываем порт 80 (ufw)
if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
    ufw allow 80/tcp 2>/dev/null || true
    ufw allow 80/udp 2>/dev/null || true
    echo "✓ Port 80 opened in ufw"
fi

# Проверяем что порт 80 свободен
if ss -tlnp | grep -q ':80 '; then
    echo "⚠ Warning: Port 80 is already in use:"
    ss -tlnp | grep ':80 '
else
    echo "✓ Port 80 is free"
fi

echo "✓ ACME preparation complete"
echo "Note: Make sure DNS for ${node.domain} points to this server's IP!"
            `);
            logs.push(acmeSetup.output);
            log('✓ ACME preparation done');
        }
        
        // 3. Загрузка конфига
        log('Uploading config...');
        const hysteriaConfig = generateHysteriaConfig(node, authUrl);
        await uploadFile(conn, hysteriaConfig, '/etc/hysteria/config.yaml');
        log('✓ Config uploaded to /etc/hysteria/config.yaml');
        logs.push('--- Config content ---');
        logs.push(hysteriaConfig);
        logs.push('--- End config ---');
        
        // 4. Port hopping
        if (setupPortHopping && node.portRange) {
            log(`Setting up port hopping (${node.portRange})...`);
            const portHoppingScript = getPortHoppingScript(node.portRange, node.port || 443);
            if (portHoppingScript) {
                const hopResult = await execSSH(conn, portHoppingScript);
                logs.push(hopResult.output);
                
                if (!hopResult.success) {
                    log(`⚠ Port hopping setup warning: ${hopResult.error}`);
                } else {
                    log('✓ Port hopping configured');
                }
            }
        }
        
        // 5. Открытие портов в firewall
        const statsPort = node.statsPort || 9999;
        const mainPort = node.port || 443;
        log(`Opening firewall ports (${mainPort}, ${statsPort})...`);
        const firewallResult = await execSSH(conn, `
echo "=== [5/6] Opening firewall ports ==="

# iptables
if command -v iptables &> /dev/null; then
    iptables -I INPUT -p tcp --dport ${mainPort} -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p udp --dport ${mainPort} -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p tcp --dport ${statsPort} -j ACCEPT 2>/dev/null || true
    echo "✓ Ports ${mainPort}, ${statsPort} opened in iptables"
fi

# ufw
if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
    ufw allow ${mainPort}/tcp 2>/dev/null || true
    ufw allow ${mainPort}/udp 2>/dev/null || true
    ufw allow ${statsPort}/tcp 2>/dev/null || true
    echo "✓ Ports ${mainPort}, ${statsPort} opened in ufw"
fi

echo "✓ Firewall configured"
        `);
        logs.push(firewallResult.output);
        log('✓ Firewall ports opened');
        
        // 6. Перезапуск сервиса
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
                log(`⚠ Service restart warning: ${restartResult.error}`);
            } else {
                log('✓ Service restarted');
            }
        }
        
        log('✅ Setup completed successfully!');
        return { success: true, logs };
        
    } catch (error) {
        log(`❌ Error: ${error.message}`);
        return { success: false, error: error.message, logs };
        
    } finally {
        if (conn) {
            conn.end();
        }
    }
}

/**
 * Проверка статуса ноды через SSH
 */
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

/**
 * Получение логов Hysteria с ноды
 */
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

module.exports = {
    setupNode,
    checkNodeStatus,
    getNodeLogs,
    generateHysteriaConfig,
    connectSSH,
    execSSH,
    uploadFile,
};
