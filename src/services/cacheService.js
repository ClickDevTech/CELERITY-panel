/**
 * Сервис кэширования (Redis)
 * 
 * Кэширует:
 * - Подписки пользователей (TTL: 1 час)
 * - Данные пользователей (TTL: 5 минут)
 * - Онлайн-сессии (TTL: 10 секунд)
 * - Активные ноды (TTL: 30 секунд)
 */

const Redis = require('ioredis');
const logger = require('../utils/logger');

// TTL в секундах
const TTL = {
    SUBSCRIPTION: 3600,      // 1 час
    USER: 300,               // 5 минут
    ONLINE_SESSIONS: 10,     // 10 секунд
    ACTIVE_NODES: 30,        // 30 секунд
    SETTINGS: 60,            // 1 минута
};

// Префиксы ключей
const PREFIX = {
    SUB: 'sub:',             // sub:{token}:{format}
    USER: 'user:',           // user:{userId}
    ONLINE: 'online',        // online (хранит все сессии)
    NODES: 'nodes:active',   // nodes:active
    SETTINGS: 'settings',    // settings
};

class CacheService {
    constructor() {
        this.redis = null;
        this.connected = false;
    }

    /**
     * Подключение к Redis
     */
    async connect() {
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
        
        try {
            this.redis = new Redis(redisUrl, {
                maxRetriesPerRequest: 3,
                retryDelayOnFailover: 100,
                lazyConnect: true,
            });

            this.redis.on('connect', () => {
                this.connected = true;
                logger.info('✅ Redis подключен');
            });

            this.redis.on('error', (err) => {
                logger.error(`[Redis] Ошибка: ${err.message}`);
                this.connected = false;
            });

            this.redis.on('close', () => {
                this.connected = false;
                logger.warn('[Redis] Соединение закрыто');
            });

            await this.redis.connect();
            
        } catch (err) {
            logger.error(`[Redis] Не удалось подключиться: ${err.message}`);
            this.connected = false;
        }
    }

    /**
     * Проверка подключения
     */
    isConnected() {
        return this.connected && this.redis;
    }

    // ==================== ПОДПИСКИ ====================

    /**
     * Получить подписку из кэша
     */
    async getSubscription(token, format) {
        if (!this.isConnected()) return null;
        
        try {
            const key = `${PREFIX.SUB}${token}:${format}`;
            const data = await this.redis.get(key);
            if (data) {
                logger.debug(`[Cache] HIT subscription: ${token}:${format}`);
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getSubscription: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить подписку в кэш
     */
    async setSubscription(token, format, data) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.SUB}${token}:${format}`;
            await this.redis.setex(key, TTL.SUBSCRIPTION, JSON.stringify(data));
            logger.debug(`[Cache] SET subscription: ${token}:${format}`);
        } catch (err) {
            logger.error(`[Cache] Ошибка setSubscription: ${err.message}`);
        }
    }

    /**
     * Инвалидировать подписку (все форматы)
     */
    async invalidateSubscription(token) {
        if (!this.isConnected()) return;
        
        try {
            const pattern = `${PREFIX.SUB}${token}:*`;
            const keys = await this.redis.keys(pattern);
            if (keys.length > 0) {
                await this.redis.del(...keys);
                logger.debug(`[Cache] INVALIDATE subscription: ${token} (${keys.length} keys)`);
            }
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateSubscription: ${err.message}`);
        }
    }

    /**
     * Инвалидировать все подписки (при изменении нод)
     */
    async invalidateAllSubscriptions() {
        if (!this.isConnected()) return;
        
        try {
            const pattern = `${PREFIX.SUB}*`;
            const keys = await this.redis.keys(pattern);
            if (keys.length > 0) {
                await this.redis.del(...keys);
                logger.info(`[Cache] INVALIDATE all subscriptions (${keys.length} keys)`);
            }
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateAllSubscriptions: ${err.message}`);
        }
    }

    // ==================== ПОЛЬЗОВАТЕЛИ ====================

    /**
     * Получить пользователя из кэша
     */
    async getUser(userId) {
        if (!this.isConnected()) return null;
        
        try {
            const key = `${PREFIX.USER}${userId}`;
            const data = await this.redis.get(key);
            if (data) {
                logger.debug(`[Cache] HIT user: ${userId}`);
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getUser: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить пользователя в кэш
     */
    async setUser(userId, userData) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.USER}${userId}`;
            // Не кэшируем пароль
            const safeData = { ...userData };
            if (safeData.password) delete safeData.password;
            
            await this.redis.setex(key, TTL.USER, JSON.stringify(safeData));
            logger.debug(`[Cache] SET user: ${userId}`);
        } catch (err) {
            logger.error(`[Cache] Ошибка setUser: ${err.message}`);
        }
    }

    /**
     * Инвалидировать пользователя
     */
    async invalidateUser(userId) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.USER}${userId}`;
            await this.redis.del(key);
            logger.debug(`[Cache] INVALIDATE user: ${userId}`);
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateUser: ${err.message}`);
        }
    }

    // ==================== ОНЛАЙН-СЕССИИ ====================

    /**
     * Получить онлайн-сессии
     */
    async getOnlineSessions() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.ONLINE);
            if (data) {
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getOnlineSessions: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить онлайн-сессии
     */
    async setOnlineSessions(data) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.ONLINE, TTL.ONLINE_SESSIONS, JSON.stringify(data));
        } catch (err) {
            logger.error(`[Cache] Ошибка setOnlineSessions: ${err.message}`);
        }
    }

    // ==================== АКТИВНЫЕ НОДЫ ====================

    /**
     * Получить активные ноды
     */
    async getActiveNodes() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.NODES);
            if (data) {
                logger.debug('[Cache] HIT active nodes');
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getActiveNodes: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить активные ноды
     */
    async setActiveNodes(nodes) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.NODES, TTL.ACTIVE_NODES, JSON.stringify(nodes));
            logger.debug('[Cache] SET active nodes');
        } catch (err) {
            logger.error(`[Cache] Ошибка setActiveNodes: ${err.message}`);
        }
    }

    /**
     * Инвалидировать ноды
     */
    async invalidateNodes() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.NODES);
            logger.debug('[Cache] INVALIDATE nodes');
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateNodes: ${err.message}`);
        }
    }

    // ==================== НАСТРОЙКИ ====================

    /**
     * Получить настройки
     */
    async getSettings() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.SETTINGS);
            if (data) {
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getSettings: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить настройки
     */
    async setSettings(settings) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.SETTINGS, TTL.SETTINGS, JSON.stringify(settings));
        } catch (err) {
            logger.error(`[Cache] Ошибка setSettings: ${err.message}`);
        }
    }

    /**
     * Инвалидировать настройки
     */
    async invalidateSettings() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.SETTINGS);
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateSettings: ${err.message}`);
        }
    }

    // ==================== СТАТИСТИКА ====================

    /**
     * Получить статистику кэша
     */
    async getStats() {
        if (!this.isConnected()) {
            return { connected: false };
        }
        
        try {
            const info = await this.redis.info('memory');
            const dbSize = await this.redis.dbsize();
            
            // Парсим used_memory
            const usedMemoryMatch = info.match(/used_memory:(\d+)/);
            const usedMemory = usedMemoryMatch ? parseInt(usedMemoryMatch[1]) : 0;
            
            return {
                connected: true,
                keys: dbSize,
                usedMemoryMB: (usedMemory / 1024 / 1024).toFixed(2),
            };
        } catch (err) {
            return { connected: false, error: err.message };
        }
    }
}

// Синглтон
const cacheService = new CacheService();

module.exports = cacheService;

