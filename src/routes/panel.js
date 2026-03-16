/**
 * Роуты для веб-панели управления
 * SSR с EJS шаблонами
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const router = express.Router();

// Multer для загрузки backup файлов
const backupUpload = multer({ 
    dest: '/tmp/backup-uploads/',
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.tar.gz') || file.originalname.endsWith('.tgz')) {
            cb(null, true);
        } else {
            cb(new Error('Только .tar.gz файлы разрешены'));
        }
    }
});
const HyUser = require('../models/hyUserModel');
const HyNode = require('../models/hyNodeModel');
const ServerGroup = require('../models/serverGroupModel');
const Settings = require('../models/settingsModel');
const Admin = require('../models/adminModel');
const ApiKey = require('../models/apiKeyModel');
const webhookService = require('../services/webhookService');
const syncService = require('../services/syncService');
const cryptoService = require('../services/cryptoService');
const cache = require('../services/cacheService');
const nodeSetup = require('../services/nodeSetup');
const NodeSSH = require('../services/nodeSSH');
const sshKeyService = require('../services/sshKeyService');
const { getActiveGroups, invalidateGroupsCache, invalidateSettingsCache } = require('../utils/helpers');
const config = require('../../config');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { createReadStream } = require('fs');
const readline = require('readline');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const ejs = require('ejs');
const os = require('os');
const rpsCounter = require('../middleware/rpsCounter');
const statsService = require('../services/statsService');

const { Client: SSHClient } = require('ssh2');

// Кэш скомпилированных шаблонов (для production)
const templateCache = new Map();

/**
 * Decrypt a stored private key (encrypted AES or legacy plaintext).
 */
function decryptSshPrivateKey(key) {
    try {
        const d = cryptoService.decrypt(key);
        if (d && d.includes('-----BEGIN')) return d;
    } catch (_) {}
    return key;
}

/**
 * Open a direct SSH connection to a node using its stored credentials.
 * @returns {Promise<Client>} connected ssh2 Client
 */
function connectNodeSSH(node) {
    return new Promise((resolve, reject) => {
        const client = new SSHClient();
        const connConfig = {
            host: node.ip,
            port: node.ssh?.port || 22,
            username: node.ssh?.username || 'root',
            readyTimeout: 20000,
        };
        if (node.ssh?.privateKey) {
            connConfig.privateKey = decryptSshPrivateKey(node.ssh.privateKey);
        } else if (node.ssh?.password) {
            connConfig.password = cryptoService.decrypt(node.ssh.password);
        } else {
            return reject(new Error('SSH credentials not configured'));
        }
        client.on('ready', () => resolve(client));
        client.on('error', (err) => reject(err));
        client.connect(connConfig);
    });
}

/**
 * Parse Xray-related form fields from req.body into an xray sub-document object.
 * Handles comma-separated arrays (SNI, shortIds, alpn).
 */
function parseXrayFormFields(body) {
    const xray = {};

    if (body['xray.transport']) xray.transport = body['xray.transport'];
    if (body['xray.security']) xray.security = body['xray.security'];
    if (body['xray.flow'] !== undefined) xray.flow = body['xray.flow'];

    // TLS fingerprint (uTLS)
    if (body['xray.fingerprint']) xray.fingerprint = body['xray.fingerprint'];

    // ALPN (comma-separated)
    if (body['xray.alpn'] !== undefined) {
        const alpnStr = body['xray.alpn'].trim();
        xray.alpn = alpnStr ? alpnStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    }

    // Reality
    if (body['xray.realityDest']) xray.realityDest = body['xray.realityDest'];
    if (body['xray.realityPrivateKey'] !== undefined) xray.realityPrivateKey = body['xray.realityPrivateKey'];
    if (body['xray.realityPublicKey'] !== undefined) xray.realityPublicKey = body['xray.realityPublicKey'];
    if (body['xray.realitySpiderX'] !== undefined) xray.realitySpiderX = body['xray.realitySpiderX'];

    if (body['xray.realitySni']) {
        xray.realitySni = body['xray.realitySni']
            .split(',').map(s => s.trim()).filter(Boolean);
    }
    if (body['xray.realityShortIds'] !== undefined) {
        xray.realityShortIds = body['xray.realityShortIds']
            .split(',').map(s => s.trim());
        if (xray.realityShortIds.length === 0) xray.realityShortIds = [''];
    }

    // WebSocket
    if (body['xray.wsPath'] !== undefined) xray.wsPath = body['xray.wsPath'];
    if (body['xray.wsHost'] !== undefined) xray.wsHost = body['xray.wsHost'];

    // gRPC
    if (body['xray.grpcServiceName']) xray.grpcServiceName = body['xray.grpcServiceName'];

    // XHTTP (SplitHTTP)
    if (body['xray.xhttpPath'] !== undefined) xray.xhttpPath = body['xray.xhttpPath'];
    if (body['xray.xhttpHost'] !== undefined) xray.xhttpHost = body['xray.xhttpHost'];
    if (body['xray.xhttpMode']) xray.xhttpMode = body['xray.xhttpMode'];

    // API port
    if (body['xray.apiPort']) xray.apiPort = parseInt(body['xray.apiPort']) || 61000;

    return xray;
}

// Rate limiter для защиты от brute-force
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 5, // максимум 5 попыток
    message: 'Слишком много попыток входа. Попробуйте через 15 минут.',
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn(`[Panel] Rate limit exceeded for IP: ${req.ip}`);
        res.status(429).render('login', { 
            error: 'Слишком много попыток входа. Попробуйте через 15 минут.' 
        });
    },
});

// Парсинг IP whitelist
function parseIpWhitelist() {
    const whitelist = config.PANEL_IP_WHITELIST || '';
    if (!whitelist.trim()) return null; // Пустой = разрешено всем
    return whitelist.split(',').map(ip => ip.trim()).filter(Boolean);
}

// Проверка IP в whitelist (поддержка CIDR)
function isIpAllowed(clientIp, whitelist) {
    if (!whitelist || whitelist.length === 0) return true;
    
    // Нормализуем IPv6-mapped IPv4
    const normalizedIp = clientIp.replace(/^::ffff:/, '');
    
    for (const entry of whitelist) {
        if (entry.includes('/')) {
            // CIDR нотация
            if (isIpInCidr(normalizedIp, entry)) return true;
        } else {
            // Точное совпадение
            if (normalizedIp === entry) return true;
        }
    }
    return false;
}

// Проверка IP в CIDR диапазоне
function isIpInCidr(ip, cidr) {
    const [range, bits] = cidr.split('/');
    const mask = parseInt(bits);
    
    const ipNum = ipToNum(ip);
    const rangeNum = ipToNum(range);
    
    if (ipNum === null || rangeNum === null) return false;
    
    const maskBits = ~((1 << (32 - mask)) - 1);
    return (ipNum & maskBits) === (rangeNum & maskBits);
}

function ipToNum(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    return parts.reduce((acc, part) => (acc << 8) + parseInt(part), 0) >>> 0;
}

// Middleware: проверка IP whitelist
const checkIpWhitelist = (req, res, next) => {
    const whitelist = parseIpWhitelist();
    if (!whitelist) return next(); // Нет whitelist - пропускаем всех
    
    // Получаем реальный IP (X-Forwarded-For от Caddy или прямой)
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp = forwardedFor 
        ? forwardedFor.split(',')[0].trim()
        : (req.ip || req.connection.remoteAddress || '');
    
    if (!isIpAllowed(clientIp, whitelist)) {
        logger.warn(`[Panel] Access denied for IP: ${clientIp}`);
        return res.status(403).send('Доступ запрещён. Ваш IP не в whitelist.');
    }
    next();
};

// Применяем IP whitelist ко всем роутам панели
router.use(checkIpWhitelist);

// Middleware: проверка авторизации
const requireAuth = (req, res, next) => {
    if (!req.session || !req.session.authenticated) {
        return res.redirect('/panel/login');
    }
    next();
};

// Хелпер для рендера с layout (с кэшированием шаблонов)
const render = (res, template, data = {}) => {
    const isProduction = process.env.NODE_ENV === 'production';
    
    // Получаем или компилируем шаблон
    let compiledTemplate = templateCache.get(template);
    
    if (!compiledTemplate || !isProduction) {
        const templatePath = path.join(__dirname, '../../views', template + '.ejs');
        const templateContent = fs.readFileSync(templatePath, 'utf8');
        compiledTemplate = ejs.compile(templateContent, { filename: templatePath });
        if (isProduction) {
            templateCache.set(template, compiledTemplate);
        }
    }
    
    // Получаем i18n переменные из res.locals (установлены middleware)
    const i18nVars = {
        t: res.locals.t,
        lang: res.locals.lang,
        supportedLangs: res.locals.supportedLangs,
        locales: res.locals.locales,
    };
    
    // Рендерим контент из кэшированного шаблона
    const content = compiledTemplate({ 
        ...data, 
        ...i18nVars,
        baseUrl: config.BASE_URL, 
        config 
    });
    
    // Рендерим layout с контентом
    res.render('layout', {
        ...data,
        ...i18nVars,
        content,
        baseUrl: config.BASE_URL,
        config,
    });
};

