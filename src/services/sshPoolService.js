/**
 * SSH Connection Pool Service
 * 
 * Оптимизации:
 * - Переиспользование соединений (экономия ~200-500ms на handshake)
 * - Lazy connection (создаётся при первом запросе)
 * - Auto-cleanup idle соединений (освобождение памяти)
 * - Keepalive для поддержания соединений через NAT
 * - Auto-reconnect при обрыве
 * - Graceful shutdown
 */

const { Client } = require('ssh2');
const logger = require('../utils/logger');
const cryptoService = require('./cryptoService');

class SSHPool {
    constructor(options = {}) {
        // Пул соединений: nodeId -> { client, meta }
        this.connections = new Map();
        
        // Настройки
        this.config = {
            maxIdleTime: options.maxIdleTime || 2 * 60 * 1000,      // 2 мин без активности → закрыть
            keepAliveInterval: options.keepAliveInterval || 30000,  // keepalive каждые 30 сек
            connectTimeout: options.connectTimeout || 15000,        // таймаут подключения
            maxRetries: options.maxRetries || 2,                    // попытки переподключения
            cleanupInterval: options.cleanupInterval || 30000,      // проверка idle каждые 30 сек
        };
        
        // Cleanup timer
        this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupInterval);
        
        // Graceful shutdown
        const shutdown = () => this.closeAll();
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
        
