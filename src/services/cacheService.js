/**
 * Caching service (Redis)
 * 
 * Caches:
 * - User subscriptions
 * - User data (for auth)
 * - Online sessions (for device limits)
 * - Active nodes
 * 
 * TTL is configurable via panel settings
 */

const Redis = require('ioredis');
const logger = require('../utils/logger');

// Default TTL (seconds) - used if settings not loaded
const DEFAULT_TTL = {
    SUBSCRIPTION: 3600,      // 1 hour
    USER: 900,               // 15 minutes
    ONLINE_SESSIONS: 10,     // 10 seconds
    ACTIVE_NODES: 30,        // 30 seconds
    SETTINGS: 60,            // 1 minute (fixed)
    TRAFFIC_STATS: 300,      // 5 minutes
    GROUPS: 300,             // 5 minutes
    DASHBOARD_COUNTS: 60,    // 1 minute
    QR: 3600,                // 1 hour (QR code for subscription URL)
};

// Key prefixes
// SUB carries a version (v2 = hopping-aware keyspace + fresh userinfo on HIT).
// Old v1 entries are simply orphaned and expire by TTL; both invalidate
// patterns below (`sub:{token}:*`, `sub:*`) match across versions.
const PREFIX = {
    SUB: 'sub:v2:',             // sub:v2:{token}:{format}
    QR: 'qr:',               // qr:{baseUrl}
    USER: 'user:',           // user:{userId}
    DEVICES: 'devices:',     // devices:{userId} - Hash with device IPs
    ONLINE: 'online',        // online (stores all sessions) - legacy
    NODES: 'nodes:active',   // nodes:active
    SETTINGS: 'settings',    // settings
    TRAFFIC_STATS: 'traffic:stats', // Total traffic stats
    GROUPS: 'groups:active', // Active groups
    DASHBOARD_COUNTS: 'dashboard:counts', // Dashboard counters
    AL_DEDUP: 'al:dedup:', // al:dedup:{nodeId}:{batchId} - access-logs batch dedup marker
};

// Access-logs batch dedup markers auto-expire after this many seconds. Long
// enough to cover any agent retry backoff; ClickHouse insert dedup is the real
// safety net, so the exact window is not critical.
const AL_DEDUP_TTL = 86400; // 24 hours

class CacheService {
    constructor() {
        this.redis = null;
        this.connected = false;
        // Dynamic TTL from panel settings
        this.ttl = { ...DEFAULT_TTL };
    }
    
