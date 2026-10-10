/**
 * Shared rate limiters used across the public-facing endpoints.
 *
 * Kept in a tiny dedicated module so middleware and routes outside the main
 * `index.js` (e.g. the Marzban-compat handler) can reuse the same limiter
 * instance — important because each `rateLimit({...})` call owns its own
 * in-memory bucket. Sharing the instance keeps a single bucket per client IP
 * across the native `/api/files`, `/api/info`, and legacy `/{path}/{token}`
 * endpoints.
 *
 * The thresholds are driven by `Settings.rateLimit` and live-reloaded via
 * `applyRateLimits(settings)` (called from `reloadSettings()` in index.js).
 */

const rateLimit = require('express-rate-limit');

const logger = require('./logger');
const { extractClientIp } = require('./clientIp');

// Live thresholds. Mutated by applyRateLimits(); the limiter `max` callback
// reads from this object so updates take effect on the next request.
const _state = {
    subscriptionPerMinute: 100,
    authPerSecond: 200,
};

/**
 * Hybrid Redis/memory store for express-rate-limit v7.
 *
 * Uses Redis (shared across instances and restarts) when connected, and falls
 * back to the built-in in-memory bucket when Redis is down — limiting never
 * hard-fails requests. Lazy-requires cacheService to avoid a require cycle
 * (cacheService never requires this module).
 */
function createHybridStore(prefix, windowMs) {
    const mem = new rateLimit.MemoryStore();
    const getRedis = () => {
        try {
            const cacheService = require('../services/cacheService');
            return cacheService.isConnected() ? cacheService.redis : null;
        } catch {
            return null;
        }
    };
    return {
        init() {
            if (typeof mem.init === 'function') mem.init({ windowMs });
        },
        async increment(key) {
            const redis = getRedis();
            if (redis) {
                try {
                    const rk = `rl:${prefix}:${key}`;
                    const results = await redis.multi([['incr', rk], ['pttl', rk]]).exec();
                    const hits = results?.[0]?.[1];
                    let ttl = results?.[1]?.[1];
                    if (typeof hits === 'number') {
                        if (ttl === -1) {
                            await redis.pexpire(rk, windowMs);
                            ttl = windowMs;
                        }
                        return {
                            totalHits: hits,
                            resetTime: new Date(Date.now() + (typeof ttl === 'number' && ttl > 0 ? ttl : windowMs)),
                        };
                    }
                } catch (err) {
                    logger.warn(`[RateLimit] Redis store failed, memory fallback: ${err.message}`);
                }
            }
            return mem.increment(key);
        },
        async decrement(key) {
            const redis = getRedis();
            if (redis) {
                try {
                    await redis.decr(`rl:${prefix}:${key}`);
                    return;
                } catch { /* fall through */ }
            }
            if (typeof mem.decrement === 'function') return mem.decrement(key);
        },
        async resetKey(key) {
            const redis = getRedis();
            if (redis) {
                try {
                    await redis.del(`rl:${prefix}:${key}`);
                } catch { /* fall through */ }
            }
            if (typeof mem.resetKey === 'function') return mem.resetKey(key);
        },
    };
}

const subscriptionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: () => _state.subscriptionPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    store: createHybridStore('sub', 60 * 1000),
    handler: (req, res) => {
        logger.warn(`[Sub] Rate limit: ${req.ip}`);
        res.status(429).type('text/plain').send('# Too many requests');
    },
});

// Hysteria nodes (not end clients) call /api/auth, so keying by req.ip would
// share one bucket across every user behind a node. Key by the client address
// the node reports in the body instead; fall back to req.ip for malformed hits.
const authKey = (req) => extractClientIp(req.body?.addr) || req.ip;

const authLimiter = rateLimit({
    windowMs: 1000,
    max: () => _state.authPerSecond,
    keyGenerator: authKey,
    standardHeaders: false,
    legacyHeaders: false,
    store: createHybridStore('auth', 1000),
    handler: (req, res) => {
        logger.warn(`[Auth] Rate limit: ${authKey(req)}`);
        res.status(429).json({ ok: false });
    },
});

function applyRateLimits(settings) {
    if (settings?.rateLimit) {
        _state.subscriptionPerMinute = settings.rateLimit.subscriptionPerMinute || 100;
        _state.authPerSecond = settings.rateLimit.authPerSecond || 200;
        logger.info(`[Settings] Rate limits: sub=${_state.subscriptionPerMinute}/min auth=${_state.authPerSecond}/sec`);
    }
}

function getRateLimitState() {
    return _state;
}

module.exports = {
    subscriptionLimiter,
    authLimiter,
    applyRateLimits,
    getRateLimitState,
    createHybridStore,
};