        logger.info('[SSHPool] Initialized');
    }
    
    /**
     * Получить или создать соединение
     * @param {Object} node - объект ноды с ssh credentials
     * @returns {Client} - SSH client
     */
    async getConnection(node) {
        const nodeId = node._id?.toString() || node.id;
        
        // Проверяем существующее соединение
        const existing = this.connections.get(nodeId);
        
        if (existing && existing.client._sock?.writable) {
            // Соединение живо - обновляем lastUsed
            existing.lastUsed = Date.now();
            existing.useCount++;
            return existing.client;
        }
        
        // Мёртвое соединение - удаляем
        if (existing) {
            this.removeConnection(nodeId, 'dead');
        }
        
        // Создаём новое
        return this.createConnection(node);
    }
    
    /**
     * Создать новое SSH соединение
     */
    async createConnection(node, retryCount = 0) {
        const nodeId = node._id?.toString() || node.id;
        const nodeName = node.name || nodeId;
        
        return new Promise((resolve, reject) => {
            const client = new Client();
            
            // Таймаут подключения
            const timeout = setTimeout(() => {
                client.end();
                reject(new Error(`Connection timeout (${this.config.connectTimeout}ms)`));
            }, this.config.connectTimeout);
            
            // Конфигурация SSH
            const sshConfig = {
                host: node.ip,
                port: node.ssh?.port || 22,
                username: node.ssh?.username || 'root',
                readyTimeout: this.config.connectTimeout,
                keepaliveInterval: this.config.keepAliveInterval,
                keepaliveCountMax: 3,
            };
            
            // Аутентификация
            if (node.ssh?.privateKey) {
                sshConfig.privateKey = node.ssh.privateKey;
            } else if (node.ssh?.password) {
                sshConfig.password = cryptoService.decrypt(node.ssh.password);
            } else {
                clearTimeout(timeout);
                reject(new Error('SSH: no key or password'));
                return;
            }
            
            client
                .on('ready', () => {
                    clearTimeout(timeout);
                    
                    // Сохраняем в пул
                    const meta = {
                        client,
                        nodeId,
                        nodeName,
                        host: node.ip,
                        createdAt: Date.now(),
                        lastUsed: Date.now(),
                        useCount: 1,
                    };
                    
                    this.connections.set(nodeId, meta);
                    
                    logger.info(`[SSHPool] ✓ Connected: ${nodeName} (${node.ip}) [pool: ${this.connections.size}]`);
                    resolve(client);
                })
                .on('error', async (err) => {
                    clearTimeout(timeout);
                    this.connections.delete(nodeId);
                    
                    // Retry logic с exponential backoff
                    if (retryCount < this.config.maxRetries) {
                        const delay = Math.pow(2, retryCount) * 500;
                        logger.warn(`[SSHPool] ${nodeName}: retry ${retryCount + 1}/${this.config.maxRetries} in ${delay}ms`);
                        
                        await new Promise(r => setTimeout(r, delay));
                        
                        try {
                            const newClient = await this.createConnection(node, retryCount + 1);
                            resolve(newClient);
                        } catch (retryErr) {
                            reject(retryErr);
                        }
                    } else {
                        logger.error(`[SSHPool] ✗ Failed: ${nodeName} - ${err.message}`);
                        reject(err);
                    }
                })
                .on('close', () => {
                    this.removeConnection(nodeId, 'closed');
                })
                .on('end', () => {
                    this.removeConnection(nodeId, 'ended');
                })
                .connect(sshConfig);
        });
    }
    
    /**
     * Удалить соединение из пула
     */
    removeConnection(nodeId, reason = 'unknown') {
        const conn = this.connections.get(nodeId);
        if (conn) {
            try {
                conn.client.end();
            } catch (e) {}
            this.connections.delete(nodeId);
            logger.debug(`[SSHPool] Removed: ${conn.nodeName} (${reason})`);
        }
    }
    
    /**
     * Выполнить команду с auto-reconnect
     */
    async exec(node, command, options = {}) {
        const client = await this.getConnection(node);
        const nodeId = node._id?.toString() || node.id;
        
        return new Promise((resolve, reject) => {
            const execTimeout = options.timeout || 30000;
            
            const timer = setTimeout(() => {
                reject(new Error(`Exec timeout (${execTimeout}ms): ${command.substring(0, 50)}`));
            }, execTimeout);
            
            client.exec(command, (err, stream) => {
                if (err) {
                    clearTimeout(timer);
                    // Соединение сломалось - удаляем из пула
                    this.removeConnection(nodeId, 'exec error');
                    reject(err);
                    return;
                }
                
                let stdout = '';
                let stderr = '';
                
                stream
                    .on('close', (code) => {
                        clearTimeout(timer);
                        resolve({ code, stdout, stderr });
                    })
                    .on('data', (data) => {
                        stdout += data.toString();
                    })
                    .stderr.on('data', (data) => {
                        stderr += data.toString();
                    });
            });
        });
    }
    
    /**
     * Записать файл через SFTP
     */
    async writeFile(node, remotePath, content) {
        const client = await this.getConnection(node);
        const nodeId = node._id?.toString() || node.id;
        
        return new Promise((resolve, reject) => {
            client.sftp((err, sftp) => {
                if (err) {
                    this.removeConnection(nodeId, 'sftp error');
                    reject(err);
                    return;
                }
                
                const writeStream = sftp.createWriteStream(remotePath);
                
                writeStream
                    .on('close', () => {
                        logger.debug(`[SSHPool] Written: ${remotePath}`);
                        resolve();
                    })
                    .on('error', (err) => {
                        reject(err);
                    });
                
                writeStream.write(content);
                writeStream.end();
            });
        });
    }
    
    /**
     * Прочитать файл через SFTP
     */
    async readFile(node, remotePath) {
        const client = await this.getConnection(node);
        const nodeId = node._id?.toString() || node.id;
        
        return new Promise((resolve, reject) => {
            client.sftp((err, sftp) => {
                if (err) {
                    this.removeConnection(nodeId, 'sftp error');
                    reject(err);
                    return;
                }
                
                let content = '';
                const readStream = sftp.createReadStream(remotePath);
                
                readStream
                    .on('data', (data) => {
                        content += data.toString();
                    })
                    .on('close', () => {
                        resolve(content);
                    })
                    .on('error', (err) => {
                        reject(err);
                    });
            });
        });
    }
    
    /**
     * Проверить что соединение есть в пуле и живо
     */
    hasConnection(nodeId) {
        const conn = this.connections.get(nodeId?.toString());
        return conn && conn.client._sock?.writable;
    }
    
    /**
     * Закрыть конкретное соединение
     */
    async close(nodeId) {
        this.removeConnection(nodeId?.toString(), 'manual');
    }
    
    /**
     * Cleanup idle соединений
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [nodeId, conn] of this.connections) {
            const idleTime = now - conn.lastUsed;
            
            if (idleTime > this.config.maxIdleTime) {
                this.removeConnection(nodeId, `idle ${Math.round(idleTime / 1000)}s`);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            logger.info(`[SSHPool] Cleanup: ${cleaned} idle connections removed [pool: ${this.connections.size}]`);
        }
    }
    
    /**
     * Закрыть все соединения
     */
    closeAll() {
        logger.info(`[SSHPool] Shutting down (${this.connections.size} connections)`);
        
        clearInterval(this.cleanupTimer);
        
        for (const [nodeId, conn] of this.connections) {
            try {
                conn.client.end();
            } catch (e) {}
        }
        
        this.connections.clear();
    }
    
    /**
     * Статистика пула
     */
    getStats() {
        const now = Date.now();
        const connections = [];
        
        for (const [nodeId, conn] of this.connections) {
            connections.push({
                nodeId,
                name: conn.nodeName,
                host: conn.host,
                alive: conn.client._sock?.writable || false,
                idleMs: now - conn.lastUsed,
                useCount: conn.useCount,
                uptimeMs: now - conn.createdAt,
            });
        }
        
        return {
            total: this.connections.size,
            config: this.config,
            connections,
        };
    }
}

// Singleton с оптимальными настройками
module.exports = new SSHPool({
    maxIdleTime: 2 * 60 * 1000,       // 2 мин без активности
    keepAliveInterval: 30 * 1000,     // keepalive каждые 30 сек  
    connectTimeout: 15 * 1000,        // таймаут 15 сек
    maxRetries: 2,                    // 2 retry
    cleanupInterval: 30 * 1000,       // cleanup каждые 30 сек
});

