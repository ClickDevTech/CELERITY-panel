/**
 * C³ CELERITY - Management panel for Hysteria 2 nodes
 * by Click Connect
 */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const config = require('./config');
const logger = require('./src/utils/logger');
const requireAuth = require('./src/middleware/auth');
const { requireScope } = requireAuth;
const { i18nMiddleware, LANGUAGE_OPTIONS, normalizeLanguage } = require('./src/middleware/i18n');
const { countRequest } = require('./src/middleware/rpsCounter');
const syncService = require('./src/services/syncService');
const expireScheduler = require('./src/services/expireScheduler');
const cacheService = require('./src/services/cacheService');
const statsService = require('./src/services/statsService');
const HyUser = require('./src/models/hyUserModel');
const HyNode = require('./src/models/hyNodeModel');
const backupService = require('./src/services/backupService');
const homepageService = require('./src/services/homepageService');

const usersRoutes = require('./src/routes/users');
const nodesRoutes = require('./src/routes/nodes');
const cascadeRoutes = require('./src/routes/cascade');
const groupsRoutes = require('./src/routes/groups');
const subscriptionRoutes = require('./src/routes/subscription');
const authRoutes = require('./src/routes/auth');
const panelRoutes = require('./src/routes/panel');
const mcpRoutes = require('./src/routes/mcp');
const marzbanCompat = require('./src/routes/marzbanCompat');
const { subscriptionLimiter, authLimiter, applyRateLimits } = require('./src/utils/rateLimiters');
const { buildSessionCookieOptions } = require('./src/utils/sessionCookie');

const helmet = require('helmet');
const app = express();

app.set('trust proxy', 1);

// ==================== MIDDLEWARE ====================

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));

app.use(compression({
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    },
    level: 6,
}));

app.use(cors({
    origin: config.BASE_URL,
    credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sessionMiddleware = null;

function initSessionMiddleware() {
    sessionMiddleware = session({
        store: new RedisStore({ 
            client: cacheService.redis,
            prefix: 'sess:',
        }),
        secret: config.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: buildSessionCookieOptions()
    });
}

app.use((req, res, next) => {
    if (sessionMiddleware) {
        return sessionMiddleware(req, res, next);
    }
    next();
});

app.use(cookieParser());
app.use(i18nMiddleware);

const { version: appVersion } = require('./package.json');
app.use((req, res, next) => {
    res.locals.appVersion = appVersion;
    next();
});

app.use(countRequest);
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
}));

// Sanitize error details from 500 responses in production
app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function(body) {
        if (res.statusCode >= 500 && process.env.NODE_ENV !== 'development') {
            body = { error: 'Internal Server Error' };
        }
        return originalJson(body);
    };
    next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
    const skipPaths = ['/css', '/js', '/api/auth', '/api/files', '/health'];
    const shouldSkip = skipPaths.some(p => req.path.startsWith(p));
    
    if (!shouldSkip) {
        logger.debug(`${req.method} ${req.path}`);
    }
    next();
});

// ==================== HEALTH CHECK ====================

app.get('/health', async (req, res) => {
    const cacheStats = await cacheService.getStats();
    
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        lastSync: syncService.lastSyncTime,
        isSyncing: syncService.isSyncing,
        cache: cacheStats,
    });
});

// ==================== API ROUTES ====================

app.use('/api/auth', authLimiter, authRoutes);

const Admin = require('./src/models/adminModel');
const totpService = require('./src/services/totpService');
const rateLimit = require('express-rate-limit');

const API_LOGIN_2FA_PENDING_TTL_MS = 10 * 60 * 1000;

function clearApiLogin2faPending(req) {
    if (req.session) {
        delete req.session.apiLogin2faPending;
    }
}

function isApiLogin2faPendingValid(req) {
    const pending = req.session?.apiLogin2faPending;
    if (!pending) return false;
    if (!pending.createdAt) return false;
    return (Date.now() - pending.createdAt) < API_LOGIN_2FA_PENDING_TTL_MS;
}

const apiLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

const apiTotpVerifyLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 8,
    message: { error: 'Too many verification attempts. Try again later.' },
});