// ==================== AUTH ====================

// GET /panel/login - Логин или первичная регистрация
router.get('/login', async (req, res) => {
    if (req.session && req.session.authenticated) {
        return res.redirect('/panel');
    }
    
    // Проверяем есть ли админ в БД
    const hasAdmin = await Admin.hasAdmin();
    
    if (!hasAdmin) {
        // Первый запуск - показываем форму регистрации
        return res.render('setup', { error: null });
    }
    
    res.render('login', { error: null });
});

// POST /panel/setup - Первичная регистрация админа
router.post('/setup', async (req, res) => {
    try {
        // Проверяем что админа ещё нет
        const hasAdmin = await Admin.hasAdmin();
        if (hasAdmin) {
            return res.redirect('/panel/login');
        }
        
        const { username, password, passwordConfirm } = req.body;
        
        // Валидация
        if (!username || username.length < 3) {
            return res.render('setup', { error: 'Логин должен быть минимум 3 символа' });
        }
        if (!password || password.length < 6) {
            return res.render('setup', { error: 'Пароль должен быть минимум 6 символов' });
        }
        if (password !== passwordConfirm) {
            return res.render('setup', { error: 'Пароли не совпадают' });
        }
        
        // Создаём админа
        await Admin.createAdmin(username, password);
        
        logger.info(`[Panel] Administrator created: ${username}`);
        
        // Авторизуем сразу
        req.session.authenticated = true;
        req.session.adminUsername = username.toLowerCase();
        
        res.redirect('/panel');
    } catch (error) {
        logger.error('[Panel] Admin creation error:', error.message);
        res.render('setup', { error: 'Ошибка: ' + error.message });
    }
});

// POST /panel/login (с rate limiting)
router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    
    // Проверяем есть ли админ в БД
    const hasAdmin = await Admin.hasAdmin();
    if (!hasAdmin) {
        return res.redirect('/panel/login');
    }
    
    // Проверяем логин/пароль
    const admin = await Admin.verifyPassword(username, password);
    
    if (admin) {
        req.session.authenticated = true;
        req.session.adminUsername = admin.username;
        logger.info(`[Panel] Successful login: ${admin.username} from IP: ${req.ip}`);
        return res.redirect('/panel');
    }
    
    logger.warn(`[Panel] Failed login attempt: ${username} from IP: ${req.ip}`);
    res.render('login', { error: 'Неверный логин или пароль' });
});

// GET /panel/logout
router.get('/logout', (req, res) => {
    const username = req.session?.adminUsername;
    req.session.destroy();
    if (username) {
        logger.info(`[Panel] Logout: ${username}`);
    }
    res.redirect('/panel/login');
});

// ==================== DASHBOARD ====================

