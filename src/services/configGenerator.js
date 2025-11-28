/**
 * Генератор конфигов для Hysteria 2 нод
 * Используем HTTP авторизацию вместо userpass
 */

const yaml = require('yaml');

/**
 * Генерирует YAML конфиг для ноды Hysteria 2
 * 
 * @param {Object} node - Объект ноды из БД
 * @param {string} authUrl - URL для HTTP авторизации
 * @returns {string} YAML конфиг
 */
function generateNodeConfig(node, authUrl) {
    const config = {
        // Слушаем на основном порту
        listen: `:${node.port}`,
        
        // Sniffing для определения протокола
        sniff: {
            enable: true,
            timeout: '2s',
            rewriteDomain: false,
            tcpPorts: '80,443,8000-9000',
            udpPorts: '443,80,53',
        },
        
        // QUIC настройки для оптимизации
        quic: {
            initStreamReceiveWindow: 8388608,      // 8MB
            maxStreamReceiveWindow: 8388608,       // 8MB
            initConnReceiveWindow: 20971520,       // 20MB
            maxConnReceiveWindow: 20971520,        // 20MB
            maxIdleTimeout: '60s',
            maxIncomingStreams: 256,
            disablePathMTUDiscovery: false,
        },
        
        // HTTP авторизация — запросы идут на наш бэкенд
        auth: {
            type: 'http',
            http: {
                url: authUrl,
                insecure: false,
            },
        },
        
        // Bandwidth - не ограничиваем на сервере, пусть клиент сам выбирает
        ignoreClientBandwidth: false,
        
        // Маскировка под обычный HTTPS сервер (проксируем на Google)
        masquerade: {
            type: 'proxy',
            proxy: {
                url: 'https://www.google.com',
                rewriteHost: true,
            },
        },
        
        // ACL - блокируем Китай и приватные сети
        acl: {
            inline: [
                'reject(geoip:cn)',
                'reject(geoip:private)',
            ],
        },
    };
    
    // TLS: если есть домен — используем ACME, иначе файлы сертификатов
    if (node.domain) {
        config.acme = {
            domains: [node.domain],
            email: 'acme@' + node.domain,
            ca: 'letsencrypt',
            listenHost: '0.0.0.0',
        };
    } else {
        config.tls = {
            cert: node.paths?.cert || '/etc/hysteria/cert.pem',
            key: node.paths?.key || '/etc/hysteria/key.pem',
        };
    }
    
    // API статистики (0.0.0.0 чтобы панель могла подключиться извне)
    if (node.statsPort && node.statsSecret) {
        config.trafficStats = {
            listen: `:${node.statsPort}`,
            secret: node.statsSecret,
        };
    }
    
    return yaml.stringify(config);
}

/**
 * Генерирует конфиг с ACME (Let's Encrypt)
 */
function generateNodeConfigACME(node, authUrl, domain, email) {
    const config = {
        listen: `:${node.port}`,
        
        // ACME вместо TLS
        acme: {
            domains: [domain],
            email: email,
        },
        
        sniff: {
            enable: true,
            timeout: '2s',
            rewriteDomain: false,
            tcpPorts: '80,443,8000-9000',
            udpPorts: '443,80,53',
        },
        
        quic: {
            initStreamReceiveWindow: 8388608,
            maxStreamReceiveWindow: 8388608,
            initConnReceiveWindow: 20971520,
            maxConnReceiveWindow: 20971520,
            maxIdleTimeout: '60s',
            maxIncomingStreams: 256,
            disablePathMTUDiscovery: false,
        },
        
        // HTTP авторизация
        auth: {
            type: 'http',
            http: {
                url: authUrl,
                insecure: false,
            },
        },
        
        ignoreClientBandwidth: false,
        
        masquerade: {
            type: 'proxy',
            proxy: {
                url: 'https://www.google.com',
                rewriteHost: true,
            },
        },
        
        acl: {
            inline: [
                'reject(geoip:cn)',
                'reject(geoip:private)',
            ],
        },
    };
    
    if (node.statsPort && node.statsSecret) {
        config.trafficStats = {
            listen: `:${node.statsPort}`,
            secret: node.statsSecret,
        };
    }
    
    return yaml.stringify(config);
}

// generatePortHoppingScript удалён - используйте nodeSetup.js или nodeSSH.js

/**
 * Генерирует systemd service файл для Hysteria
 */
function generateSystemdService() {
    return `[Unit]
Description=Hysteria 2 Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hysteria server -c /etc/hysteria/config.yaml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`;
}

module.exports = {
    generateNodeConfig,
    generateNodeConfigACME,
    generateSystemdService,
};
