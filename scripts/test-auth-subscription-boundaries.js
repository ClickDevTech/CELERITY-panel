const assert = require('assert');
const Module = require('module');

// Module paths use backslashes on Windows, so the suffix checks below have to
// compare against a normalized form or every stub silently misses and the test
// talks to the real database.
function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

function createQuery(result) {
    return {
        populate() {
            return this;
        },
        select() {
            return this;
        },
        lean() {
            return Promise.resolve(result);
        },
        then(resolve, reject) {
            return Promise.resolve(result).then(resolve, reject);
        },
    };
}

function createResponse() {
    const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
            this.statusCode = code;
            return this;
        },
        type(value) {
            this.headers['content-type'] = value;
            return this;
        },
        set(headers) {
            Object.assign(this.headers, headers);
            return this;
        },
        json(value) {
            this.body = value;
            this.headersSent = true;
            return this;
        },
        send(value) {
            this.body = value;
            this.headersSent = true;
            return this;
        },
    };
    return res;
}

async function invokeRoute(router, method, routePath, req) {
    const layer = router.stack.find(item => item.route?.path === routePath && item.route.methods[method]);
    assert(layer, `missing route ${method.toUpperCase()} ${routePath}`);
    const handlerLayer = layer.route.stack.find(item => item.method === method);
    assert(handlerLayer, `missing handler for ${method.toUpperCase()} ${routePath}`);

    const res = createResponse();
    await handlerLayer.handle(req, res, err => {
        if (err) throw err;
    });
    return res;
}

async function withRouteStubs(usersById, usersByToken, run) {
    const originalLoad = Module._load;
    const warnings = [];
    const logger = {
        debug() {},
        info() {},
        warn(message) {
            warnings.push(String(message));
        },
        error() {},
    };

    const HyUser = {
        findOne(query, projection) {
            let result = null;
            if (query && Object.prototype.hasOwnProperty.call(query, 'subscriptionToken')) {
                result = usersByToken.get(query.subscriptionToken) || null;
            } else if (query && Object.prototype.hasOwnProperty.call(query, 'userId')) {
                result = usersById.get(query.userId) || null;
            } else if (query && query.$or) {
                const subscriptionClause = query.$or.find(item => Object.prototype.hasOwnProperty.call(item, 'subscriptionToken'));
                const userIdClause = query.$or.find(item => Object.prototype.hasOwnProperty.call(item, 'userId'));
                result = (subscriptionClause && usersByToken.get(subscriptionClause.subscriptionToken))
                    || (userIdClause && usersById.get(userIdClause.userId))
                    || null;
            }

            if (projection === 'password' && result) {
                result = { password: result.password };
            }
            return createQuery(result);
        },
    };

    const HyNode = {
        find() {
            return {
                select() {
                    return {
                        lean: () => Promise.resolve([]),
                    };
                },
            };
        },
    };

    const cache = {
        getUser: async () => null,
        setUser: async () => {},
        getDeviceIPs: async () => ({}),
        updateDeviceIP: async () => {},
        cleanupOldDeviceIPs: async () => {},
        getActiveNodes: async () => null,
        setActiveNodes: async () => {},
        getSubscription: async () => null,
        setSubscription: async () => {},
    };

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'qrcode') return {};

        const parentFile = normalizePath(parent?.filename);
        if (parentFile.endsWith('/src/routes/auth.js') || parentFile.endsWith('/src/routes/subscription.js')) {
            if (request === '../../config') {
                return {
                    BASE_URL: 'https://panel.example.com',
                    DOMAIN: 'panel.example.com',
                };
            }
            if (request === '../models/hyUserModel') return HyUser;
            if (request === '../models/hyNodeModel') return HyNode;
            if (request === '../services/cacheService') return cache;
            if (request === '../utils/logger') return logger;
            if (request === '../services/cryptoService') {
                return { generatePassword: userId => `generated-${userId}` };
            }
            if (request === '../utils/helpers') {
                return {
                    getNodesByGroups: () => [],
                    getSettings: async () => ({
                        loadBalancing: { hideOffline: false },
                        subscription: {},
                    }),
                    parseDurationSeconds: () => 0,
                    normalizeHopInterval: value => value,
                };
            }
            if (request === '../middleware/i18n') {
                return {
                    getDateLocale: () => 'en-US',
                    normalizeLanguage: value => value || 'en',
                };
            }
            if (request === '../services/uaStatsService') return { track() {} };
            if (request === '../utils/hwidHeaders') return { extractHwidHeaders: () => null };
            if (request === '../services/hwidDeviceService') {
                return {
                    resolveMode: () => 'off',
                    effectiveDeviceLimit: () => 0,
                    checkAndUpsert: async () => ({ allowed: true }),
                };
            }
            if (request === '../services/webhookService') {
                return {
                    EVENTS: {},
                    emit() {},
                    emitDeviceLimitReachedOnce() {},
                };
            }
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        delete require.cache[require.resolve('../src/routes/auth')];
        delete require.cache[require.resolve('../src/routes/subscription')];
        return await run({ warnings });
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/routes/auth')];
        delete require.cache[require.resolve('../src/routes/subscription')];
    }
}