app.post('/api/login', apiLoginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const admin = await Admin.verifyPassword(username, password);
        if (!admin) {
            logger.warn(`[API] Failed login: ${username} (IP: ${req.ip})`);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        if (admin.twoFactor?.enabled) {
            req.session.apiLogin2faPending = {
                username: admin.username,
                secretEncrypted: admin.twoFactor.secretEncrypted,
                createdAt: Date.now(),
            };
            delete req.session.authenticated;
            delete req.session.adminUsername;

            logger.info(`[API] 2FA required for ${admin.username} (IP: ${req.ip})`);
            return res.status(202).json({
                success: false,
                requiresTwoFactor: true,
                message: 'Two-factor verification required',
            });
        }

        clearApiLogin2faPending(req);
        req.session.authenticated = true;
        req.session.adminUsername = admin.username;
        await Admin.recordSuccessfulLogin(admin.username);

        logger.info(`[API] Login: ${admin.username} (IP: ${req.ip})`);
        return res.json({
            success: true,
            username: admin.username,
            message: 'Authentication successful. Use cookies for subsequent requests.',
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.post('/api/login/totp', apiTotpVerifyLimiter, async (req, res) => {
    try {
        if (!isApiLogin2faPendingValid(req)) {
            clearApiLogin2faPending(req);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const token = String(req.body?.token || '').trim();
        if (!token) {
            return res.status(400).json({ error: 'Verification code required' });
        }

        const pending = req.session.apiLogin2faPending;
        const secret = totpService.decryptSecret(pending.secretEncrypted);
        const isValid = await totpService.verifyToken({ secret, token });
        if (!isValid) {
            logger.warn(`[API] Failed login 2FA confirmation: ${pending.username} (IP: ${req.ip})`);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        clearApiLogin2faPending(req);
        req.session.authenticated = true;
        req.session.adminUsername = pending.username;
        await Admin.recordSuccessfulLogin(pending.username);

        logger.info(`[API] Login with 2FA: ${pending.username} (IP: ${req.ip})`);
        return res.json({
            success: true,
            username: pending.username,
            message: 'Authentication successful. Use cookies for subsequent requests.',
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.post('/api/logout', (req, res) => {
    const username = req.session?.adminUsername;
    req.session.destroy((err) => {
        if (err) logger.error('[API] Session destroy error on logout:', err.message);
        if (username) {
            logger.info(`[API] Logout: ${username}`);
        }
        res.json({ success: true });
    });
});

async function reloadSettings() {
    const Settings = require('./src/models/settingsModel');
    const hwidDeviceService = require('./src/services/hwidDeviceService');
    const settings = await Settings.get();

    cacheService.updateTTL(settings);
    hwidDeviceService.updateFromSettings(settings);
    applyRateLimits(settings);

    // Marzban compat regex/secret are cached at module scope and must be
    // rebuilt whenever Settings.migration.marzban changes (path, secret,
    // enabled flag, salt mode).
    marzbanCompat.invalidate();
}
module.exports = { reloadSettings };

app.use('/api/files', subscriptionLimiter);
app.use('/api/info', subscriptionLimiter);
app.use('/api', subscriptionRoutes);

// Marzban legacy-link compatibility — middleware no-ops when disabled in
// settings. Mounted BEFORE panel/static handlers but AFTER /api so it never
// shadows real endpoints; in-handler regex further refuses blacklisted paths.
app.use(marzbanCompat);

app.use('/api/users', requireAuth, usersRoutes);
app.use('/api/nodes', requireAuth, nodesRoutes);
app.use('/api/cascade', requireAuth, cascadeRoutes);
app.use('/api/mcp', requireAuth, mcpRoutes);
app.use('/api/groups', requireAuth, groupsRoutes);

app.get('/api/stats', requireAuth, requireScope('stats:read'), async (req, res) => {
    try {
        const [usersTotal, usersEnabled, nodesTotal, nodesOnline] = await Promise.all([
            HyUser.countDocuments(),
            HyUser.countDocuments({ enabled: true }),
            HyNode.countDocuments(),
            HyNode.countDocuments({ status: 'online' }),
        ]);
        
        const nodes = await HyNode.find({ active: true }).select('name onlineUsers');
        const totalOnline = nodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);
        
        res.json({
            users: { total: usersTotal, enabled: usersEnabled },
            nodes: { total: nodesTotal, online: nodesOnline },
            onlineUsers: totalOnline,
            nodesList: nodes.map(n => ({ name: n.name, online: n.onlineUsers })),
            lastSync: syncService.lastSyncTime,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/sync', requireAuth, requireScope('sync:write'), async (req, res) => {
    if (syncService.isSyncing) {
        return res.status(409).json({ error: 'Sync already in progress' });
    }
    
    syncService.syncAllNodes().catch(err => {
        logger.error(`[API] Sync error: ${err.message}`);
    });
    
    res.json({ message: 'Sync started' });
});

app.post('/api/kick/:userId', requireAuth, requireScope('sync:write'), async (req, res) => {
    try {
        await syncService.kickUser(req.params.userId);
        await cacheService.clearDeviceIPs(req.params.userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== API DOCS ====================

if (config.API_DOCS_ENABLED) {
    const { buildSpec } = require('./src/docs/openapi');
    const docsLanguageOptions = LANGUAGE_OPTIONS.map(({ code, label }) => ({ code, label }));
    const getDocsLanguage = (req) => normalizeLanguage(req.query?.lang) || 'en';

    // Serve spec in requested language (?lang=ru|en|zh-CN)
    app.get('/api/docs/openapi.json', (req, res) => {
        const lang = getDocsLanguage(req);
        res.json(buildSpec(lang));
    });

    app.get('/api/docs', (req, res) => {
        const lang = getDocsLanguage(req);
        const specUrl = `/api/docs/openapi.json?lang=${encodeURIComponent(lang)}`;
        const languageLinks = docsLanguageOptions.map(option => {
            const activeClass = option.code === lang ? ' active' : '';
            return `<a class="lang-toggle${activeClass}" href="/api/docs?lang=${encodeURIComponent(option.code)}">${option.label}</a>`;
        }).join('');

        res.send(`<!doctype html>
<html lang="${lang}">
  <head>
    <title>C³ CELERITY — API Reference</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <style>
      body { margin: 0; }
      #lang-switch {
        position: fixed; top: 14px; right: 16px; z-index: 9999;
        display: flex; gap: 6px; font-family: sans-serif;
      }
      .lang-toggle {
        padding: 5px 12px; border-radius: 6px; border: 1px solid #a78bfa;
        background: #1e1e2e; color: #a78bfa; font-size: 13px;
        cursor: pointer; text-decoration: none;
      }
      .lang-toggle:hover,
      .lang-toggle.active { background: #2e2e3e; }
    </style>
  </head>
  <body>
    <nav id="lang-switch" aria-label="API docs language">${languageLinks}</nav>
    <script
      id="api-reference"
      data-url="${specUrl}"
      data-configuration='{"theme":"purple","layout":"modern"}'
    ></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`);
    });

    logger.info('[Docs] API docs available at /api/docs');
}

// ==================== WEB PANEL ====================

app.use('/panel', panelRoutes);

// Public root: serves a configurable decoy/landing page (see homepageService).
// Hot path is in-memory only; no DB/disk reads per request.
app.get('/', (req, res) => homepageService.respond(req, res));
app.head('/', (req, res) => homepageService.respond(req, res));
app.get([
    '/assets/*',
    '/apple-touch-icon.png',
    '/favicon.ico',
    '/favicon.svg',
    '/favicon-96x96.png',
    '/site.webmanifest',
    '/vite.svg',
    '/web-app-manifest-192x192.png',
    '/web-app-manifest-512x512.png',
], (req, res, next) => homepageService.serveTemplateAsset(req, res, next));

// ==================== ERROR HANDLING ====================

// 404
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        res.status(404).json({ error: 'Not Found' });
    } else {
        res.status(404).send('404 - Not Found');
    }
});

// Error handler
app.use((err, req, res, next) => {
    logger.error(`[Error] ${err.message}`);
    const msg = process.env.NODE_ENV !== 'development' ? 'Internal Server Error' : err.message;
    if (req.path.startsWith('/api')) {
        res.status(500).json({ error: msg });
    } else {
        res.status(500).send('Internal Server Error');
    }
});

// ==================== START SERVER ====================

async function connectMongo(retries = 5, delayMs = 3000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await mongoose.connect(config.MONGO_URI, {
                maxPoolSize: 10,
                minPoolSize: 2,
                serverSelectionTimeoutMS: 10000,
                socketTimeoutMS: 45000,
            });
            return;
        } catch (err) {
            if (attempt === retries) throw err;
            logger.warn(`[MongoDB] Connection attempt ${attempt}/${retries} failed: ${err.message}. Retrying in ${delayMs / 1000}s...`);
            await new Promise(r => setTimeout(r, delayMs));
            delayMs = Math.min(delayMs * 2, 30000);
        }
    }
}

async function startServer() {
    try {
        await connectMongo();
        logger.info('[MongoDB] Connected');
        
        await cacheService.connect();

        initSessionMiddleware();
        logger.info('[Redis] Session store initialized');

        // Migration: drop legacy unique index on ip (replaced by compound {ip, type} index)
        try {
            await mongoose.connection.collection('hynodes').dropIndex('ip_1');
            logger.info('[Migration] Dropped legacy ip_1 unique index from hynodes');
        } catch (_e) {
            // Index already dropped or never existed — safe to ignore
        }

        // Migration: rebuild compound {ip, type} unique index when it exists
        // without a partial filter expression. Virtual nodes have ip=null, so the
        // unique constraint must skip non-string ip values; Mongoose will not
        // rewrite an existing index with new options on its own.
        try {
            const indexes = await mongoose.connection.collection('hynodes').indexes();
            const ipType = indexes.find(idx => idx.name === 'ip_1_type_1');
            if (ipType && !ipType.partialFilterExpression) {
                await mongoose.connection.collection('hynodes').dropIndex('ip_1_type_1');
                logger.info('[Migration] Dropped legacy ip_1_type_1 (non-partial) index');
                await HyNode.syncIndexes();
                logger.info('[Migration] Recreated hynodes indexes with partialFilterExpression');
            }
        } catch (e) {
            logger.warn(`[Migration] hynodes index sync skipped: ${e.message}`);
        }

        // Migration: ensure all users have xrayUuid (for Xray VLESS support)
        const usersWithoutUuid = await HyUser.find({
            $or: [{ xrayUuid: { $exists: false } }, { xrayUuid: null }, { xrayUuid: '' }]
        }).select('_id');
        if (usersWithoutUuid.length > 0) {
            const crypto = require('crypto');
            const bulkOps = usersWithoutUuid.map(u => ({
                updateOne: {
                    filter: { _id: u._id },
                    update: { $set: { xrayUuid: crypto.randomUUID() } }
                }
            }));
            await HyUser.bulkWrite(bulkOps, { ordered: false });
            logger.info(`[Migration] Generated xrayUuid for ${usersWithoutUuid.length} existing users`);
        }

        // Migration: ensure all users have a non-public subscription token.
        const usersWithoutSubscriptionToken = await HyUser.find({
            $or: [
                { subscriptionToken: { $exists: false } },
                { subscriptionToken: null },
                { subscriptionToken: '' },
            ],
        }).select('_id userId');
        if (usersWithoutSubscriptionToken.length > 0) {
            const crypto = require('crypto');
            const bulkOps = usersWithoutSubscriptionToken.map(u => {
                const token = crypto.createHash('sha256')
                    .update(u.userId + crypto.randomBytes(8).toString('hex'))
                    .digest('hex')
                    .substring(0, 16);
                return {
                    updateOne: {
                        filter: { _id: u._id },
                        update: { $set: { subscriptionToken: token } },
                    },
                };
            });
            await HyUser.bulkWrite(bulkOps, { ordered: false });
            logger.info(`[Migration] Generated subscriptionToken for ${usersWithoutSubscriptionToken.length} existing users`);
        }

        // Migration: backfill xray.tlsSource for legacy Xray nodes that were
        // created before the TLS-source picker existed. Any TLS node without
        // an explicit source defaults to 'panel' — matches the new default
        // and keeps existing setups working without manual intervention.
        try {
            const tlsBackfill = await HyNode.updateMany(
                {
                    type: 'xray',
                    'xray.security': 'tls',
                    $or: [
                        { 'xray.tlsSource': { $exists: false } },
                        { 'xray.tlsSource': null },
                        { 'xray.tlsSource': '' },
                    ],
                },
                { $set: { 'xray.tlsSource': 'panel' } }
            );
            if (tlsBackfill?.modifiedCount > 0) {
                logger.info(`[Migration] Backfilled xray.tlsSource='panel' on ${tlsBackfill.modifiedCount} legacy node(s)`);
            }
        } catch (migErr) {
            logger.warn(`[Migration] Xray tlsSource backfill warning: ${migErr.message}`);
        }

        // Migration: mark onboarding as completed for existing installations
        // Prevents the wizard from showing to users who already have nodes set up
        try {
            const Settings = require('./src/models/settingsModel');
            const existingSettings = await Settings.get();
            if (!existingSettings.deployment?.completed) {
                const existingNodeCount = await HyNode.countDocuments();
                if (existingNodeCount > 0) {
                    await Settings.update({ 'deployment.completed': true, 'deployment.completedAt': new Date() });
                    logger.info('[Migration] Marked onboarding as completed (existing installation detected)');
                }
            }
        } catch (migErr) {
            logger.warn(`[Migration] Deployment migration warning: ${migErr.message}`);
        }

        const hwidBackfill = await HyUser.updateMany(
            { hwidMode: { $exists: false } },
            { $set: { hwidMode: 'inherit', hwidEnforceFrom: null } }
        );
        if (hwidBackfill.modifiedCount > 0) {
            logger.info(`[Migration] HWID defaults applied to ${hwidBackfill.modifiedCount} users`);
        }

        require('./src/models/userDeviceModel');

        await reloadSettings();
        await homepageService.init();

        // Boot catchup + arm next-fire-time timer for subscription expiry.
        // Also sweeps over-traffic users one time (migration of dirty state).
        await expireScheduler.init();
        
        const PORT = process.env.PORT || 3000;
        const useCaddy = process.env.USE_CADDY === 'true';
        
        if (useCaddy) {
            const http = require('http');
            const server = http.createServer(app);
            
            setupWebSocketServer(server);
            activeServers.push(server);
            
            server.listen(PORT, () => {
                logger.info(`[Server] HTTP listening on port ${PORT} (behind Caddy)`);
                logger.info(`[Server] Panel: https://${config.PANEL_DOMAIN}/panel`);
            });
        } else {
            // Standalone HTTPS via Greenlock (requires a real public domain
            // and reachable ports 80/443 for the ACME challenge).
            // For local HTTP-only testing use USE_CADDY=true (docker-compose.local.yml).
        logger.info(`[Server] Starting HTTPS for ${config.PANEL_DOMAIN}`);
        
        const Greenlock = require('@root/greenlock-express');
            const greenlockDir = path.join(__dirname, 'greenlock.d');
            
            const livePath = path.join(greenlockDir, 'live', config.PANEL_DOMAIN);
            if (!fs.existsSync(livePath)) {
                fs.mkdirSync(livePath, { recursive: true });
            }
            
            const configPath = path.join(greenlockDir, 'config.json');
        try {
            const glConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const siteExists = glConfig.sites.some(s => s.subject === config.PANEL_DOMAIN);
            
            if (!siteExists) {
                glConfig.sites.push({
                    subject: config.PANEL_DOMAIN,
                    altnames: [config.PANEL_DOMAIN],
                });
            }
            glConfig.defaults.subscriberEmail = config.ACME_EMAIL;
                glConfig.defaults.store = {
                    module: 'greenlock-store-fs',
                    basePath: greenlockDir,
                };
            fs.writeFileSync(configPath, JSON.stringify(glConfig, null, 2));
        } catch (err) {
                logger.warn(`[Greenlock] Config error: ${err.message}`);
        }
        
            const glInstance = Greenlock.init({
            packageRoot: __dirname,
                configDir: greenlockDir,
            maintainerEmail: config.ACME_EMAIL,
            cluster: false,
                staging: false,
            });
            
            glInstance.ready((glx) => {
            const httpServer = glx.httpServer();
            activeServers.push(httpServer);
            httpServer.listen(80, () => {
                    logger.info('[Server] HTTP listening on port 80');
            });
            
            const httpsServer = glx.httpsServer(null, app);
            setupWebSocketServer(httpsServer);
            activeServers.push(httpsServer);
            
            httpsServer.listen(443, () => {
                logger.info('[Server] HTTPS listening on port 443');
                logger.info(`[Server] Panel: https://${config.PANEL_DOMAIN}/panel`);
            });
        });
        }
        
            // Cron jobs
        setupCronJobs();
        
    } catch (err) {
        logger.error(`[Server] Startup failed: ${err.message}`);
        process.exit(1);
    }
}

function setupWebSocketServer(server) {
    const wssTerminal = new WebSocketServer({ noServer: true });
    const wssLogs = new WebSocketServer({ noServer: true });
    const wssBroadcast = new WebSocketServer({ noServer: true });
    const sshTerminal = require('./src/services/sshTerminal');
    const BroadcastSession = require('./src/services/broadcastTerminal');
    const crypto = require('crypto');
    
    server.on('upgrade', (request, socket, head) => {
        const pathname = request.url;

        const fakeRes = {
            writeHead: () => {},
            end: () => {},
            write: () => {},
            getHeader: () => {},
            setHeader: () => {},
        };

        sessionMiddleware(request, fakeRes, () => {
            if (!request.session?.authenticated) {
                logger.warn(`[WS] Unauthorized upgrade attempt: ${request.socket.remoteAddress}`);
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            if (pathname && pathname.startsWith('/ws/terminal/')) {
                wssTerminal.handleUpgrade(request, socket, head, (ws) => {
                    wssTerminal.emit('connection', ws, request);
                });
            } else if (pathname === '/ws/logs') {
                wssLogs.handleUpgrade(request, socket, head, (ws) => {
                    wssLogs.emit('connection', ws, request);
                });
            } else if (pathname === '/ws/broadcast') {
                wssBroadcast.handleUpgrade(request, socket, head, (ws) => {
                    wssBroadcast.emit('connection', ws, request);
                });
            } else {
                socket.destroy();
            }
        });
    });
    
    // SSH Terminal WebSocket
    wssTerminal.on('connection', async (ws, req) => {
        const urlParts = req.url.split('/');
        const nodeId = urlParts[urlParts.length - 1];
        const sessionId = crypto.randomUUID();
        
        logger.info(`[WS] SSH terminal for node ${nodeId}`);
        
        try {
            const node = await HyNode.findById(nodeId);
            
            if (!node) {
                ws.send(JSON.stringify({ type: 'error', message: 'Node not found' }));
                ws.close();
                return;
            }
            
            if (!node.ssh?.password && !node.ssh?.privateKey) {
                ws.send(JSON.stringify({ type: 'error', message: 'SSH credentials not configured' }));
                ws.close();
                return;
            }
            
            await sshTerminal.createSession(sessionId, node, ws);
            ws.send(JSON.stringify({ type: 'connected', sessionId }));
            
            ws.on('message', (message) => {
                try {
                    const msg = JSON.parse(message.toString());
                    
                    switch (msg.type) {
                        case 'input':
                            sshTerminal.write(sessionId, msg.data);
                            break;
                        case 'resize':
                            sshTerminal.resize(sessionId, msg.cols, msg.rows);
                            break;
                    }
                } catch (err) {
                    logger.error(`[WS] Error: ${err.message}`);
                }
            });
            
            ws.on('close', () => {
                logger.info(`[WS] Connection closed for node ${nodeId}`);
                sshTerminal.closeSession(sessionId);
            });
            
        } catch (error) {
            logger.error(`[WS] Terminal error: ${error.message}`);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
            ws.close();
        }
    });
    
    // Broadcast Terminal WebSocket
    wssBroadcast.on('connection', async (ws, req) => {
        logger.info(`[WS] Broadcast terminal connected`);

        const safeSend = (data) => {
            if (ws.readyState === 1) ws.send(JSON.stringify(data));
        };

        const session = new BroadcastSession(ws);
        safeSend({ type: 'ready' });

        ws.on('message', async (message) => {
            try {
                const msg = JSON.parse(message.toString());

                if (msg.type === 'exec') {
                    const command = (msg.command || '').trim();
                    const timeoutMs = typeof msg.timeout === 'number' ? msg.timeout * 1000 : undefined;

                    let nodeIds = msg.nodeIds;
                    let nodes;

                    if (nodeIds === 'all') {
                        nodes = await HyNode.find({}).lean();
                    } else if (Array.isArray(nodeIds) && nodeIds.length > 0) {
                        nodes = await HyNode.find({ _id: { $in: nodeIds } }).lean();
                    } else {
                        safeSend({ type: 'error', message: 'No nodes specified' });
                        return;
                    }

                    // Filter to nodes with SSH credentials, deduplicate by IP
                    const seenIps = new Set();
                    nodes = nodes.filter((n) => {
                        if (!n.ssh?.password && !n.ssh?.privateKey) return false;
                        if (seenIps.has(n.ip)) return false;
                        seenIps.add(n.ip);
                        return true;
                    });

                    if (nodes.length === 0) {
                        safeSend({ type: 'error', message: 'No nodes with SSH credentials found' });
                        return;
                    }

                    logger.info(`[WS] Broadcast exec: "${command.substring(0, 100)}" on ${nodes.length} nodes`);
                    await session.exec(nodes, command, timeoutMs);

                } else if (msg.type === 'cancel') {
                    session.cancel();
                }
            } catch (err) {
                logger.error(`[WS] Broadcast error: ${err.message}`);
                safeSend({ type: 'error', message: err.message });
            }
        });

        ws.on('close', () => {
            logger.info('[WS] Broadcast terminal disconnected');
            session.destroy();
        });

        ws.on('error', () => {
            session.destroy();
        });
    });

    // Real-time Logs WebSocket
    wssLogs.on('connection', (ws) => {
        logger.info(`[WS] Logs stream connected`);
        
        // Send recent logs buffer on connect
        const recentLogs = logger.getRecentLogs();
        ws.send(JSON.stringify({ type: 'history', logs: recentLogs }));
        
        // Subscribe to new logs
        const onLog = (logEntry) => {
            if (ws.readyState === 1) { // WebSocket.OPEN
                ws.send(JSON.stringify({ type: 'log', ...logEntry }));
            }
        };
        
        logger.logEmitter.on('log', onLog);
        
        ws.on('close', () => {
            logger.logEmitter.off('log', onLog);
            logger.info(`[WS] Logs stream disconnected`);
        });
        
        ws.on('error', () => {
            logger.logEmitter.off('log', onLog);
        });
    });
    
    logger.info('[WS] WebSocket server initialized (terminal + logs)');
}

function setupCronJobs() {
    // Collect stats every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
        try {
            logger.debug('[Cron] Collecting stats');
            await syncService.collectAllStats();
            
            // Save stats snapshot for charts
            await statsService.saveHourlySnapshot();
        } catch (error) {
            logger.error(`[Cron] Stats collection failed: ${error.message}`);
        }
    });
    
    // Health check every minute
    cron.schedule('* * * * *', async () => {
        try {
            await syncService.healthCheck();
        } catch (error) {
            logger.error(`[Cron] Health check failed: ${error.message}`);
        }
        try {
            const cascadeService = require('./src/services/cascadeService');
            await cascadeService.healthCheckAll();
        } catch (error) {
            logger.error(`[Cron] Cascade health check failed: ${error.message}`);
        }
    });

    // Panel cert rotation watcher — every 5 minutes.
    // Detects fresh LE cert on disk (Caddy/Greenlock) and re-pushes config.json
    // to every Xray node that masquerades under the panel domain so the inline
    // PEM stays in sync. No-op for setups without a panel domain.
    // Also runs the expire-scheduler watchdog as a safety net in case the
    // in-process timer was dropped by an unexpected fault.
    cron.schedule('*/5 * * * *', async () => {
        try {
            await syncService.checkPanelCertRotation();
        } catch (error) {
            logger.error(`[Cron] Panel cert rotation watcher failed: ${error.message}`);
        }
        try {
            await expireScheduler.processExpired();
            // Re-arm in case the in-process timer was lost (e.g. unhandled
            // crash, missed save without notify). Cheap: single index-covered findOne.
            await expireScheduler.scheduleNext();
        } catch (error) {
            logger.error(`[Cron] Expire watchdog failed: ${error.message}`);
        }
    });
    
    // Save daily snapshot every hour
    cron.schedule('0 * * * *', async () => {
        try {
            logger.debug('[Cron] Saving daily stats snapshot');
            await statsService.saveDailySnapshot();
        } catch (error) {
            logger.error(`[Cron] Daily snapshot failed: ${error.message}`);
        }
    });
    
    // Save monthly snapshot and cleanup at 00:05
    cron.schedule('5 0 * * *', async () => {
        try {
            logger.info('[Cron] Saving monthly stats snapshot');
            await statsService.saveMonthlySnapshot();
            await statsService.cleanup();
        } catch (error) {
            logger.error(`[Cron] Monthly maintenance failed: ${error.message}`);
        }
    });

    // Flush yesterday's UA client stats from Redis to MongoDB at 00:15
    cron.schedule('15 0 * * *', async () => {
        try {
            const uaStatsService = require('./src/services/uaStatsService');
            await uaStatsService.flushYesterday();
            await uaStatsService.cleanup();
        } catch (error) {
            logger.error(`[Cron] UA stats flush failed: ${error.message}`);
        }
    });
    
    // Clean inactive HWID device rows (daily 03:30)
    cron.schedule('30 3 * * *', async () => {
        try {
            const Settings = require('./src/models/settingsModel');
            const hwidDeviceService = require('./src/services/hwidDeviceService');
            const settings = await Settings.get();
            const days = settings?.subscription?.happ?.hwid?.inactiveDeviceCleanupDays ?? 90;
            await hwidDeviceService.cleanupStale(days);
        } catch (error) {
            logger.error(`[Cron] HWID device cleanup failed: ${error.message}`);
        }
    });
    
    // Clean old logs daily at 3:00
    cron.schedule('0 3 * * *', () => {
        try {
            logger.info('[Cron] Cleaning old logs');
            cleanOldLogs(30);
        } catch (error) {
            logger.error(`[Cron] Log cleanup failed: ${error.message}`);
        }
    });
    
    // Check for scheduled backup every hour
    cron.schedule('0 * * * *', async () => {
        try {
            await backupService.scheduledBackup();
        } catch (error) {
            logger.error(`[Cron] Scheduled backup failed: ${error.message}`);
        }
    });
    
    // Initial health check and stats snapshot after 5 seconds
    setTimeout(async () => {
        try {
            logger.info('[Startup] Checking nodes status');
            await syncService.healthCheck();
            
            // Initial stats snapshot
            await statsService.saveHourlySnapshot();
            logger.info('[Startup] Initial stats snapshot saved');
        } catch (error) {
            logger.error(`[Startup] Initial checks failed: ${error.message}`);
        }
    }, 5000);
}

/**
 * Clean logs older than N days
 */
function cleanOldLogs(days) {
    try {
        const logsDir = path.join(__dirname, 'logs');
        
        if (!fs.existsSync(logsDir)) {
            return;
        }
        
        const files = fs.readdirSync(logsDir);
        const now = Date.now();
        const maxAge = days * 24 * 60 * 60 * 1000;
        
        // Active Winston files (skip)
        const activeFiles = ['error.log', 'combined.log'];
        for (let i = 1; i <= 5; i++) {
            activeFiles.push(`combined${i}.log`);
        }
        
        let deleted = 0;
        
        files.forEach(file => {
            if (activeFiles.includes(file)) {
                return;
            }
            
            const filePath = path.join(logsDir, file);
            const stats = fs.statSync(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                fs.unlinkSync(filePath);
                deleted++;
                logger.info(`[Cleanup] Deleted old log: ${file}`);
            }
        });
        
        if (deleted > 0) {
            logger.info(`[Cleanup] Removed ${deleted} old log files`);
        }
    } catch (err) {
        logger.error(`[Cleanup] Failed to clean logs: ${err.message}`);
    }
}

// Graceful shutdown
const activeServers = [];
const FORCE_SHUTDOWN_MS = 10000;

let isShuttingDown = false;
async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`[Server] ${signal} received, shutting down...`);
    await Promise.all(
        activeServers.map(s => new Promise(resolve => s.close(resolve)))
    );
    if (cacheService.isConnected()) {
        await cacheService.redis.quit().catch(() => {});
    }
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
        setTimeout(() => process.exit(1), FORCE_SHUTDOWN_MS).unref();
        shutdown(sig).catch(() => process.exit(1));
    });
}

process.on('unhandledRejection', (reason) => {
    logger.error('[Process] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
    logger.error('[Process] Uncaught exception:', err);
    shutdown('uncaughtException').catch(() => process.exit(1));
});

startServer();
