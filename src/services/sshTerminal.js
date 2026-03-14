/**
 * WebSocket SSH Terminal Service
 */

const { Client } = require('ssh2');
const logger = require('../utils/logger');
const cryptoService = require('./cryptoService');

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

class SSHTerminalManager {
    constructor() {
        this.sessions = new Map();
    }

    /**
     * Create SSH session
     */
    async createSession(sessionId, node, ws) {
        return new Promise((resolve, reject) => {
            const conn = new Client();
            
            const config = {
                host: node.ip,
                port: node.ssh?.port || 22,
                username: node.ssh?.username || 'root',
                readyTimeout: 30000,
            };
            
            if (node.ssh?.privateKey) {
                config.privateKey = decryptPrivateKey(node.ssh.privateKey);
            } else if (node.ssh?.password) {
                config.password = cryptoService.decrypt(node.ssh.password);
            } else {
                reject(new Error('SSH credentials not configured'));
                return;
            }
            
            conn.on('ready', () => {
                logger.info(`[SSH Terminal] Connected to ${node.name} (${node.ip})`);
                
                conn.shell({ term: 'xterm-256color', cols: 120, rows: 30 }, (err, stream) => {
                    if (err) {
                        conn.end();
                        reject(err);
                        return;
                    }
                    
                    this.sessions.set(sessionId, { conn, stream, node });
                    
                    stream.on('data', (data) => {
                        if (ws.readyState === 1) { // WebSocket.OPEN
                            ws.send(JSON.stringify({ type: 'output', data: data.toString('utf8') }));
                        }
                    });
                    
                    stream.stderr.on('data', (data) => {
                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({ type: 'output', data: data.toString('utf8') }));
                        }
                    });
                    
                    stream.on('close', () => {
                        logger.info(`[SSH Terminal] Stream closed for ${node.name}`);
                        this.closeSession(sessionId);
                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({ type: 'closed', reason: 'Stream closed' }));
                        }
                    });
                    
                    resolve({ conn, stream });
                });
            });
            
            conn.on('error', (err) => {
                logger.error(`[SSH Terminal] Error connecting to ${node.name}: ${err.message}`);
                reject(err);
            });
            
            conn.on('close', () => {
                logger.info(`[SSH Terminal] Connection closed for ${node.name}`);
                this.closeSession(sessionId);
            });
            
            conn.connect(config);
        });
    }

    /**
     * Write data to SSH
     */
    write(sessionId, data) {
        const session = this.sessions.get(sessionId);
        if (session && session.stream) {
            session.stream.write(data);
        }
    }

    /**
     * Resize terminal
     */
    resize(sessionId, cols, rows) {
        const session = this.sessions.get(sessionId);
        if (session && session.stream) {
            session.stream.setWindow(rows, cols, 0, 0);
        }
    }

    /**
     * Close session
     */
    closeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            if (session.stream) {
                session.stream.end();
            }
            if (session.conn) {
                session.conn.end();
            }
            this.sessions.delete(sessionId);
            logger.info(`[SSH Terminal] Session ${sessionId} closed`);
        }
    }

    /**
     * Get session info
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
}

module.exports = new SSHTerminalManager();