    /**
     * Update TTL from panel settings
     * Called on startup and when settings change
     */
    updateTTL(settings) {
        if (!settings?.cache) return;
        
        const c = settings.cache;
        const num = (v, fb, min, max) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
        };
        this.ttl = {
            SUBSCRIPTION: num(c.subscriptionTTL, DEFAULT_TTL.SUBSCRIPTION, 60, 86400),
            USER: num(c.userTTL, DEFAULT_TTL.USER, 60, 3600),
            ONLINE_SESSIONS: num(c.onlineSessionsTTL, DEFAULT_TTL.ONLINE_SESSIONS, 5, 60),
            ACTIVE_NODES: num(c.activeNodesTTL, DEFAULT_TTL.ACTIVE_NODES, 10, 300),
            SETTINGS: num(c.settingsTTL, DEFAULT_TTL.SETTINGS, 10, 600),
            TRAFFIC_STATS: num(c.trafficStatsTTL, DEFAULT_TTL.TRAFFIC_STATS, 60, 3600),
            GROUPS: num(c.groupsTTL, DEFAULT_TTL.GROUPS, 60, 3600),
            DASHBOARD_COUNTS: num(c.dashboardCountsTTL, DEFAULT_TTL.DASHBOARD_COUNTS, 10, 600),
        };
        logger.info(`[Cache] TTL updated: sub=${this.ttl.SUBSCRIPTION}s, user=${this.ttl.USER}s`);
    }

    /**
     * Connect to Redis
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
                logger.info('[Redis] Connected');
            });

            this.redis.on('error', (err) => {
                logger.error(`[Redis] Error: ${err.message}`);
                this.connected = false;
            });

            this.redis.on('close', () => {
                this.connected = false;
                logger.warn('[Redis] Connection closed');
            });

            await this.redis.connect();
            
        } catch (err) {
            logger.error(`[Redis] Failed to connect: ${err.message}`);
            this.connected = false;
        }
    }

    /**
     * Check connection status
     */
    isConnected() {
        return this.connected && this.redis;
    }

    // ==================== SUBSCRIPTIONS ====================

    /**
     * Get subscription from cache
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
            logger.error(`[Cache] getSubscription error: ${err.message}`);
            return null;
        }
    }

    /**
     * Save subscription to cache
     */
    async setSubscription(token, format, data) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.SUB}${token}:${format}`;
            await this.redis.setex(key, this.ttl.SUBSCRIPTION, JSON.stringify(data));
            logger.debug(`[Cache] SET subscription: ${token}:${format}`);
        } catch (err) {
            logger.error(`[Cache] setSubscription error: ${err.message}`);
        }
    }

    /**
     * Invalidate subscription (all formats)
     * Uses SCAN instead of KEYS for non-blocking operation
     */
    async invalidateSubscription(token) {
        if (!this.isConnected()) return;
        
        try {
            const pattern = `${PREFIX.SUB}${token}:*`;
            const keysToDelete = await this._scanKeys(pattern);
            
            if (keysToDelete.length > 0) {
                await this.redis.unlink(...keysToDelete);
                logger.debug(`[Cache] INVALIDATE subscription: ${token} (${keysToDelete.length} keys)`);
            }
        } catch (err) {
            logger.error(`[Cache] invalidateSubscription error: ${err.message}`);
        }
    }

    /**
     * Invalidate all subscriptions (when nodes change)
     * Uses SCAN instead of KEYS for non-blocking operation
     */
    async invalidateAllSubscriptions() {
        if (!this.isConnected()) return;
        
        try {
            const pattern = `${PREFIX.SUB}*`;
            const keysToDelete = await this._scanKeys(pattern);
            
            if (keysToDelete.length > 0) {
                // Delete in batches of 100 keys to avoid blocking
                const BATCH_SIZE = 100;
                for (let i = 0; i < keysToDelete.length; i += BATCH_SIZE) {
                    const batch = keysToDelete.slice(i, i + BATCH_SIZE);
                    await this.redis.unlink(...batch);
                }
                logger.info(`[Cache] INVALIDATE all subscriptions (${keysToDelete.length} keys)`);
            }
        } catch (err) {
            logger.error(`[Cache] invalidateAllSubscriptions error: ${err.message}`);
        }
    }
    
    /**
     * Get cached QR code data URL for subscription link
     */
    async getQR(baseUrl) {
        if (!this.isConnected()) return null;
        try {
            const key = `${PREFIX.QR}${baseUrl}`;
            return await this.redis.get(key);
        } catch (err) {
            logger.error(`[Cache] getQR error: ${err.message}`);
            return null;
        }
    }

    /**
     * Cache QR code data URL
     */
    async setQR(baseUrl, dataUrl) {
        if (!this.isConnected()) return;
        try {
            const key = `${PREFIX.QR}${baseUrl}`;
            await this.redis.setex(key, DEFAULT_TTL.QR, dataUrl);
        } catch (err) {
            logger.error(`[Cache] setQR error: ${err.message}`);
        }
    }

    /**
     * Non-blocking key search via SCAN
     * @param {string} pattern - search pattern
     * @returns {Promise<string[]>} - array of found keys
     */
    async _scanKeys(pattern) {
        const keys = [];
        let cursor = '0';
        
        do {
            const [newCursor, foundKeys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = newCursor;
            keys.push(...foundKeys);
        } while (cursor !== '0');
        
        return keys;
    }

    // ==================== USERS ====================

    /**
     * Get user from cache
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
            logger.error(`[Cache] getUser error: ${err.message}`);
            return null;
        }
    }

    /**
     * Save user to cache
     */
    async setUser(userId, userData) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.USER}${userId}`;
            // Don't cache password
            const safeData = { ...userData };
            if (safeData.password) delete safeData.password;
            
            await this.redis.setex(key, this.ttl.USER, JSON.stringify(safeData));
            logger.debug(`[Cache] SET user: ${userId}`);
        } catch (err) {
            logger.error(`[Cache] setUser error: ${err.message}`);
        }
    }

    /**
     * Invalidate user cache
     */
    async invalidateUser(userId) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.USER}${userId}`;
            await this.redis.del(key);
            logger.debug(`[Cache] INVALIDATE user: ${userId}`);
        } catch (err) {
            logger.error(`[Cache] invalidateUser error: ${err.message}`);
        }
    }

    // ==================== DEVICES (IP) ====================

    /**
     * Get all device IPs for user with timestamps
     * @param {string} userId 
     * @returns {Object} { ip: timestamp, ... } or empty object
     */
    async getDeviceIPs(userId) {
        if (!this.isConnected()) return {};
        
        try {
            const key = `${PREFIX.DEVICES}${userId}`;
            const data = await this.redis.hgetall(key);
            return data || {};
        } catch (err) {
            logger.error(`[Cache] getDeviceIPs error: ${err.message}`);
            return {};
        }
    }

    /**
     * Update timestamp for device IP
     * Uses pipeline for better performance (1 RTT instead of 2)
     * @param {string} userId 
     * @param {string} ip 
     */
    async updateDeviceIP(userId, ip) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.DEVICES}${userId}`;
            await this.redis.pipeline()
                .hset(key, ip, Date.now().toString())
                .expire(key, 86400) // 24 hours TTL for auto-cleanup
                .exec();
        } catch (err) {
            logger.error(`[Cache] updateDeviceIP error: ${err.message}`);
        }
    }

    /**
     * Remove stale device IPs
     * @param {string} userId 
     * @param {number} gracePeriodMs - period in milliseconds
     */
    async cleanupOldDeviceIPs(userId, gracePeriodMs) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.DEVICES}${userId}`;
            const devices = await this.redis.hgetall(key);
            const now = Date.now();
            
            const toDelete = [];
            for (const [ip, timestamp] of Object.entries(devices)) {
                if (now - parseInt(timestamp) > gracePeriodMs) {
                    toDelete.push(ip);
                }
            }
            
            if (toDelete.length > 0) {
                await this.redis.hdel(key, ...toDelete);
                logger.debug(`[Cache] Cleaned ${toDelete.length} old IPs for ${userId}`);
            }
        } catch (err) {
            logger.error(`[Cache] cleanupOldDeviceIPs error: ${err.message}`);
        }
    }

    /**
     * Clear all user devices (on disable/kick)
     * @param {string} userId 
     */
    async clearDeviceIPs(userId) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.DEVICES}${userId}`;
            await this.redis.del(key);
            logger.debug(`[Cache] Cleared devices for ${userId}`);
        } catch (err) {
            logger.error(`[Cache] clearDeviceIPs error: ${err.message}`);
        }
    }

    // ==================== ONLINE SESSIONS (legacy, for compatibility) ====================

    /**
     * Get online sessions (legacy)
     * @deprecated Use getDeviceIPs for device counting
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
            logger.error(`[Cache] getOnlineSessions error: ${err.message}`);
            return null;
        }
    }

    /**
     * Save online sessions (legacy)
     * @deprecated Use updateDeviceIP for device updates
     */
    async setOnlineSessions(data) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.ONLINE, this.ttl.ONLINE_SESSIONS, JSON.stringify(data));
        } catch (err) {
            logger.error(`[Cache] setOnlineSessions error: ${err.message}`);
        }
    }

    // ==================== ACTIVE NODES ====================

    /**
     * Get active nodes
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
            logger.error(`[Cache] getActiveNodes error: ${err.message}`);
            return null;
        }
    }

    /**
     * Save active nodes
     */
    async setActiveNodes(nodes) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.NODES, this.ttl.ACTIVE_NODES, JSON.stringify(nodes));
            logger.debug('[Cache] SET active nodes');
        } catch (err) {
            logger.error(`[Cache] setActiveNodes error: ${err.message}`);
        }
    }

    /**
     * Invalidate nodes cache
     */
    async invalidateNodes() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.NODES);
            logger.debug('[Cache] INVALIDATE nodes');
        } catch (err) {
            logger.error(`[Cache] invalidateNodes error: ${err.message}`);
        }
    }

    // ==================== SETTINGS ====================

    /**
     * Get settings
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
            logger.error(`[Cache] getSettings error: ${err.message}`);
            return null;
        }
    }

    /**
     * Save settings
     */
    async setSettings(settings) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.SETTINGS, this.ttl.SETTINGS, JSON.stringify(settings));
        } catch (err) {
            logger.error(`[Cache] setSettings error: ${err.message}`);
        }
    }

    /**
     * Invalidate settings cache
     */
    async invalidateSettings() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.SETTINGS);
        } catch (err) {
            logger.error(`[Cache] invalidateSettings error: ${err.message}`);
        }
    }

    // ==================== TRAFFIC STATS ====================

    /**
     * Get traffic stats
     */
    async getTrafficStats() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.TRAFFIC_STATS);
            if (data) {
                logger.debug('[Cache] HIT traffic stats');
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] getTrafficStats error: ${err.message}`);
            return null;
        }
    }

    /**
     * Save traffic stats
     */
    async setTrafficStats(stats) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.TRAFFIC_STATS, this.ttl.TRAFFIC_STATS, JSON.stringify(stats));
            logger.debug('[Cache] SET traffic stats');
        } catch (err) {
            logger.error(`[Cache] setTrafficStats error: ${err.message}`);
        }
    }

    /**
     * Invalidate traffic stats cache
     */
    async invalidateTrafficStats() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.TRAFFIC_STATS);
            logger.debug('[Cache] INVALIDATE traffic stats');
        } catch (err) {
            logger.error(`[Cache] invalidateTrafficStats error: ${err.message}`);
        }
    }

    // ==================== GROUPS ====================

    /**
     * Get active groups
     */
    async getGroups() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.GROUPS);
            if (data) {
                logger.debug('[Cache] HIT groups');
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] getGroups error: ${err.message}`);
            return null;
        }
    }

    /**
     * Save active groups
     */
    async setGroups(groups) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.GROUPS, this.ttl.GROUPS, JSON.stringify(groups));
            logger.debug('[Cache] SET groups');
        } catch (err) {
            logger.error(`[Cache] setGroups error: ${err.message}`);
        }
    }

    /**
     * Invalidate groups cache
     */
    async invalidateGroups() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.GROUPS);
            logger.debug('[Cache] INVALIDATE groups');
        } catch (err) {
            logger.error(`[Cache] invalidateGroups error: ${err.message}`);
        }
    }

    // ==================== DASHBOARD COUNTERS ====================

    /**
     * Get dashboard counters
     */
    async getDashboardCounts() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.DASHBOARD_COUNTS);
            if (data) {
                logger.debug('[Cache] HIT dashboard counts');
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] getDashboardCounts error: ${err.message}`);
            return null;
        }
    }

    /**
     * Save dashboard counters
     */
    async setDashboardCounts(counts) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.DASHBOARD_COUNTS, this.ttl.DASHBOARD_COUNTS, JSON.stringify(counts));
            logger.debug('[Cache] SET dashboard counts');
        } catch (err) {
            logger.error(`[Cache] setDashboardCounts error: ${err.message}`);
        }
    }

    /**
     * Invalidate dashboard counters cache
     */
    async invalidateDashboardCounts() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.DASHBOARD_COUNTS);
            logger.debug('[Cache] INVALIDATE dashboard counts');
        } catch (err) {
            logger.error(`[Cache] invalidateDashboardCounts error: ${err.message}`);
        }
    }

    // ==================== FLUSH ALL ====================

    /**
     * Clear all cache data
     */
    async flushAll() {
        if (!this.isConnected()) {
            return { success: false, error: 'Redis not connected' };
        }
        
        try {
            await this.redis.flushdb();
            logger.info('[Cache] All cache data flushed');
            return { success: true };
        } catch (err) {
            logger.error(`[Cache] flushAll error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    // ==================== API KEY RATE LIMITING ====================

    /**
     * Check and increment rate limit counter for an API key.
     * Uses INCR + EXPIRE (sliding window per minute).
     * Returns { allowed: bool, count: number, limit: number }
     */
    async checkApiKeyRateLimit(keyPrefix, maxPerMinute) {
        if (!this.isConnected()) return { allowed: true, count: 0, limit: maxPerMinute };

        try {
            const redisKey = `ratelimit:ak:${keyPrefix}`;
            const count = await this.redis.incr(redisKey);

            // Set TTL only on first increment
            if (count === 1) {
                await this.redis.expire(redisKey, 60);
            }

            return {
                allowed: count <= maxPerMinute,
                count,
                limit: maxPerMinute,
            };
        } catch (err) {
            // On Redis error - allow (fail open)
            return { allowed: true, count: 0, limit: maxPerMinute };
        }
    }

    /**
     * Per-token subscription rate limit: one aggressive client (or leaked
     * link) must not eat the whole global subscription budget.
     * Same INCR + EXPIRE mechanics as API keys. Fail-open without Redis.
     * Returns { allowed: bool, count: number, limit: number }
     */
    async checkSubscriptionTokenRateLimit(token, maxPerMinute) {
        if (!this.isConnected()) return { allowed: true, count: 0, limit: maxPerMinute };

        try {
            const safe = String(token || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
            const redisKey = `ratelimit:sub:${safe}`;
            const count = await this.redis.incr(redisKey);

            if (count === 1) {
                await this.redis.expire(redisKey, 60);
            }

            return {
                allowed: count <= maxPerMinute,
                count,
                limit: maxPerMinute,
            };
        } catch (err) {
            return { allowed: true, count: 0, limit: maxPerMinute };
        }
    }

    // ==================== ACCESS-LOGS BATCH DEDUP ====================
    /**
     * Build the dedup key for an access-logs batch. Node id is sanitized so an
     * unexpected value cannot inject key separators.
     */
    _alDedupKey(nodeId, batchId) {
        const safeNode = String(nodeId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
        return `${PREFIX.AL_DEDUP}${safeNode}:${batchId}`;
    }

    /**
     * Mark an access-logs batch as processed (idempotency for agent retries).
     * Key auto-expires after AL_DEDUP_TTL, so no cleanup job is ever needed.
     */
    async markBatchProcessed(nodeId, batchId) {
        if (!this.isConnected() || !batchId) return;

        try {
            await this.redis.setex(this._alDedupKey(nodeId, batchId), AL_DEDUP_TTL, '1');
        } catch (err) {
            logger.error(`[Cache] markBatchProcessed error: ${err.message}`);
        }
    }

    /**
     * Has this exact (node, batch) already been processed? Fail-safe: on missing
     * connection or any error returns false, so the batch is processed and
     * deduplicated at the ClickHouse layer instead (never a false positive).
     */
    async isBatchProcessed(nodeId, batchId) {
        if (!this.isConnected() || !batchId) return false;

        try {
            return (await this.redis.exists(this._alDedupKey(nodeId, batchId))) === 1;
        } catch (err) {
            logger.error(`[Cache] isBatchProcessed error: ${err.message}`);
            return false;
        }
    }

    // ==================== STATS ====================

    /**
     * Get cache statistics
     */
    async getStats() {
        if (!this.isConnected()) {
            return { connected: false };
        }
        
        try {
            const info = await this.redis.info('memory');
            const dbSize = await this.redis.dbsize();
            
            // Parse used_memory
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

// Singleton
const cacheService = new CacheService();

module.exports = cacheService;