// GET /panel - Dashboard
router.get('/', requireAuth, async (req, res) => {
    try {
        // Получаем счётчики из кэша
        let counts = await cache.getDashboardCounts();
        
        if (!counts) {
            // Если кэша нет — запрашиваем из БД
            const [trafficAgg, usersTotal, usersEnabled, nodesTotal, nodesOnline] = await Promise.all([
                HyUser.aggregate([
                    { $group: { 
                        _id: null, 
                        tx: { $sum: '$traffic.tx' }, 
                        rx: { $sum: '$traffic.rx' } 
                    }}
                ]),
                HyUser.countDocuments(),
                HyUser.countDocuments({ enabled: true }),
                HyNode.countDocuments(),
                HyNode.countDocuments({ status: 'online' }),
            ]);
            
            const trafficStats = trafficAgg[0] || { tx: 0, rx: 0 };
            
            counts = {
                usersTotal,
                usersEnabled,
                nodesTotal,
                nodesOnline,
                trafficStats,
            };
            
            // Сохраняем в кэш на 1 минуту
            await cache.setDashboardCounts(counts);
        }
        
        const { usersTotal, usersEnabled, nodesTotal, nodesOnline, trafficStats } = counts;
        
        const nodes = await HyNode.find({ active: true })
            .select('name ip status onlineUsers maxOnlineUsers groups traffic')
            .populate('groups', 'name color')
            .sort({ name: 1 });
        
        const totalOnline = nodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);
        
        // Общий трафик в байтах
        const totalTrafficBytes = (trafficStats.tx || 0) + (trafficStats.rx || 0);
        
        render(res, 'dashboard', {
            title: 'Dashboard',
            page: 'dashboard',
            stats: {
                users: { total: usersTotal, enabled: usersEnabled },
                nodes: { total: nodesTotal, online: nodesOnline },
                onlineUsers: totalOnline,
                lastSync: syncService.lastSyncTime,
                traffic: {
                    tx: trafficStats.tx || 0,
                    rx: trafficStats.rx || 0,
                    total: totalTrafficBytes,
                },
            },
            nodes,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// ==================== NODES ====================

// GET /panel/nodes - Список нод
router.get('/nodes', requireAuth, async (req, res) => {
    try {
        const CascadeLink = require('../models/cascadeLinkModel');
        const [nodes, groups, linksCount] = await Promise.all([
            HyNode.find().populate('groups', 'name color').sort({ name: 1 }),
            getActiveGroups(),
            CascadeLink.countDocuments({ active: true }),
        ]);

        render(res, 'nodes', {
            title: res.locals.locales.nodes.title,
            page: 'nodes',
            nodes,
            groups,
            linksCount,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// GET /panel/nodes/add - Node creation form
router.get('/nodes/add', requireAuth, async (req, res) => {
    const groups = await getActiveGroups();
    render(res, 'node-form', {
        title: 'New Node',
        page: 'nodes',
        node: null,
        groups,
        cascadeLinks: [],
        error: req.query.error || null,
        panelDomain: config.PANEL_DOMAIN || '',
    });
});

// POST /panel/nodes - Create node
router.post('/nodes', requireAuth, async (req, res) => {
    try {
        const { name, ip } = req.body;

        // Server-side validation
        if (!name || !ip) {
            return res.redirect(`/panel/nodes/add?error=${encodeURIComponent('Name and IP address are required')}`);
        }

        // Check IP uniqueness
        const existing = await HyNode.findOne({ ip });
        if (existing) {
            return res.redirect(`/panel/nodes/add?error=${encodeURIComponent('A node with this IP already exists')}`);
        }

        // Encrypt SSH password
        const sshPassword = req.body['ssh.password'] || '';
        const encryptedPassword = sshPassword ? cryptoService.encrypt(sshPassword) : '';

        // Encrypt SSH private key
        const sshPrivateKeyRaw = req.body['ssh.privateKey'] || '';
        let encryptedPrivateKey = '';
        if (sshPrivateKeyRaw.trim()) {
            if (!sshKeyService.isValidPrivateKey(sshPrivateKeyRaw)) {
                return res.redirect(`/panel/nodes/add?error=${encodeURIComponent('Invalid private key format')}`);
            }
            encryptedPrivateKey = cryptoService.encrypt(sshPrivateKeyRaw.trim());
        }

        // Groups (array of IDs)
        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }

        const nodeType = req.body.type === 'xray' ? 'xray' : 'hysteria';

        // Auto-generate statsSecret if not provided (required for Hysteria stats API)
        const statsSecret = req.body.statsSecret || cryptoService.generateNodeSecret();

        const nodeData = {
            name,
            ip,
            type: nodeType,
            domain: req.body.domain || '',
            sni: req.body.sni || '',
            flag: req.body.flag || '',
            port: parseInt(req.body.port) || 443,
            portRange: req.body.portRange || '20000-50000',
            statsPort: parseInt(req.body.statsPort) || 9999,
            statsSecret,
            groups,
            maxOnlineUsers: parseInt(req.body.maxOnlineUsers) || 0,
            rankingCoefficient: parseFloat(req.body.rankingCoefficient) || 1,
            active: req.body.active === 'on',
            useCustomConfig: req.body.useCustomConfig === 'on',
            customConfig: req.body.customConfig || '',
            cascadeRole: req.body.cascadeRole || 'standalone',
            country: req.body.country || '',
            obfs: {
                type: req.body['obfs.type'] || '',
                password: req.body['obfs.password'] || '',
            },
            ssh: {
                port: parseInt(req.body['ssh.port']) || 22,
                username: req.body['ssh.username'] || 'root',
                password: encryptedPassword,
                privateKey: encryptedPrivateKey,
            },
        };

        if (nodeType === 'xray') {
            nodeData.xray = parseXrayFormFields(req.body);
        }

        const newNode = await HyNode.create(nodeData);
        logger.info(`[Panel] Created ${nodeType} node ${name} (${ip})`);
        res.redirect(`/panel/nodes/${newNode._id}`);
    } catch (error) {
        logger.error(`[Panel] Create node error: ${error.message}`);
        res.redirect(`/panel/nodes/add?error=${encodeURIComponent(error.message)}`);
    }
});

// GET /panel/nodes/:id - Edit node form
router.get('/nodes/:id', requireAuth, async (req, res) => {
    try {
        const CascadeLink = require('../models/cascadeLinkModel');
        const [node, groups, cascadeLinks] = await Promise.all([
            HyNode.findById(req.params.id).populate('groups', 'name color'),
            getActiveGroups(),
            CascadeLink.find({
                $or: [{ portalNode: req.params.id }, { bridgeNode: req.params.id }],
            }).populate('portalNode', 'name ip flag')
              .populate('bridgeNode', 'name ip flag')
              .sort({ createdAt: -1 }),
        ]);

        if (!node) {
            return res.redirect('/panel/nodes');
        }

        render(res, 'node-form', {
            title: `Edit: ${node.name}`,
            page: 'nodes',
            node,
            groups,
            cascadeLinks: cascadeLinks || [],
            error: req.query.error || null,
            panelDomain: config.PANEL_DOMAIN || '',
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/nodes/:id - Update node
router.post('/nodes/:id', requireAuth, async (req, res) => {
    const nodeId = req.params.id;
    try {
        const { name, ip } = req.body;

        if (!name || !ip) {
            return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent('Name and IP address are required')}`);
        }

        // Groups (array of IDs)
        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }

        const nodeType = req.body.type === 'xray' ? 'xray' : 'hysteria';

        const updates = {
            name,
            ip,
            type: nodeType,
            domain: req.body.domain || '',
            sni: req.body.sni || '',
            port: parseInt(req.body.port) || 443,
            portRange: req.body.portRange || '20000-50000',
            statsPort: parseInt(req.body.statsPort) || 9999,
            groups,
            maxOnlineUsers: parseInt(req.body.maxOnlineUsers) || 0,
            rankingCoefficient: parseFloat(req.body.rankingCoefficient) || 1,
            active: req.body.active === 'on',
            useCustomConfig: req.body.useCustomConfig === 'on',
            customConfig: req.body.customConfig || '',
            'obfs.type': req.body['obfs.type'] || '',
            'obfs.password': req.body['obfs.password'] || '',
            flag: req.body.flag || '',
            cascadeRole: req.body.cascadeRole || 'standalone',
            country: req.body.country || '',
            'ssh.port': parseInt(req.body['ssh.port']) || 22,
            'ssh.username': req.body['ssh.username'] || 'root',
        };

        // Only update statsSecret if provided (preserve existing if empty)
        if (req.body.statsSecret) {
            updates.statsSecret = req.body.statsSecret;
        }

        if (nodeType === 'xray') {
            updates.xray = parseXrayFormFields(req.body);
        }

        // Only update password if provided (encrypt it)
        if (req.body['ssh.password']) {
            updates['ssh.password'] = cryptoService.encrypt(req.body['ssh.password']);
        }

        // Handle private key update
        if (req.body['ssh.clearPrivateKey'] === '1') {
            // Explicit clear requested
            updates['ssh.privateKey'] = '';
        } else if (req.body['ssh.privateKey'] && req.body['ssh.privateKey'].trim()) {
            const rawKey = req.body['ssh.privateKey'].trim();
            if (!sshKeyService.isValidPrivateKey(rawKey)) {
                return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent('Invalid private key format')}`);
            }
            updates['ssh.privateKey'] = cryptoService.encrypt(rawKey);
        }
        // If neither provided — keep existing key unchanged

        await HyNode.findByIdAndUpdate(nodeId, { $set: updates });
        res.redirect('/panel/nodes');
    } catch (error) {
        logger.error(`[Panel] Update node error: ${error.message}`);
        res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent(error.message)}`);
    }
});

// POST /panel/nodes/:id/setup - Автонастройка ноды через SSH
router.post('/nodes/:id/setup', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ success: false, error: 'Нода не найдена', logs: [] });
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH данные не настроены', logs: [] });
        }
        
        logger.info(`[Panel] Starting setup for node ${node.name} (type: ${node.type || 'hysteria'})`);
        
        // Запускаем настройку в зависимости от типа ноды
        let result;
        if (node.type === 'xray') {
            result = await nodeSetup.setupXrayNodeWithAgent(node, { restartService: true });
        } else {
            result = await nodeSetup.setupNode(node, {
                installHysteria: true,
                setupPortHopping: true,
                restartService: true,
            });
        }
        
        if (result.success) {
            const updateFields = { status: 'online', lastSync: new Date(), lastError: '', healthFailures: 0 };
            if (node.type !== 'xray') updateFields.useTlsFiles = result.useTlsFiles;
            await HyNode.findByIdAndUpdate(req.params.id, { $set: updateFields });
            res.json({ success: true, message: 'Нода успешно настроена', logs: result.logs || [] });
        } else {
            await HyNode.findByIdAndUpdate(req.params.id, { 
                $set: { status: 'error', lastError: result.error, healthFailures: 0 } 
            });
            res.status(500).json({ success: false, error: result.error, logs: result.logs || [] });
        }
    } catch (error) {
        logger.error(`[Panel] Setup error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message, logs: [`Exception: ${error.message}`] });
    }
});

// POST /panel/nodes/:id/generate-ssh-key - Generate and install ed25519 SSH key
const generateSshKeyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
});

router.post('/nodes/:id/generate-ssh-key', requireAuth, generateSshKeyLimiter, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);

        if (!node) {
            return res.status(404).json({ success: false, error: 'Node not found' });
        }

        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH credentials not configured. Add a password or existing key first.' });
        }

        logger.info(`[Panel] Generating SSH key for node ${node.name}`);

        const conn = await connectNodeSSH(node);

        const { privateKey, publicKey } = sshKeyService.generateEd25519KeyPair();
        await sshKeyService.installPublicKey(conn, publicKey);
        conn.end();

        const encryptedKey = cryptoService.encrypt(privateKey);
        await HyNode.findByIdAndUpdate(req.params.id, {
            $set: { 'ssh.privateKey': encryptedKey },
        });

        logger.info(`[Panel] SSH key installed on ${node.name}`);
        res.json({ success: true, message: 'SSH key generated and installed successfully' });
    } catch (error) {
        logger.error(`[Panel] SSH key generation error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/nodes/:id/stats - Получение системной статистики ноды
router.get('/nodes/:id/stats', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ success: false, error: 'Нода не найдена' });
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH данные не настроены' });
        }
        
        const ssh = new NodeSSH(node);
        await ssh.connect();
        const stats = await ssh.getSystemStats();
        // Don't disconnect - pool manages connections
        
        res.json(stats);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/nodes/:id/speed - Получение текущей скорости сети
router.get('/nodes/:id/speed', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ success: false, error: 'Нода не найдена' });
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH данные не настроены' });
        }
        
        const ssh = new NodeSSH(node);
        await ssh.connect();
        const speed = await ssh.getNetworkSpeed();
        // Don't disconnect - pool manages connections
        
        res.json(speed);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/nodes/:id/get-config - Получение текущего конфига с ноды
router.get('/nodes/:id/get-config', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ success: false, error: 'Нода не найдена' });
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH данные не настроены' });
        }
        
        const conn = await nodeSetup.connectSSH(node);
        // Use appropriate config path based on node type
        const configPath = node.type === 'xray'
            ? '/usr/local/etc/xray/config.json'
            : (node.paths?.config || '/etc/hysteria/config.yaml');
        const result = await nodeSetup.execSSH(conn, `cat ${configPath}`);
        conn.end();
        
        if (result.success) {
            res.json({ success: true, config: result.output });
        } else {
            res.json({ success: false, error: result.error || 'Не удалось прочитать конфиг' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/nodes/:id/logs - Получение логов ноды
router.get('/nodes/:id/logs', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);

        if (!node) {
            return res.status(404).json({ success: false, error: 'Нода не найдена' });
        }

        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH данные не настроены' });
        }

        // Use appropriate function based on node type
        logger.debug(`[Panel] Getting logs for node ${node.name} (type: ${node.type})`);
        const result = node.type === 'xray'
            ? await nodeSetup.getXrayNodeLogs(node, 100)
            : await nodeSetup.getNodeLogs(node, 100);
        res.json(result);
    } catch (error) {
        logger.error(`[Panel] Get logs error for node ${req.params.id}: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== USERS ====================

// GET /panel/users - Список пользователей (с поиском и сортировкой)
router.get('/users', requireAuth, async (req, res) => {
    try {
        const { enabled, group, page = 1, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
        const limit = 50;
        
        const filter = {};
        if (enabled !== undefined) filter.enabled = enabled === 'true';
        if (group) filter.groups = group;
        
        // Поиск по userId или username
        if (search && search.trim()) {
            const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const searchRegex = new RegExp(escaped, 'i');
            filter.$or = [
                { userId: searchRegex },
                { username: searchRegex }
            ];
        }
        
        let users;
        const order = sortOrder === 'asc' ? 1 : -1;
        
        // Если сортировка по трафику - используем aggregation
        if (sortBy === 'traffic') {
            const pipeline = [
                { $match: filter },
                {
                    $addFields: {
                        totalTraffic: { $add: [{ $ifNull: ['$traffic.tx', 0] }, { $ifNull: ['$traffic.rx', 0] }] }
                    }
                },
                { $sort: { totalTraffic: order } },
                { $skip: (page - 1) * limit },
                { $limit: limit }
            ];
            
            const usersAggregated = await HyUser.aggregate(pipeline);
            users = await HyUser.populate(usersAggregated, [
                { path: 'groups', select: 'name color' }
            ]);
        } else {
            // Обычная сортировка
            let sortField = {};
            switch (sortBy) {
                case 'userId':
                    sortField = { userId: order };
                    break;
                case 'username':
                    sortField = { username: order };
                    break;
                case 'enabled':
                    sortField = { enabled: order };
                    break;
                case 'createdAt':
                default:
                    sortField = { createdAt: order };
                    break;
            }
            
            users = await HyUser.find(filter)
                .sort(sortField)
                .skip((page - 1) * limit)
                .limit(limit)
                .populate('groups', 'name color')
                .lean();
        }
        
        const [total, groups] = await Promise.all([
            HyUser.countDocuments(filter),
            getActiveGroups(),
        ]);
        
        render(res, 'users', {
            title: res.locals.locales.users.title,
            page: 'users',
            users,
            groups,
            pagination: {
                page: parseInt(page),
                limit,
                total,
                pages: Math.ceil(total / limit),
            },
            query: req.query,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// GET /panel/users/add - Форма создания пользователя
router.get('/users/add', requireAuth, async (req, res) => {
    const groups = await getActiveGroups();
    render(res, 'user-form', {
        title: res.locals.locales.users.newUser,
        page: 'users',
        groups,
        isEdit: false,
        user: null,
        error: null,
    });
});

// GET /panel/users/:userId/edit - Форма редактирования пользователя
router.get('/users/:userId/edit', requireAuth, async (req, res) => {
    try {
        const [user, groups] = await Promise.all([
            HyUser.findOne({ userId: req.params.userId }).populate('groups', 'name color'),
            getActiveGroups(),
        ]);

        if (!user) {
            return res.redirect('/panel/users');
        }

        render(res, 'user-form', {
            title: `Редактирование ${user.userId}`,
            page: 'users',
            groups,
            user,
            isEdit: true,
            error: null,
        });
    } catch (error) {
        res.status(500).send('Ошибка: ' + error.message);
    }
});

// POST /panel/users - Создание пользователя
router.post('/users', requireAuth, async (req, res) => {
    try {
        const { userId, username, trafficLimitGB, expireDays, expireAt: expireAtRaw, enabled, maxDevices } = req.body;
        
        if (!userId) {
            return res.status(400).send('userId обязателен');
        }
        
        // Проверяем существование
        const existing = await HyUser.findOne({ userId });
        if (existing) {
            return res.status(409).send('Пользователь уже существует');
        }
        
        // Генерируем пароль
        const password = cryptoService.generatePassword(userId);
        
        // Группы (массив ID)
        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }
        
        // Expire
        let expireAt = null;
        const hasExpireAt = typeof expireAtRaw === 'string' && expireAtRaw.trim() !== '';

        if (hasExpireAt) {
            const parsedExpireAt = new Date(expireAtRaw);

            if (Number.isNaN(parsedExpireAt.getTime())) {
                return res.status(400).send('Некорректный формат даты/времени окончания');
            }

            if (parsedExpireAt.getTime() < Date.now()) {
                return res.status(400).send('Дата/время окончания не может быть в прошлом');
            }

            expireAt = parsedExpireAt;
        } else if (expireDays && parseInt(expireDays) > 0) {
            expireAt = new Date();
            expireAt.setDate(expireAt.getDate() + parseInt(expireDays));
        }
        
        // Traffic limit в байтах
        const trafficLimit = trafficLimitGB ? parseInt(trafficLimitGB) * 1024 * 1024 * 1024 : 0;
        
        // Max devices (0 = use group limit, -1 = unlimited)
        const userMaxDevices = parseInt(maxDevices) || 0;
        
        await HyUser.create({
            userId,
            username: username || '',
            password,
            groups,
            enabled: enabled === 'on',
            trafficLimit,
            maxDevices: userMaxDevices,
            expireAt,
            nodes: [], // Ноды автоматически по группам
        });
        
        res.redirect(`/panel/users/${userId}`);
    } catch (error) {
        res.status(500).send('Ошибка: ' + error.message);
    }
});

// POST /panel/users/:userId - Обновление пользователя
router.post('/users/:userId', requireAuth, async (req, res) => {
    try {
        const { username, trafficLimitGB, expireDays, expireAt: expireAtRaw, enabled, maxDevices } = req.body;
        const [user, availableGroups] = await Promise.all([
            HyUser.findOne({ userId: req.params.userId }),
            getActiveGroups(),
        ]);

        if (!user) {
            return res.redirect('/panel/users');
        }

        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }

        const trafficLimit = (parseInt(trafficLimitGB, 10) || 0) * 1024 * 1024 * 1024;
        const userMaxDevices = parseInt(maxDevices, 10) || 0;
        const draftUser = {
            ...user.toObject(),
            username: username || '',
            groups,
            enabled: enabled === 'on',
            trafficLimit,
            maxDevices: userMaxDevices,
            expireAt: expireAtRaw,
        };

        let expireAt = null;
        const hasExpireAt = typeof expireAtRaw === 'string' && expireAtRaw.trim() !== '';

        if (hasExpireAt) {
            const parsedExpireAt = new Date(expireAtRaw);

            if (Number.isNaN(parsedExpireAt.getTime())) {
                draftUser.expireAt = null;
                return render(res, 'user-form', {
                    title: res.locals.t('users.editUser') + ' ' + req.params.userId,
                    page: 'users',
                    groups: availableGroups,
                    user: draftUser,
                    isEdit: true,
                    error: res.locals.t('users.expireAtInvalidError'),
                });
            }

            expireAt = parsedExpireAt;
            draftUser.expireAt = parsedExpireAt;
        } else if (expireDays && parseInt(expireDays, 10) > 0) {
            expireAt = new Date();
            expireAt.setDate(expireAt.getDate() + parseInt(expireDays, 10));
            draftUser.expireAt = expireAt;
        } else {
            draftUser.expireAt = null;
        }

        const updates = {
            enabled: enabled === 'on',
            username: username || '',
            groups,
            trafficLimit,
            expireAt,
            maxDevices: userMaxDevices,
        };

        const wasEnabled = user.enabled;
        const nowEnabled = updates.enabled;

        await HyUser.findOneAndUpdate({ userId: req.params.userId }, { $set: updates });

        await cache.invalidateUser(req.params.userId);
        if (user.subscriptionToken) {
            await cache.invalidateSubscription(user.subscriptionToken);
        }
        await cache.clearDeviceIPs(req.params.userId);
        await cache.invalidateDashboardCounts();

        // Sync with Xray nodes if enabled status changed
        if (wasEnabled !== nowEnabled) {
            const updatedUser = { ...user.toObject(), ...updates };
            if (nowEnabled) {
                // User enabled -> add to all Xray nodes
                syncService.addUserToAllXrayNodes(updatedUser).catch(err => {
                    logger.error(`[Panel] Xray addUser error for ${req.params.userId}: ${err.message}`);
                });
            } else {
                // User disabled -> remove from all Xray nodes
                syncService.removeUserFromAllXrayNodes(updatedUser).catch(err => {
                    logger.error(`[Panel] Xray removeUser error for ${req.params.userId}: ${err.message}`);
                });
            }
        }

        webhookService.emit(webhookService.EVENTS.USER_UPDATED, { userId: req.params.userId, updates });

        res.redirect(`/panel/users/${req.params.userId}`);
    } catch (error) {
        res.status(500).send('Ошибка: ' + error.message);
    }
});

// GET /panel/users/:userId - Детали пользователя
router.get('/users/:userId', requireAuth, async (req, res) => {
    try {
        const [user, allGroups] = await Promise.all([
            HyUser.findOne({ userId: req.params.userId })
                .populate('nodes', 'name ip domain')
                .populate('groups', 'name color'),
            getActiveGroups(),
        ]);
        
        if (!user) {
            return res.redirect('/panel/users');
        }
        
        render(res, 'user-detail', {
            title: `Пользователь ${user.userId}`,
            page: 'users',
            user,
            allGroups,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// ==================== GROUPS ====================

// GET /panel/groups - Список групп
router.get('/groups', requireAuth, async (req, res) => {
    try {
        const groups = await ServerGroup.find().sort({ name: 1 });

        const groupIds = groups.map((group) => group._id);
        let nodeCountMap = new Map();
        let userCountMap = new Map();

        if (groupIds.length > 0) {
            const [nodeCounts, userCounts] = await Promise.all([
                HyNode.aggregate([
                    { $match: { groups: { $in: groupIds } } },
                    { $unwind: '$groups' },
                    { $match: { groups: { $in: groupIds } } },
                    { $group: { _id: '$groups', count: { $sum: 1 } } },
                ]),
                HyUser.aggregate([
                    { $match: { groups: { $in: groupIds } } },
                    { $unwind: '$groups' },
                    { $match: { groups: { $in: groupIds } } },
                    { $group: { _id: '$groups', count: { $sum: 1 } } },
                ]),
            ]);

            nodeCountMap = new Map(nodeCounts.map((item) => [String(item._id), item.count]));
            userCountMap = new Map(userCounts.map((item) => [String(item._id), item.count]));
        }

        const groupsWithCounts = groups.map((group) => ({
            ...group.toObject(),
            nodesCount: nodeCountMap.get(String(group._id)) || 0,
            usersCount: userCountMap.get(String(group._id)) || 0,
        }));
        
        render(res, 'groups', {
            title: res.locals.locales.groups.title,
            page: 'groups',
            groups: groupsWithCounts,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/groups - Создать группу
router.post('/groups', requireAuth, async (req, res) => {
    try {
        const { name, description, color, maxDevices, subscriptionTitle } = req.body;
        
        if (!name || !name.trim()) {
            return res.status(400).send('Название обязательно');
        }
        
        await ServerGroup.create({
            name: name.trim(),
            description: description || '',
            color: color || '#6366f1',
            maxDevices: parseInt(maxDevices) || 0,
            subscriptionTitle: subscriptionTitle?.trim() || '',
        });
        
        // Инвалидируем кэш групп
        await invalidateGroupsCache();
        
        res.redirect('/panel/groups');
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).send('Группа с таким названием уже существует');
        }
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/groups/:id - Обновить группу
router.post('/groups/:id', requireAuth, async (req, res) => {
    try {
        const { name, description, color, active, maxDevices, subscriptionTitle } = req.body;
        
        await ServerGroup.findByIdAndUpdate(req.params.id, {
            $set: {
                name: name?.trim() || '',
                description: description || '',
                color: color || '#6366f1',
                active: active === 'on',
                maxDevices: parseInt(maxDevices) || 0,
                subscriptionTitle: subscriptionTitle?.trim() || '',
            }
        });
        
        // Инвалидируем кэш групп
        await invalidateGroupsCache();
        
        res.redirect('/panel/groups');
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/groups/:id/delete - Удалить группу
router.post('/groups/:id/delete', requireAuth, async (req, res) => {
    try {
        // Удаляем группу из всех нод и пользователей
        await Promise.all([
            HyNode.updateMany({ groups: req.params.id }, { $pull: { groups: req.params.id } }),
            HyUser.updateMany({ groups: req.params.id }, { $pull: { groups: req.params.id } }),
            ServerGroup.findByIdAndDelete(req.params.id),
        ]);
        
        // Инвалидируем кэш групп
        await invalidateGroupsCache();
        
        res.redirect('/panel/groups');
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// ==================== SETTINGS ====================

// GET /panel/settings
router.get('/settings', requireAuth, async (req, res) => {
    const ssl = {
        enabled: !!config.PANEL_DOMAIN,
        domain: config.PANEL_DOMAIN || null,
    };
    
    // Получаем данные админа, настройки и API ключи
    const [admin, settings, apiKeys] = await Promise.all([
        Admin.findOne({ username: req.session.adminUsername }),
        Settings.get(),
        ApiKey.listKeys(),
    ]);
    
    render(res, 'settings', {
        title: res.locals.locales.settings.title,
        page: 'settings',
        ssl,
        admin,
        settings,
        apiKeys,
        validScopes: ApiKey.VALID_SCOPES,
        webhookEvents: Object.values(webhookService.EVENTS),
        message: req.query.message || null,
        error: req.query.error || null,
    });
});

// POST /panel/settings - Сохранение настроек
router.post('/settings', requireAuth, async (req, res) => {
    try {
        const { reloadSettings } = require('../../index');
        
        const updates = {
            'loadBalancing.enabled': req.body['loadBalancing.enabled'] === 'on',
            'loadBalancing.hideOverloaded': req.body['loadBalancing.hideOverloaded'] === 'on',
            // Device limit
            'deviceGracePeriod': parseInt(req.body['deviceGracePeriod']) || 15,
            // Cache TTL
            'cache.subscriptionTTL': parseInt(req.body['cache.subscriptionTTL']) || 3600,
            'cache.userTTL': parseInt(req.body['cache.userTTL']) || 900,
            'cache.onlineSessionsTTL': parseInt(req.body['cache.onlineSessionsTTL']) || 10,
            'cache.activeNodesTTL': parseInt(req.body['cache.activeNodesTTL']) || 30,
            // Rate limits
            'rateLimit.subscriptionPerMinute': parseInt(req.body['rateLimit.subscriptionPerMinute']) || 100,
            // SSH Pool
            'sshPool.enabled': req.body['sshPool.enabled'] === 'on',
            'sshPool.maxIdleTime': parseInt(req.body['sshPool.maxIdleTime']) || 120,
            'sshPool.connectTimeout': parseInt(req.body['sshPool.connectTimeout']) || 15,
            'sshPool.keepAliveInterval': parseInt(req.body['sshPool.keepAliveInterval']) || 30,
            'sshPool.maxRetries': parseInt(req.body['sshPool.maxRetries']) || 2,
            // Node Auth
            'nodeAuth.insecure': req.body['nodeAuth.insecure'] === 'on',
        };
        
        // Webhook settings (only when the dedicated webhook form is submitted)
        if (req.body['_webhookSettings'] !== undefined) {
            updates['webhook.enabled'] = req.body['webhook.enabled'] === 'on';
            updates['webhook.url'] = req.body['webhook.url'] || '';
            // Always update secret (even empty string = clear it intentionally)
            updates['webhook.secret'] = req.body['webhook.secret'] || '';
            // Events: multiple checkboxes with same name
            const rawEvents = req.body['webhook.events'];
            updates['webhook.events'] = rawEvents
                ? (Array.isArray(rawEvents) ? rawEvents : [rawEvents])
                : [];
        }

        // Subscription settings
        if (req.body['_subscriptionSettings'] !== undefined) {
            updates['subscription.supportUrl']     = req.body['subscription.supportUrl'] || '';
            updates['subscription.webPageUrl']     = req.body['subscription.webPageUrl'] || '';
            updates['subscription.happProviderId'] = req.body['subscription.happProviderId'] || '';
            updates['subscription.logoUrl']        = req.body['subscription.logoUrl'] || '';
            updates['subscription.pageTitle']      = req.body['subscription.pageTitle'] || '';
        }

        // Backup settings (если форма бэкапов)
        if (req.body['_backupSettings'] || req.body['backup.enabled'] !== undefined) {
            updates['backup.enabled'] = req.body['backup.enabled'] === 'on';
            updates['backup.intervalHours'] = parseInt(req.body['backup.intervalHours']) || 24;
            updates['backup.keepLast'] = parseInt(req.body['backup.keepLast']) || 7;
            // S3
            updates['backup.s3.enabled'] = req.body['backup.s3.enabled'] === 'on';
            updates['backup.s3.endpoint'] = req.body['backup.s3.endpoint'] || '';
            updates['backup.s3.region'] = req.body['backup.s3.region'] || 'us-east-1';
            updates['backup.s3.bucket'] = req.body['backup.s3.bucket'] || '';
            updates['backup.s3.prefix'] = req.body['backup.s3.prefix'] || 'backups';
            updates['backup.s3.accessKeyId'] = req.body['backup.s3.accessKeyId'] || '';
            // Secret key: только обновляем если введён новый
            if (req.body['backup.s3.secretAccessKey']) {
                updates['backup.s3.secretAccessKey'] = req.body['backup.s3.secretAccessKey'];
            }
            updates['backup.s3.keepLast'] = parseInt(req.body['backup.s3.keepLast']) || 30;
        }
        
        await Settings.update(updates);
        
        // Invalidate settings cache and reload
        await invalidateSettingsCache();
        await reloadSettings();
        
        // Reload SSH pool settings
        const sshPool = require('../services/sshPoolService');
        await sshPool.reloadSettings();
        
        logger.info(`[Panel] Settings updated`);
        
        res.redirect('/panel/settings?message=' + encodeURIComponent('Настройки сохранены'));
    } catch (error) {
        logger.error('[Panel] Settings save error:', error.message);
        res.redirect('/panel/settings?error=' + encodeURIComponent('Ошибка: ' + error.message));
    }
});

// POST /panel/settings/password - Смена пароля
router.post('/settings/password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        
        // Валидация
        if (!currentPassword || !newPassword || !confirmPassword) {
            return res.redirect('/panel/settings?error=' + encodeURIComponent('Заполните все поля'));
        }
        
        if (newPassword.length < 6) {
            return res.redirect('/panel/settings?error=' + encodeURIComponent('Новый пароль должен быть минимум 6 символов'));
        }
        
        if (newPassword !== confirmPassword) {
            return res.redirect('/panel/settings?error=' + encodeURIComponent('Пароли не совпадают'));
        }
        
        // Проверяем текущий пароль
        const admin = await Admin.verifyPassword(req.session.adminUsername, currentPassword);
        if (!admin) {
            return res.redirect('/panel/settings?error=' + encodeURIComponent('Неверный текущий пароль'));
        }
        
        // Меняем пароль
        await Admin.changePassword(req.session.adminUsername, newPassword);
        
        logger.info(`[Panel] Password changed for: ${req.session.adminUsername}`);
        
        res.redirect('/panel/settings?message=' + encodeURIComponent('Пароль успешно изменён'));
    } catch (error) {
        logger.error('[Panel] Password change error:', error.message);
        res.redirect('/panel/settings?error=' + encodeURIComponent('Ошибка: ' + error.message));
    }
});

// POST /panel/settings/reset-traffic - Сброс счетчика трафика для всех пользователей
router.post('/settings/reset-traffic', requireAuth, async (req, res) => {
    try {
        // Сбрасываем трафик у всех пользователей
        const result = await HyUser.updateMany(
            {},
            {
                $set: {
                    'traffic.tx': 0,
                    'traffic.rx': 0,
                    'traffic.lastUpdate': new Date()
                }
            }
        );
        
        logger.warn(`[Panel] Traffic reset for ${result.modifiedCount} users by admin: ${req.session.adminUsername}`);
        
        // Инвалидируем кэш всех пользователей
        const users = await HyUser.find({}).select('userId subscriptionToken').lean();
        const invalidateTasks = users.flatMap((user) => {
            const tasks = [() => cache.invalidateUser(user.userId)];
            if (user.subscriptionToken) {
                tasks.push(() => cache.invalidateSubscription(user.subscriptionToken));
            }
            return tasks;
        });

        const BATCH_SIZE = 100;
        for (let i = 0; i < invalidateTasks.length; i += BATCH_SIZE) {
            await Promise.all(invalidateTasks.slice(i, i + BATCH_SIZE).map((task) => task()));
        }
        
        // Инвалидируем статистику
        await cache.invalidateDashboardCounts();
        await cache.invalidateTrafficStats();
        
        res.json({ 
            success: true, 
            count: result.modifiedCount,
            message: `Трафик сброшен у ${result.modifiedCount} пользователей`
        });
    } catch (error) {
        logger.error('[Panel] Traffic reset error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /panel/settings/reset-stats - Сброс статистики
router.post('/settings/reset-stats', requireAuth, async (req, res) => {
    try {
        const StatsSnapshot = require('../models/statsSnapshotModel');
        const result = await StatsSnapshot.deleteMany({});
        
        logger.warn(`[Panel] Stats reset: ${result.deletedCount} snapshots deleted by admin: ${req.session.adminUsername}`);
        
        // Инвалидируем кэш статистики
        const statsService = require('../services/statsService');
        await statsService.invalidateCache();
        
        res.json({ 
            success: true, 
            count: result.deletedCount,
            message: `Удалено ${result.deletedCount} записей статистики`
        });
    } catch (error) {
        logger.error('[Panel] Stats reset error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /panel/settings/flush-cache - Flush all Redis cache
router.post('/settings/flush-cache', requireAuth, async (req, res) => {
    try {
        const result = await cache.flushAll();
        
        if (result.success) {
            logger.info(`[Panel] Cache flushed by admin: ${req.session.adminUsername}`);
            res.json({ success: true, message: 'Cache cleared' });
        } else {
            res.status(500).json({ success: false, error: result.error || 'Failed to flush cache' });
        }
    } catch (error) {
        logger.error('[Panel] Cache flush error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /panel/nodes/:id/restart - Перезапуск сервиса на ноде
router.post('/nodes/:id/restart', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);

        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }

        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ error: 'SSH данные не настроены' });
        }

        const conn = await nodeSetup.connectSSH(node);
        // Use appropriate service name based on node type
        const serviceName = node.type === 'xray' ? 'xray' : 'hysteria-server';
        const result = await nodeSetup.execSSH(conn, `systemctl restart ${serviceName} && sleep 2 && systemctl is-active ${serviceName}`);
        conn.end();

        const isActive = result.output.trim().includes('active');

        await HyNode.findByIdAndUpdate(req.params.id, {
            $set: { status: isActive ? 'online' : 'error', lastSync: new Date() }
        });

        res.json({ success: isActive, output: result.output });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/system-stats - Статистика системы панели
router.get('/system-stats', requireAuth, async (req, res) => {
    try {
        const cpus = os.cpus();
        const loadAvg = os.loadavg();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const processMemory = process.memoryUsage();
        
        // CPU в процентах - используем load average (мгновенно, без задержек!)
        // load1 / cores * 100 = примерный % загрузки
        const cpuPercent = Math.min(Math.round((loadAvg[0] / cpus.length) * 100), 100);
        
        // RPS/RPM из счетчиков (O(1) операция!)
        const requestStats = rpsCounter.getStats();
        const rps = requestStats.rps;
        const rpm = requestStats.rpm;
        
        // Cache stats (Redis быстрый)
        const cacheStats = await cache.getStats();
        
        // Active connections - берем из кеша dashboard (уже есть!)
        let totalConnections = 0;
        const dashboardCounts = await cache.getDashboardCounts();
        if (dashboardCounts) {
            // Если есть кеш - берем оттуда
            const nodes = await HyNode.find({ active: true }).select('onlineUsers').lean();
            totalConnections = nodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);
        } else {
            // Если нет - быстрый подсчет без aggregate
            const nodes = await HyNode.find({ active: true }).select('onlineUsers').lean();
            totalConnections = nodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);
        }
        
        res.json({
            success: true,
            cpu: {
                cores: cpus.length,
                model: cpus[0]?.model || 'Unknown',
                percent: cpuPercent, // ← NEW!
                load1: loadAvg[0],
                load5: loadAvg[1],
                load15: loadAvg[2],
            },
            mem: {
                total: totalMem,
                used: usedMem,
                free: freeMem,
                percent: Math.round((usedMem / totalMem) * 100),
            },
            process: {
                heapUsed: processMemory.heapUsed,
                heapTotal: processMemory.heapTotal,
                rss: processMemory.rss,
            },
            requests: {
                rps: rps,           // ← NEW!
                rpm: rpm,           // ← NEW!
            },
            connections: totalConnections, // ← NEW!
            cache: cacheStats,              // ← NEW!
            uptime: Math.floor(process.uptime()),
            platform: os.platform(),
            nodeVersion: process.version,
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/logs - Последние логи приложения
router.get('/logs', requireAuth, async (req, res) => {
    try {
        const logsDir = path.join(__dirname, '../../logs');
        let logs = [];

        const files = await getCombinedLogFiles(logsDir);

        // Берём самый свежий файл
        if (files.length > 0) {
            logs = await readLastLogLines(files[0].path, 100);
        }

        res.json({ logs });
    } catch (error) {
        logger.error(`[Panel] Logs read error: ${error.message}`);
        res.json({ logs: [], error: error.message });
    }
});

// GET /panel/logs/search - Поиск по всем лог-файлам
router.get('/logs/search', requireAuth, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const limit = Math.min(parseInt(req.query.limit) || 200, 500);

        if (!q) {
            return res.json({ matches: [], total: 0 });
        }

        const logsDir = path.join(__dirname, '../../logs');
        const files = await getCombinedLogFiles(logsDir);

        const qLower = q.toLowerCase();
        const matches = [];
        let total = 0;

        for (const file of files) {
            const fileMatches = [];
            const rl = readline.createInterface({
                input: createReadStream(file.path, { encoding: 'utf8' }),
                crlfDelay: Infinity,
            });

            for await (const line of rl) {
                if (!line) continue;

                if (line.toLowerCase().includes(qLower)) {
                    total += 1;
                    fileMatches.push(line);

                    // Держим только последние limit совпадений в текущем файле
                    if (fileMatches.length > limit) {
                        fileMatches.shift();
                    }
                }
            }

            // Отдаём новые строки сверху (как и раньше)
            for (let i = fileMatches.length - 1; i >= 0 && matches.length < limit; i -= 1) {
                matches.push(fileMatches[i]);
            }
        }

        res.json({ matches, total });
    } catch (error) {
        logger.error(`[Panel] Logs search error: ${error.message}`);
        res.json({ matches: [], total: 0, error: error.message });
    }
});

async function getCombinedLogFiles(logsDir) {
    try {
        await fsp.access(logsDir);
    } catch {
        return [];
    }

    const dirEntries = await fsp.readdir(logsDir, { withFileTypes: true });
    const logEntries = dirEntries.filter(
        (entry) => entry.isFile() && entry.name.startsWith('combined') && entry.name.endsWith('.log')
    );

    const files = await Promise.all(
        logEntries.map(async (entry) => {
            const fullPath = path.join(logsDir, entry.name);
            const stat = await fsp.stat(fullPath);
            return {
                name: entry.name,
                path: fullPath,
                mtime: stat.mtime,
            };
        })
    );

    return files.sort((a, b) => b.mtime - a.mtime);
}

async function readLastLogLines(filePath, maxLines) {
    const tail = [];
    const rl = readline.createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > maxLines) {
            tail.shift();
        }
    }

    return tail.reverse();
}

// POST /panel/backup - Backup MongoDB и скачать
router.post('/backup', requireAuth, async (req, res) => {
    try {
        const backupDir = path.join(__dirname, '../../backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `hysteria-backup-${timestamp}`;
        const backupPath = path.join(backupDir, backupName);
        const archivePath = path.join(backupDir, `${backupName}.tar.gz`);
        
        // mongodump
        const mongoUri = config.MONGO_URI;
        const dumpCmd = `mongodump --uri="${mongoUri}" --out="${backupPath}" --gzip`;
        
        await execAsync(dumpCmd);
        logger.info(`[Backup] Dump created: ${backupPath}`);
        
        // Создаём tar.gz архив
        const tarCmd = `cd "${backupDir}" && tar -czf "${backupName}.tar.gz" "${backupName}" && rm -rf "${backupName}"`;
        await execAsync(tarCmd);
        logger.info(`[Backup] Archive created: ${archivePath}`);
        
        // Отдаём файл на скачивание
        res.download(archivePath, `${backupName}.tar.gz`, (err) => {
            // Удаляем файл после скачивания (опционально, можно оставить)
            // fs.unlinkSync(archivePath);
            if (err) {
                logger.error(`[Backup] Send error: ${err.message}`);
            }
        });
    } catch (error) {
        logger.error(`[Backup] Error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/restore - Восстановление из backup
router.post('/restore', requireAuth, backupUpload.single('backup'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл backup не загружен' });
    }
    
    const uploadedFile = req.file.path;
    const extractDir = path.join('/tmp', `restore-${Date.now()}`);
    
    try {
        // Создаём директорию для распаковки
        fs.mkdirSync(extractDir, { recursive: true });
        
        // Распаковываем архив
        await execAsync(`tar -xzf "${uploadedFile}" -C "${extractDir}"`);
        logger.info(`[Restore] Archive extracted to ${extractDir}`);
        
        // Ищем папку с дампом (может быть вложенность hysteria-backup-xxx/hysteria/)
        const findDumpPath = (dir) => {
            const items = fs.readdirSync(dir);
            
            // Если есть папка hysteria - это и есть дамп базы
            if (items.includes('hysteria') && fs.statSync(path.join(dir, 'hysteria')).isDirectory()) {
                return dir;
            }
            
            // Если одна папка - ищем внутри
            if (items.length === 1 && fs.statSync(path.join(dir, items[0])).isDirectory()) {
                return findDumpPath(path.join(dir, items[0]));
            }
            
            return dir;
        };
        
        const dumpPath = findDumpPath(extractDir);
        logger.info(`[Restore] Dump path: ${dumpPath}`);
        
        // Проверяем что там есть папка hysteria
        const dumpContents = fs.readdirSync(dumpPath);
        logger.info(`[Restore] Dump contents: ${dumpContents.join(', ')}`);
        
        // mongorestore - указываем путь к папке базы данных
        const mongoUri = config.MONGO_URI;
        const hysteriaDir = path.join(dumpPath, 'hysteria');
        const restoreCmd = `mongorestore --uri="${mongoUri}" --drop --gzip --db=hysteria "${hysteriaDir}"`;
        
        logger.info(`[Restore] DB folder: ${hysteriaDir}`);
        logger.info(`[Restore] Command: ${restoreCmd.replace(mongoUri, 'MONGO_URI')}`);
        
        const { stdout, stderr } = await execAsync(restoreCmd);
        if (stdout) logger.info(`[Restore] stdout: ${stdout}`);
        if (stderr) logger.info(`[Restore] stderr: ${stderr}`);
        
        logger.info(`[Restore] Database restored successfully`);
        
        // Удаляем временные файлы
        fs.unlinkSync(uploadedFile);
        await execAsync(`rm -rf "${extractDir}"`);
        
        res.json({ success: true, message: 'База данных успешно восстановлена' });
    } catch (error) {
        logger.error(`[Restore] Error: ${error.message}`);
        if (error.stdout) logger.error(`[Restore] stdout: ${error.stdout}`);
        if (error.stderr) logger.error(`[Restore] stderr: ${error.stderr}`);
        
        // Очищаем временные файлы
        try {
            if (fs.existsSync(uploadedFile)) fs.unlinkSync(uploadedFile);
            await execAsync(`rm -rf "${extractDir}"`);
        } catch (e) {}
        
        res.status(500).json({ error: error.message });
    }
});

// ==================== OUTBOUNDS ====================

// GET /panel/nodes/:id/outbounds - Управление outbound-ами ноды
router.get('/nodes/:id/outbounds', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.redirect('/panel/nodes');
        }
        
        render(res, 'node-outbounds', {
            title: `Outbounds: ${node.name}`,
            page: 'nodes',
            node,
            message: req.query.message || null,
            error: req.query.error || null,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/nodes/:id/outbounds - Сохранить outbounds и ACL правила
router.post('/nodes/:id/outbounds', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.redirect('/panel/nodes');
        }
        
        // Парсим outbounds из form-data
        // Формат: outbound[0][name], outbound[0][type], outbound[0][addr], ...
        const outbounds = [];
        const rawBody = req.body;
        
        if (rawBody.outbound_name) {
            const names = Array.isArray(rawBody.outbound_name) ? rawBody.outbound_name : [rawBody.outbound_name];
            const types = Array.isArray(rawBody.outbound_type) ? rawBody.outbound_type : [rawBody.outbound_type];
            const addrs = Array.isArray(rawBody.outbound_addr) ? rawBody.outbound_addr : [rawBody.outbound_addr || ''];
            const usernames = Array.isArray(rawBody.outbound_username) ? rawBody.outbound_username : [rawBody.outbound_username || ''];
            const passwords = Array.isArray(rawBody.outbound_password) ? rawBody.outbound_password : [rawBody.outbound_password || ''];
            
            for (let i = 0; i < names.length; i++) {
                const name = (names[i] || '').trim();
                const type = (types[i] || '').trim();
                
                if (!name || !type) continue;
                if (!['direct', 'block', 'socks5', 'http'].includes(type)) continue;
                
                outbounds.push({
                    name,
                    type,
                    addr: (addrs[i] || '').trim(),
                    username: (usernames[i] || '').trim(),
                    password: (passwords[i] || '').trim(),
                });
            }
        }
        
        // Парсим ACL правила (одна строка = одно правило)
        const aclRaw = (rawBody.aclRules || '').trim();
        const aclRules = aclRaw
            ? aclRaw.split('\n').map(r => r.trim()).filter(Boolean)
            : [];
        
        await HyNode.findByIdAndUpdate(req.params.id, {
            $set: { outbounds, aclRules },
        });
        
        logger.info(`[Panel] Outbounds updated for node: ${node.name} (${outbounds.length} outbounds, ${aclRules.length} ACL rules)`);
        
        res.redirect(`/panel/nodes/${req.params.id}/outbounds?message=` + encodeURIComponent('Outbounds сохранены'));
    } catch (error) {
        logger.error('[Panel] Outbounds save error:', error.message);
        res.redirect(`/panel/nodes/${req.params.id}/outbounds?error=` + encodeURIComponent('Ошибка: ' + error.message));
    }
});

// GET /panel/nodes/:id/terminal - SSH терминал
router.get('/nodes/:id/terminal', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.redirect('/panel/nodes');
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).send('SSH данные не настроены для этой ноды');
        }
        
        res.render('terminal', { node });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// GET /panel/network - Redirect to nodes page (network map is a tab there)
router.get('/network', requireAuth, (req, res) => {
    res.redirect('/panel/nodes');
});

// ==================== STATS ====================

// GET /panel/stats - Stats page
router.get('/stats', requireAuth, async (req, res) => {
    try {
        const summary = await statsService.getSummary();
        
        render(res, 'stats', {
            title: res.locals.locales.stats.title,
            page: 'stats',
            summary,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// GET /panel/stats/api/summary - Сводная статистика
router.get('/stats/api/summary', requireAuth, async (req, res) => {
    try {
        const summary = await statsService.getSummary();
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/online - Данные для графика онлайна
router.get('/stats/api/online', requireAuth, async (req, res) => {
    try {
        const period = req.query.period || '24h';
        const data = await statsService.getOnlineChart(period);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/traffic - Данные для графика трафика
router.get('/stats/api/traffic', requireAuth, async (req, res) => {
    try {
        const period = req.query.period || '24h';
        const data = await statsService.getTrafficChart(period);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/nodes - Данные для графика нод
router.get('/stats/api/nodes', requireAuth, async (req, res) => {
    try {
        const period = req.query.period || '24h';
        const data = await statsService.getNodesChart(period);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/stats/cleanup - Очистка старых данных (ручной запуск)
router.post('/stats/cleanup', requireAuth, async (req, res) => {
    try {
        const result = await statsService.cleanup();
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/ssh-pool - Статистика SSH пула
router.get('/stats/api/ssh-pool', requireAuth, async (req, res) => {
    try {
        const sshPool = require('../services/sshPoolService');
        res.json(sshPool.getStats());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== BACKUP SETTINGS ====================

// POST /panel/settings/create-backup - Создать бэкап сейчас
router.post('/settings/create-backup', requireAuth, async (req, res) => {
    try {
        const backupService = require('../services/backupService');
        const settings = await Settings.get();
        
        const result = await backupService.createBackup(settings);
        
        res.json({
            success: true,
            filename: result.filename,
            size: result.sizeMB,
        });
    } catch (error) {
        logger.error(`[Backup] Manual backup error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/settings/test-s3 - Проверить подключение к S3
router.post('/settings/test-s3', requireAuth, async (req, res) => {
    try {
        const backupService = require('../services/backupService');
        const { endpoint, region, bucket, accessKeyId, secretAccessKey } = req.body;
        
        if (!bucket || !accessKeyId || !secretAccessKey) {
            return res.status(400).json({ error: 'Bucket, Access Key и Secret Key обязательны' });
        }
        
        const result = await backupService.testS3Connection({
            endpoint,
            region: region || 'us-east-1',
            bucket,
            accessKeyId,
            secretAccessKey,
        });
        
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/settings/backups - Список локальных бэкапов
router.get('/settings/backups', requireAuth, async (req, res) => {
    try {
        const backupService = require('../services/backupService');
        const backups = await backupService.listBackups();
        res.json({ backups });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/settings/backups-s3 - Список бэкапов в S3
router.get('/settings/backups-s3', requireAuth, async (req, res) => {
    try {
        const backupService = require('../services/backupService');
        const settings = await Settings.get();
        
        if (!settings?.backup?.s3?.enabled) {
            return res.json({ backups: [], error: 'S3 not configured' });
        }
        
        const backups = await backupService.listS3Backups(settings);
        res.json({ backups });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/settings/restore-backup - Восстановление из бэкапа (локального или S3)
router.post('/settings/restore-backup', requireAuth, async (req, res) => {
    try {
        const backupService = require('../services/backupService');
        const settings = await Settings.get();
        const { source, identifier } = req.body;
        
        if (!source || !identifier) {
            return res.status(400).json({ error: 'Source and identifier required' });
        }
        
        if (source !== 'local' && source !== 's3') {
            return res.status(400).json({ error: 'Invalid source' });
        }
        
        if (source === 's3' && !settings?.backup?.s3?.enabled) {
            return res.status(400).json({ error: 'S3 not configured' });
        }
        
        logger.info(`[Restore] Starting restore from ${source}: ${identifier}`);
        
        await backupService.restoreBackup(settings, source, identifier);
        
        logger.info(`[Restore] Completed successfully`);
        
        res.json({ success: true, message: 'Database restored successfully' });
    } catch (error) {
        logger.error(`[Restore] Error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ==================== API KEYS ====================

// POST /panel/api-keys - Create a new API key (returns plaintext key once)
router.post('/api-keys', requireAuth, async (req, res) => {
    try {
        const { name, scopes, allowedIPs, rateLimit, expiresAt } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Name is required' });
        }

        // Scopes: checkbox array or single value
        const scopesArr = scopes
            ? (Array.isArray(scopes) ? scopes : [scopes])
            : [];

        // Validate scopes
        const invalidScopes = scopesArr.filter(s => !ApiKey.VALID_SCOPES.includes(s));
        if (invalidScopes.length > 0) {
            return res.status(400).json({ error: `Invalid scopes: ${invalidScopes.join(', ')}` });
        }

        const allowedIPsArr = allowedIPs
            ? allowedIPs.split('\n').map(s => s.trim()).filter(Boolean)
            : [];

        const { doc, plainKey } = await ApiKey.createKey({
            name: name.trim(),
            scopes: scopesArr,
            allowedIPs: allowedIPsArr,
            rateLimit: parseInt(rateLimit) || 60,
            expiresAt: expiresAt || null,
            createdBy: req.session.adminUsername,
        });

        logger.info(`[Panel] API key created: "${doc.name}" (${doc.keyPrefix}...) by ${req.session.adminUsername}`);

        res.json({ success: true, key: plainKey, doc });
    } catch (error) {
        logger.error(`[Panel] API key create error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/api-keys/:id/toggle - Enable/disable a key
router.post('/api-keys/:id/toggle', requireAuth, async (req, res) => {
    try {
        const key = await ApiKey.findById(req.params.id);
        if (!key) {
            return res.status(404).json({ error: 'API key not found' });
        }

        key.active = !key.active;
        await key.save();

        logger.info(`[Panel] API key ${key.keyPrefix}... ${key.active ? 'enabled' : 'disabled'} by ${req.session.adminUsername}`);
        res.json({ success: true, active: key.active });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/api-keys/:id/delete - Delete a key
router.post('/api-keys/:id/delete', requireAuth, async (req, res) => {
    try {
        const key = await ApiKey.findByIdAndDelete(req.params.id);
        if (!key) {
            return res.status(404).json({ error: 'API key not found' });
        }

        logger.info(`[Panel] API key "${key.name}" (${key.keyPrefix}...) deleted by ${req.session.adminUsername}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/settings/test-webhook - Send test webhook
router.post('/settings/test-webhook', requireAuth, async (req, res) => {
    try {
        const { url, secret } = req.body;

        if (!url || !url.trim()) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const result = await webhookService.test(url.trim(), secret || '');

        if (result.success) {
            logger.info(`[Panel] Webhook test OK: ${url} (HTTP ${result.status})`);
            res.json({ success: true, status: result.status });
        } else {
            res.status(400).json({ success: false, error: result.error, status: result.status });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;