async function withRateLimiterStubs(run) {
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        const parentFile = normalizePath(parent?.filename);
        if (parentFile.endsWith('/src/utils/rateLimiters.js') && request === './logger') {
            return {
                info() {},
                warn() {},
                error() {},
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        delete require.cache[require.resolve('../src/utils/rateLimiters')];
        return await run();
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/utils/rateLimiters')];
    }
}

function makeAuthReq(auth) {
    return {
        body: { addr: '203.0.113.10:443', auth, tx: 0 },
    };
}

function makeSubReq(token) {
    return {
        params: { token },
        headers: {},
        query: {},
        protocol: 'https',
        get: () => 'panel.example.com',
        path: `/api/info/${token}`,
    };
}

async function main() {
    const alice = {
        userId: 'alice',
        subscriptionToken: 'safe-token',
        password: 'legacy-alice',
        enabled: true,
        trafficLimit: 0,
        maxDevices: 0,
        groups: [],
        nodes: [{ active: true, type: 'hysteria', status: 'online', groups: [] }],
    };
    const bob = {
        userId: 'bob',
        subscriptionToken: 'bob-token',
        password: 'legacy-bob',
        enabled: true,
        trafficLimit: 0,
        maxDevices: 0,
        groups: [],
        nodes: [{ active: true, type: 'hysteria', status: 'online', groups: [] }],
    };

    const usersById = new Map([
        ['alice', alice],
        ['bob', bob],
    ]);
    const usersByToken = new Map([
        ['safe-token', alice],
        ['bob-token', bob],
    ]);

    await withRouteStubs(usersById, usersByToken, async ({ warnings }) => {
        const authRouter = require('../src/routes/auth');

        for (const payload of ['alice', 'alice:', ':password', '', null, 42]) {
            const res = await invokeRoute(authRouter, 'post', '/', makeAuthReq(payload));
            assert.deepStrictEqual(res.body, { ok: false }, `auth payload ${JSON.stringify(payload)} must be rejected`);
        }

        let res = await invokeRoute(authRouter, 'post', '/', makeAuthReq('alice:wrong'));
        assert.deepStrictEqual(res.body, { ok: false }, 'wrong generated/legacy password must be rejected');

        res = await invokeRoute(authRouter, 'post', '/', makeAuthReq('alice:generated-alice'));
        assert.deepStrictEqual(res.body, { ok: true, id: 'alice' }, 'generated password must authenticate');

        res = await invokeRoute(authRouter, 'post', '/', makeAuthReq('bob:legacy-bob'));
        assert.deepStrictEqual(res.body, { ok: true, id: 'bob' }, 'legacy DB password must authenticate');

        assert(
            warnings.some(message => message.includes('Invalid auth payload')),
            'invalid auth payloads should be logged generically'
        );
        assert(
            !warnings.some(message => message.includes('alice:') || message.includes(':password')),
            'invalid auth log messages must not disclose raw payloads'
        );

        const subscriptionRouter = require('../src/routes/subscription');

        res = await invokeRoute(subscriptionRouter, 'get', '/info/:token', makeSubReq('safe-token'));
        assert.strictEqual(res.statusCode, 200, 'subscriptionToken must find the user');
        assert.strictEqual(res.body.enabled, true);

        res = await invokeRoute(subscriptionRouter, 'get', '/info/:token', makeSubReq('alice'));
        assert.strictEqual(res.statusCode, 404, 'userId must not work as a subscription token');
        assert.deepStrictEqual(res.body, { error: 'Not found' });
    });

    await withRateLimiterStubs(async () => {
        const { authLimiter, applyRateLimits, getRateLimitState } = require('../src/utils/rateLimiters');
        assert.strictEqual(typeof authLimiter, 'function', 'authLimiter must be exported as middleware');
        applyRateLimits({ rateLimit: { subscriptionPerMinute: 11, authPerSecond: 7 } });
        assert.strictEqual(getRateLimitState().authPerSecond, 7, 'authLimiter must use live authPerSecond settings');
    });

    console.log('auth and subscription boundary tests passed');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
