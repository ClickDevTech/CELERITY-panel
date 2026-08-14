const express = require('express');
const router = express.Router();

const HyNode = require('../../models/hyNodeModel');
const HyUser = require('../../models/hyUserModel');
const ServerGroup = require('../../models/serverGroupModel');
const Settings = require('../../models/settingsModel');
const cryptoService = require('../../services/cryptoService');
const syncService = require('../../services/syncService');
const configGenerator = require('../../services/configGenerator');
const nodeSetup = require('../../services/nodeSetup');
const { isSameVpsAsPanel } = nodeSetup;
const NodeSSH = require('../../services/nodeSSH');
const sshKeyService = require('../../services/sshKeyService');
const cache = require('../../services/cacheService');
const cascadeService = require('../../services/cascadeService');
const statsService = require('../../services/statsService');
const uaStatsService = require('../../services/uaStatsService');
const { getActiveGroups, invalidateNodesCache } = require('../../utils/helpers');
const { buildNodeUiMeta } = require('../../utils/nodeUi');
const config = require('../../../config');
const logger = require('../../utils/logger');

const {
    render,
    parseXrayFormFields,
    validateXrayFormFields,
    ensureExtraInboundRealityKeys,
    resolveManualKeyPlaceholder,
    sanitizeXrayForRender,
    parseBool,
    parseHysteriaFormFields,
    getHysteriaAclInlineState,
    validateHysteriaFormFields,
    buildSshKeyFilename,
    connectNodeSSH,
    generateSshKeyLimiter,
    sniScanLimiter,
    buildClonedNodePrefill,
} = require('./helpers');

const sniScanner = require('../../services/sniScanner');

/**
 * Parse virtual-node form fields and apply them to nodeData.
 * Returns an error string on validation failure, otherwise null.
 */
function applyVirtualFormFields(nodeData, body) {
    const selectMode = body['virtual.selectMode'] === 'group' ? 'group' : 'manual';
    const strategy = ['random', 'roundRobin', 'leastPing', 'leastLoad'].includes(body['virtual.strategy'])
        ? body['virtual.strategy']
        : 'leastLoad';

    let sources = [];
    if (selectMode === 'manual') {
        const raw = body['virtual.sources'] || body['virtual.sources[]'];
        if (Array.isArray(raw)) sources = raw.filter(Boolean);
        else if (raw) sources = [raw];
    }

    const sourceGroup = selectMode === 'group' ? (body['virtual.sourceGroup'] || null) : null;

    if (selectMode === 'manual' && sources.length === 0) {
        return 'Virtual node: select at least one source node';
    }
    if (selectMode === 'group' && !sourceGroup) {
        return 'Virtual node: select a source group';
    }

    nodeData.virtual = {
        selectMode,
        sources,
        sourceGroup,
        strategy,
        fallbackToFirst: body['virtual.fallbackToFirst'] === 'on',
        observatory: {
            destination: (body['virtual.observatory.destination'] || '').trim() || 'http://www.gstatic.com/generate_204',
            connectivity: (body['virtual.observatory.connectivity'] || '').trim(),
            interval: (body['virtual.observatory.interval'] || '').trim() || '1m',
            timeout: (body['virtual.observatory.timeout'] || '').trim() || '5s',
            sampling: parseInt(body['virtual.observatory.sampling'], 10) || 3,
        },
    };
    return null;
}

// ==================== DASHBOARD ====================

// GET /panel - Dashboard
router.get('/', async (req, res) => {
    try {
        let counts = await cache.getDashboardCounts();
        
        if (!counts) {
            // Virtual nodes are excluded from dashboard counts: they have no
            // remote service to be "online" and would otherwise inflate
            // nodesTotal while never contributing to nodesOnline.
            const realNodeFilter = { type: { $ne: 'virtual' } };
            const [trafficAgg, usersTotal, usersEnabled, nodesTotal, nodesOnline] = await Promise.all([
                HyUser.aggregate([
                    { $match: { isProbe: { $ne: true } } },
                    { $group: { 
                        _id: null, 
                        tx: { $sum: '$traffic.tx' }, 
                        rx: { $sum: '$traffic.rx' } 
                    }}
                ]),
                HyUser.countDocuments({ isProbe: { $ne: true } }),
                HyUser.countDocuments({ enabled: true, isProbe: { $ne: true } }),
                HyNode.countDocuments(realNodeFilter),
                HyNode.countDocuments({ ...realNodeFilter, status: 'online' }),
            ]);
            
            const trafficStats = trafficAgg[0] || { tx: 0, rx: 0 };
            
            counts = {
                usersTotal,
                usersEnabled,
                nodesTotal,
                nodesOnline,
                trafficStats,
            };
            
            await cache.setDashboardCounts(counts);
        }
        
        const { usersTotal, usersEnabled, nodesTotal, nodesOnline, trafficStats } = counts;

        // Virtual nodes are not shown in the dashboard's nodes table either —
        // they are an abstraction over real sibling nodes and would only add
        // noise (no IP, always offline, no traffic of their own).
        const nodes = await HyNode.find({ active: true, type: { $ne: 'virtual' } })
            .select('name ip status onlineUsers maxOnlineUsers groups traffic type flag rankingCoefficient comment')
            .populate('groups', 'name color')
            .sort({ rankingCoefficient: 1, name: 1 });
        
        const totalOnline = nodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);
        
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

/**
 * Per-node view of the most recent probe verdicts, for the compact badge in the
 * list. One aggregation covers the whole page, so the badge costs a single
 * query no matter how many nodes are shown.
 */
async function buildProbeSummary() {
    const ProbeResult = require('../../models/probeResultModel');
    const since = new Date(Date.now() - 30 * 60 * 1000);

    const rows = await ProbeResult.aggregate([
        { $match: { bucket: 'raw', ts: { $gte: since } } },
        { $sort: { ts: -1 } },
        {
            $group: {
                _id: { nodeId: '$nodeId', probeId: '$probeId', inboundId: '$inboundId' },
                ok: { $first: '$ok' },
                attempts: { $first: '$attempts' },
                lastCode: { $first: '$lastCode' },
            },
        },
        {
            $group: {
                _id: '$_id.nodeId',
                checks: { $sum: 1 },
                failing: { $sum: { $cond: [{ $eq: ['$ok', 0] }, 1, 0] } },
                codes: { $addToSet: '$lastCode' },
            },
        },
    ]);

    const summary = {};
    for (const row of rows) {
        summary[String(row._id)] = {
            checks: row.checks,
            failing: row.failing,
            code: (row.codes || []).find((c) => c) || '',
        };
    }
    return summary;
}

// GET /panel/nodes - Node list
router.get('/nodes', async (req, res) => {
    try {
        const CascadeLink = require('../../models/cascadeLinkModel');
        const [nodes, groups, linksCount, settings] = await Promise.all([
            HyNode.find().populate('groups', 'name color').sort({ rankingCoefficient: 1, name: 1 }),
            getActiveGroups(),
            CascadeLink.countDocuments({ active: true }),
            Settings.get(),
        ]);

        // Build a map of IP → protocol count so the template can show dual-protocol badges
        const ipProtocolCount = {};
        nodes.forEach(n => { ipProtocolCount[n.ip] = (ipProtocolCount[n.ip] || 0) + 1; });

        const probeSummary = settings?.probes?.enabled ? await buildProbeSummary() : {};

        render(res, 'nodes', {
            title: res.locals.locales.nodes.title,
            page: 'nodes',
            nodes,
            groups,
            linksCount,
            ipProtocolCount,
            probeSummary,
            loadBalancingEnabled: !!(settings?.loadBalancing?.enabled),
            panelDomain: config.PANEL_DOMAIN || '',
            buildNodeUiMeta,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// GET /panel/nodes/add - Node creation form
// Supports ?cloneFrom=<nodeId> to pre-fill IP, groups, flag and country from an
// existing node and switch to the opposite protocol (paired protocol on the
// same host). Supports ?cloneConfig=<nodeId> to copy protocol/config fields
// onto a new create form, leaving IP/SSH/secrets empty (issue #117).
router.get('/nodes/add', async (req, res) => {
    try {
        const [groups, settings, candidateNodes] = await Promise.all([
            getActiveGroups(),
            Settings.get(),
            // Source candidates for virtual nodes — exclude virtual to prevent cycles.
            HyNode.find({ type: { $ne: 'virtual' } })
                .select('_id name flag type active')
                .sort({ name: 1 })
                .lean(),
        ]);

        let prefillNode = null;
        if (req.query.cloneFrom) {
            const source = await HyNode.findById(req.query.cloneFrom)
                .select('ip flag country groups type')
                .populate('groups', '_id name color')
                .lean();
            // Virtual nodes can't seed a sibling protocol — they have no IP/transport.
            if (source && source.type !== 'virtual') {
                // Flip the protocol: if source is hysteria → suggest xray, and vice-versa
                prefillNode = {
                    ip: source.ip,
                    flag: source.flag || '',
                    country: source.country || '',
                    groups: source.groups || [],
                    type: source.type === 'xray' ? 'hysteria' : 'xray',
                };
            }
        } else if (req.query.cloneConfig) {
            try {
                // Do not exclude `xray.accessLogs` here: the schema already
                // marks `accessLogs.ingestTokenEncrypted` as select:false, and
                // projecting both the parent and a child as 0 is a Mongo
                // path collision — the query throws, the catch swallowed it,
                // and the create form opened empty.
                const source = await HyNode.findById(req.query.cloneConfig)
                    .select('-ssh.password -ssh.privateKey -statsSecret -xray.agentToken')
                    .populate('groups', '_id name color')
                    .lean();
                prefillNode = buildClonedNodePrefill(source);
            } catch (cloneErr) {
                logger.warn(`[Panel] cloneConfig ignored: ${cloneErr.message}`);
            }
        }

        // Pre-fill a fresh Reality keypair so a newly opened Xray form already has
        // valid keys. Generated locally (no SSH/xray dependency); only persisted if
        // the operator actually submits an Xray node with Reality. Passed separately
        // (not via `node`) to keep the form's create-vs-edit detection intact.
        const defaultRealityKeys = cryptoService.generateX25519KeysLocal();

        render(res, 'node-form', {
            title: res.locals.t('nodes.newNode'),
            page: 'nodes',
            node: prefillNode,
            defaultRealityKeys,
            groups,
            candidateNodes,
            cascadeLinks: [],
            error: req.query.error || null,
            panelDomain: config.PANEL_DOMAIN || '',
            panelAcmeEmail: config.ACME_EMAIL || '',
            lastInitScript: settings?.lastInitScript || '',
        });
    } catch (error) {
        logger.error('[Panel] GET /nodes/add error:', error.message);
        res.status(500).send('Error: ' + error.message);
    }
});

// PATCH /panel/nodes/reorder - Bulk-update rankingCoefficient from drag-and-drop
router.patch('/nodes/reorder', async (req, res) => {
    try {
        const order = req.body.order;

        if (!Array.isArray(order) || order.length === 0 || order.length > 500) {
            return res.status(400).json({ success: false, error: 'Invalid order array' });
        }

        const mongoose = require('mongoose');
        const bulk = [];

        for (const item of order) {
            if (!mongoose.Types.ObjectId.isValid(item.id)) continue;
            const pos = parseInt(item.position, 10);
            if (!Number.isFinite(pos) || pos < 0) continue;
            bulk.push({
                updateOne: {
                    filter: { _id: new mongoose.Types.ObjectId(item.id) },
                    update: { $set: { rankingCoefficient: pos } },
                },
            });
        }

        if (bulk.length === 0) {
            return res.status(400).json({ success: false, error: 'No valid entries' });
        }

        const result = await HyNode.bulkWrite(bulk, { ordered: false });
        logger.info(`[Panel] Reorder: ${bulk.length} ops, matched=${result.matchedCount}, modified=${result.modifiedCount}`);

        if (result.matchedCount === 0) {
            return res.status(400).json({ success: false, error: `No nodes matched (${bulk.length} ops sent)` });
        }

        await invalidateNodesCache();

        res.json({ success: true, matched: result.matchedCount, modified: result.modifiedCount });
    } catch (error) {
        logger.error(`[Panel] Reorder nodes error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /panel/nodes - Create node
router.post('/nodes', async (req, res) => {
    try {
        const { name } = req.body;
        const nodeType = ['xray', 'virtual'].includes(req.body.type) ? req.body.type : 'hysteria';
        const ip = req.body.ip || '';

        if (!name) {
            return res.redirect(`/panel/nodes/add?error=${encodeURIComponent('Name is required')}`);
        }
        if (nodeType !== 'virtual' && !ip) {
            return res.redirect(`/panel/nodes/add?error=${encodeURIComponent('IP address is required')}`);
        }

        // Ensure no duplicate node for the same IP + protocol type (skipped for virtual: no IP).
        if (nodeType !== 'virtual') {
            const existing = await HyNode.findOne({ ip, type: nodeType });
            if (existing) {
                return res.redirect(`/panel/nodes/add?error=${encodeURIComponent(`A ${nodeType} node with this IP already exists`)}`);
            }
        }

        const sshPassword = req.body['ssh.password'] || '';
        const encryptedPassword = sshPassword ? cryptoService.encrypt(sshPassword) : '';

        const sshPrivateKeyRaw = req.body['ssh.privateKey'] || '';
        let encryptedPrivateKey = '';
        if (sshPrivateKeyRaw.trim()) {
            if (!sshKeyService.isValidPrivateKey(sshPrivateKeyRaw)) {
                return res.redirect(`/panel/nodes/add?error=${encodeURIComponent('Invalid private key format')}`);
            }
            encryptedPrivateKey = cryptoService.encrypt(sshPrivateKeyRaw.trim());
        }

        // Inherit SSH credentials from sibling node (same IP, different protocol) if caller left them blank
        const callerProvidedSsh = !!(encryptedPassword || encryptedPrivateKey);
        let siblingSsh = null;
        if (!callerProvidedSsh) {
            const sibling = await HyNode.findOne({ ip, type: { $ne: nodeType } }).select('ssh').lean();
            siblingSsh = sibling?.ssh || null;
        }

        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }

        const statsSecret = req.body.statsSecret || cryptoService.generateNodeSecret();

        // Resolve SSH: use provided values, or fall back to sibling node values
        const resolvedSsh = {
            port: parseInt(req.body['ssh.port']) || siblingSsh?.port || 22,
            username: req.body['ssh.username'] || siblingSsh?.username || 'root',
            password: encryptedPassword || siblingSsh?.password || '',
            privateKey: encryptedPrivateKey || siblingSsh?.privateKey || '',
        };

        const nodeData = {
            name,
            ip: nodeType === 'virtual' ? null : ip,
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
            comment: typeof req.body.comment === 'string'
                ? req.body.comment.trim().slice(0, 500)
                : '',
            initScript: req.body.initScript || '',
            obfs: {
                type: req.body['obfs.type'] || '',
                password: req.body['obfs.password'] || '',
            },
            ssh: resolvedSsh,
        };

        if (nodeType === 'xray') {
            nodeData.xray = parseXrayFormFields(req.body);
            const xrayError = validateXrayFormFields(nodeData.xray, nodeData);
            if (xrayError) {
                return res.redirect(`/panel/nodes/add?error=${encodeURIComponent(xrayError)}`);
            }
            ensureExtraInboundRealityKeys(nodeData.xray);
            if (nodeData.cascadeRole !== 'bridge' && !nodeData.xray.agentToken) {
                nodeData.xray.agentToken = nodeSetup.generateAgentToken();
            }
        } else if (nodeType === 'virtual') {
            const virtualError = applyVirtualFormFields(nodeData, req.body);
            if (virtualError) {
                return res.redirect(`/panel/nodes/add?error=${encodeURIComponent(virtualError)}`);
            }
        } else {
            const hyFields = parseHysteriaFormFields(req.body);
            const hyValidationError = validateHysteriaFormFields(hyFields);
            if (hyValidationError) {
                return res.redirect(`/panel/nodes/add?error=${encodeURIComponent(hyValidationError)}`);
            }
            delete hyFields.acmeDnsConfigValid;
            Object.assign(nodeData, hyFields);
        }

        const newNode = await HyNode.create(nodeData);
        logger.info(`[Panel] Created ${nodeType} node ${name} (${ip})`);
        // Invalidate active-nodes, subscription, and dashboard caches so changes are reflected immediately
        await invalidateNodesCache();
        res.redirect(`/panel/nodes/${newNode._id}`);
    } catch (error) {
        logger.error(`[Panel] Create node error: ${error.message}`);
        res.redirect(`/panel/nodes/add?error=${encodeURIComponent(error.message)}`);
    }
});

// POST /panel/nodes/scan-sni - Stream TLS 1.3+H2 scan results as SSE
router.post('/nodes/scan-sni', sniScanLimiter, async (req, res) => {
    const ip      = String(req.body.ip      || '').trim();
    const port    = Math.min(65535, Math.max(1,   parseInt(req.body.port,    10) || 443));
    const threads = Math.min(200,   Math.max(1,   parseInt(req.body.threads, 10) || 50));
    const timeout = Math.min(30,    Math.max(2,   parseInt(req.body.timeout, 10) || 5));

    if (!sniScanner.isValidIpv4(ip)) {
        return res.status(400).json({ error: 'Invalid IPv4 address' });
    }

    res.setHeader('Content-Type',      'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.flushHeaders();

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const send = (type, data = {}) => {
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
            // Force flush through compression middleware if present
            if (typeof res.flush === 'function') res.flush();
        }
    };

    try {
        await sniScanner.scanRange({
            ip,
            port,
            threads,
            timeout,
            signal:      controller.signal,
            onResult:    r             => send('result',   r),
            onProgress:  (done, total) => send('progress', { done, total }),
            onVerifying: ()            => send('verifying'),
        });
        send('done');
    } catch (err) {
        logger.error(`[SNI Scan] ${err.message}`);
        send('error', { message: err.message });
    } finally {
        res.end();
    }
});

// POST /panel/nodes/preview-config - Generate config preview from current form values
router.post('/nodes/preview-config', async (req, res) => {
    try {
        const nodeType = req.body.type === 'xray' ? 'xray' : 'hysteria';
        if (nodeType !== 'hysteria') {
            return res.status(400).json({ success: false, error: 'Preview config supports only Hysteria nodes' });
        }

        const hyFields = parseHysteriaFormFields(req.body);
        const hyValidationError = validateHysteriaFormFields(hyFields);
        if (hyValidationError) {
            return res.status(400).json({ success: false, error: hyValidationError });
        }
        delete hyFields.acmeDnsConfigValid;

        const nodeData = {
            type: 'hysteria',
            port: parseInt(req.body.port, 10) || 443,
            domain: (req.body.domain || '').trim(),
            sni: (req.body.sni || '').trim(),
            useTlsFiles: parseBool(req.body, 'useTlsFiles', false),
            obfs: {
                type: req.body['obfs.type'] || '',
                password: req.body['obfs.password'] || '',
            },
            statsPort: parseInt(req.body.statsPort, 10) || 9999,
            statsSecret: req.body.statsSecret || '',
            outbounds: [],
            aclRules: hyFields.aclRules || [],
            ...hyFields,
        };

        const settings = await Settings.get();
        const authInsecure = settings?.nodeAuth?.insecure ?? true;
        const authUrl = `${config.BASE_URL}/api/auth`;
        const useTlsFiles = nodeData.useTlsFiles || !nodeData.domain;

        const generatedConfig = configGenerator.generateNodeConfig(nodeData, authUrl, { authInsecure, useTlsFiles });
        return res.json({ success: true, config: generatedConfig });
    } catch (error) {
        logger.error('[Panel] Preview config generation error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// POST /panel/nodes/generate-reality-keys - Generate a fresh x25519 Reality keypair.
// Stateless: returns keys for the form to fill in; persistence happens on node save.
// Registered before the parametric /nodes/:id routes so the static path isn't
// captured as an :id. Works without a saved node or an installed xray binary.
router.post('/nodes/generate-reality-keys', (req, res) => {
    try {
        const keys = cryptoService.generateX25519KeysLocal();
        res.json({ success: true, privateKey: keys.privateKey, publicKey: keys.publicKey });
    } catch (error) {
        logger.error(`[Panel] Generate reality keys error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/nodes/:id - Edit node form
router.get('/nodes/:id', async (req, res) => {
    try {
        const CascadeLink = require('../../models/cascadeLinkModel');
        // Pull manualKey explicitly (schema marks it select:false) so we can
        // populate the manualKeySet flag in the rendered form. The actual
        // PEM is then stripped via sanitizeXrayForRender before reaching EJS.
        const [node, groups, cascadeLinks, settings, candidateNodes] = await Promise.all([
            HyNode.findById(req.params.id)
                .select('+xray.manualKey')
                .populate('groups', 'name color'),
            getActiveGroups(),
            CascadeLink.find({
                $or: [{ portalNode: req.params.id }, { bridgeNode: req.params.id }],
            }).populate('portalNode', 'name ip flag')
              .populate('bridgeNode', 'name ip flag')
              .sort({ createdAt: -1 }),
            Settings.get(),
            // Source candidates for virtual nodes — exclude virtual nodes (anti-cycle)
            // and the current node itself.
            HyNode.find({ type: { $ne: 'virtual' }, _id: { $ne: req.params.id } })
                .select('_id name flag type active')
                .sort({ name: 1 })
                .lean(),
        ]);

        if (!node) {
            return res.redirect('/panel/nodes');
        }

        let nodeConfigPreview = '';
        if (node.type === 'hysteria') {
            const customConfig = String(node.customConfig || '').trim();
            if (node.useCustomConfig && customConfig) {
                nodeConfigPreview = customConfig;
            } else {
                const authInsecure = settings?.nodeAuth?.insecure ?? true;
                const authUrl = `${config.BASE_URL}/api/auth`;
                const useTlsFiles = !!(node.useTlsFiles || !node.domain);
                nodeConfigPreview = configGenerator.generateNodeConfig(node, authUrl, { authInsecure, useTlsFiles });
            }
        }

        // Project node to a plain object whose xray sub-block has the secret
        // PEM replaced by ***SET*** (or empty). Sibling fields are unchanged.
        const renderNode = (typeof node.toObject === 'function') ? node.toObject() : { ...node };
        renderNode.xray = sanitizeXrayForRender(node.xray);

        render(res, 'node-form', {
            title: `${res.locals.t('nodes.editNode')}: ${node.name}`,
            page: 'nodes',
            node: renderNode,
            nodeConfigPreview,
            groups,
            candidateNodes,
            cascadeLinks: cascadeLinks || [],
            error: req.query.error || null,
            panelDomain: config.PANEL_DOMAIN || '',
            panelAcmeEmail: config.ACME_EMAIL || '',
            lastInitScript: settings?.lastInitScript || '',
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/nodes/:id - Update node
router.post('/nodes/:id', async (req, res) => {
    const nodeId = req.params.id;
    try {
        // Full doc (not partial) — we .save() it below; +manualKey is select:false.
        const existingNode = await HyNode.findById(nodeId).select('+xray.manualKey');
        if (!existingNode) {
            return res.redirect('/panel/nodes');
        }

        // Captured before the update: SSH credentials are shared per host, so the
        // sibling sync below must target the IP this node actually lived on, not
        // the one it is being moved to.
        const previousIp = existingNode.ip;

        const { name } = req.body;
        const nodeType = ['xray', 'virtual'].includes(req.body.type) ? req.body.type : 'hysteria';
        const ip = req.body.ip || '';

        if (!name) {
            return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent('Name is required')}`);
        }
        if (nodeType !== 'virtual' && !ip) {
            return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent('IP address is required')}`);
        }

        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }

        const updates = {
            name,
            ip: nodeType === 'virtual' ? null : ip,
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
            obfs: {
                type: req.body['obfs.type'] || '',
                password: req.body['obfs.password'] || '',
            },
            flag: req.body.flag || '',
            cascadeRole: req.body.cascadeRole || 'standalone',
            country: req.body.country || '',
            comment: typeof req.body.comment === 'string'
                ? req.body.comment.trim().slice(0, 500)
                : '',
            initScript: req.body.initScript || '',
        };

        // SSH transport fields are only touched when the request actually carries
        // them. Writing them unconditionally would reset a custom port/user to
        // 22/root for any caller that posts a partial body, and would also make
        // the sibling sync below fire on every single save.
        if (req.body['ssh.port'] !== undefined) {
            updates['ssh.port'] = parseInt(req.body['ssh.port'], 10) || 22;
        }
        if (req.body['ssh.username'] !== undefined) {
            updates['ssh.username'] = req.body['ssh.username'] || 'root';
        }

        if (req.body.statsSecret) {
            updates.statsSecret = req.body.statsSecret;
        }

        if (nodeType === 'xray') {
            const existingXray = (existingNode.xray && typeof existingNode.xray.toObject === 'function')
                ? existingNode.xray.toObject()
                : (existingNode.xray || {});
            // resolveManualKeyPlaceholder runs BEFORE the merge so the
            // existing key is restored when the operator did not change it.
            const parsedXray = resolveManualKeyPlaceholder(parseXrayFormFields(req.body), existingXray);
            updates.xray = {
                ...existingXray,
                ...parsedXray,
            };
            const portForValidate = parseInt(req.body.port, 10) || existingNode.port;
            const domainForValidate = String(req.body.domain || '').trim();
            const xrayError = validateXrayFormFields(updates.xray, { port: portForValidate, domain: domainForValidate });
            if (xrayError) {
                return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent(xrayError)}`);
            }
            ensureExtraInboundRealityKeys(updates.xray);
            if ((req.body.cascadeRole || 'standalone') !== 'bridge' && !updates.xray.agentToken) {
                updates.xray.agentToken = nodeSetup.generateAgentToken();
            }
        } else if (nodeType === 'virtual') {
            const virtualError = applyVirtualFormFields(updates, req.body);
            if (virtualError) {
                return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent(virtualError)}`);
            }
        } else {
            const hyFields = parseHysteriaFormFields(req.body);
            const hyValidationError = validateHysteriaFormFields(hyFields);
            if (hyValidationError) {
                return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent(hyValidationError)}`);
            }
            delete hyFields.acmeDnsConfigValid;
            Object.assign(updates, hyFields);
        }

        if (req.body['ssh.password']) {
            updates['ssh.password'] = cryptoService.encrypt(req.body['ssh.password']);
        }

        if (req.body['ssh.clearPrivateKey'] === '1') {
            updates['ssh.privateKey'] = '';
        } else if (req.body['ssh.privateKey'] && req.body['ssh.privateKey'].trim()) {
            const rawKey = req.body['ssh.privateKey'].trim();
            if (!sshKeyService.isValidPrivateKey(rawKey)) {
                return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent('Invalid private key format')}`);
            }
            updates['ssh.privateKey'] = cryptoService.encrypt(rawKey);
        }

        // Use doc.save() — $set on subdoc with select:false field hits Mongoose 8 path collision.
        existingNode.set(updates);
        await existingNode.save();

        syncService.schedulePush(nodeId, updates);

        // Sync SSH credentials to the sibling node on the same host (if SSH was
        // part of this update). Skipped when the node was moved to another IP:
        // the credentials belong to the old host, and nodes already sitting on
        // the new IP have their own.
        const sshChanged = updates['ssh.password'] !== undefined
            || updates['ssh.privateKey'] !== undefined
            || updates['ssh.port'] !== undefined
            || updates['ssh.username'] !== undefined;
        const ipUnchanged = String(existingNode.ip || '') === String(previousIp || '');
        if (sshChanged && previousIp && ipUnchanged) {
            const updatedNode = await HyNode.findById(nodeId).select('ip ssh').lean();
            if (updatedNode) {
                await HyNode.updateMany(
                    { ip: previousIp, _id: { $ne: updatedNode._id } },
                    { $set: { ssh: updatedNode.ssh } }
                );
            }
        }

        // Invalidate active-nodes, subscription, and dashboard caches so ranking/config changes apply immediately
        await invalidateNodesCache();
        res.redirect('/panel/nodes');
    } catch (error) {
        logger.error(`[Panel] Update node error: ${error.message}`);
        res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent(error.message)}`);
    }
});

// POST /panel/nodes/:id/setup - Auto-setup node via SSH
router.post('/nodes/:id/setup', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ success: false, error: 'Нода не найдена', logs: [] });
        }

        if (node.type === 'virtual') {
            return res.status(400).json({ success: false, error: 'Virtual nodes have no remote service to set up', logs: [] });
        }

        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH данные не настроены', logs: [] });
        }
        
        logger.info(`[Panel] Starting setup for node ${node.name} (type: ${node.type || 'hysteria'}, role: ${node.cascadeRole || 'standalone'})`);
        
        let result;
        if (node.type === 'xray' && node.cascadeRole === 'bridge') {
            result = await nodeSetup.setupXrayNode(node, { restartService: false, exitOnly: true });
            if (result.success) {
                result.logs = result.logs || [];
                result.logs.push('[Bridge] Xray installed. Create a cascade link to deploy bridge config.');
            }
        } else if (node.type === 'xray') {
            result = await nodeSetup.setupXrayNodeWithAgent(node, { restartService: true });
        } else {
            const skipHopping = isSameVpsAsPanel(node);
            result = await nodeSetup.setupNode(node, {
                installHysteria: true,
                setupPortHopping: !skipHopping,
                restartService: true,
            });
        }
        
        if (result.success) {
            const updateFields = { status: 'online', lastSync: new Date(), lastError: '', healthFailures: 0 };
            if (node.type !== 'xray') updateFields.useTlsFiles = result.useTlsFiles;
            if (node.cascadeRole === 'bridge') updateFields.status = 'offline';
            await HyNode.findByIdAndUpdate(req.params.id, { $set: updateFields });
            await invalidateNodesCache();

            if (node.type === 'xray' && node.cascadeRole !== 'bridge') {
                const CascadeLink = require('../../models/cascadeLinkModel');
                const linkCount = await CascadeLink.countDocuments({
                    $or: [{ portalNode: node._id }, { bridgeNode: node._id }],
                    active: true,
                });
                if (linkCount > 0) {
                    result.logs = result.logs || [];
                    result.logs.push(`[Cascade] Re-deploying ${linkCount} cascade link(s)...`);
                    cascadeService.redeployAllLinksForNode(node._id).catch(err => {
                        logger.error(`[Cascade] Auto-redeploy after setup: ${err.message}`);
                    });
                }
            }

            res.json({ success: true, message: 'Нода успешно настроена', logs: result.logs || [] });
        } else {
            await HyNode.findByIdAndUpdate(req.params.id, { 
                $set: { status: 'error', lastError: result.error, healthFailures: 0 } 
            });
            await invalidateNodesCache();
            res.status(500).json({ success: false, error: result.error, logs: result.logs || [] });
        }
    } catch (error) {
        logger.error(`[Panel] Setup error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message, logs: [`Exception: ${error.message}`] });
    }
});

// POST /panel/nodes/:id/generate-ssh-key - Generate and install ed25519 SSH key
router.post('/nodes/:id/generate-ssh-key', generateSshKeyLimiter, async (req, res) => {
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

// GET /panel/nodes/:id/download-ssh-key - Download stored SSH private key
router.get('/nodes/:id/download-ssh-key', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id).select('name ip ssh.privateKey');

        if (!node) {
            return res.status(404).type('text/plain; charset=utf-8').send('Node not found');
        }

        if (!node.ssh?.privateKey) {
            return res.status(404).type('text/plain; charset=utf-8').send('SSH private key not configured');
        }

        const privateKey = cryptoService.decryptPrivateKey(node.ssh.privateKey);
        const filename = buildSshKeyFilename(node);

        logger.info(`[Panel] SSH private key downloaded for node ${node.name}`);

        res.set({
            'Content-Type': 'application/x-pem-file; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        return res.send(privateKey);
    } catch (error) {
        logger.error(`[Panel] SSH key download error: ${error.message}`);
        return res.status(500).type('text/plain; charset=utf-8').send('Failed to download SSH private key');
    }
});

// GET /panel/nodes/:id/stats - Node system stats via SSH
router.get('/nodes/:id/stats', async (req, res) => {
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
        
        res.json(stats);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/nodes/:id/speed - Node network speed
router.get('/nodes/:id/speed', async (req, res) => {
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
        
        res.json(speed);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/nodes/:id/get-config - Read current config from node
router.get('/nodes/:id/get-config', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ success: false, error: 'Нода не найдена' });
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH данные не настроены' });
        }
        
        const conn = await nodeSetup.connectSSH(node);
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

// GET /panel/nodes/:id/logs - Node logs
router.get('/nodes/:id/logs', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);

        if (!node) {
            return res.status(404).json({ success: false, error: 'Нода не найдена' });
        }

        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH данные не настроены' });
        }

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

// ==================== OUTBOUNDS ====================

// GET /panel/nodes/:id/outbounds - Node outbound management
router.get('/nodes/:id/outbounds', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.redirect('/panel/nodes');
        }

        const aclInlineState = getHysteriaAclInlineState(node);
        
        render(res, 'node-outbounds', {
            title: `Outbounds: ${node.name}`,
            page: 'nodes',
            node,
            aclInlineState,
            message: req.query.message || null,
            error: req.query.error || null,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/nodes/:id/outbounds - Save outbounds and ACL rules
router.post('/nodes/:id/outbounds', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.redirect('/panel/nodes');
        }

        const aclInlineState = getHysteriaAclInlineState(node);
        
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
        
        let aclRules = Array.isArray(node.aclRules) ? node.aclRules : [];
        if (aclInlineState.editable) {
            const aclRaw = (rawBody.aclRules || '').trim();
            aclRules = aclRaw
                ? aclRaw.split('\n').map(r => r.trim()).filter(Boolean)
                : [];
        }
        
        await HyNode.findByIdAndUpdate(req.params.id, {
            $set: { outbounds, aclRules },
        });
        await invalidateNodesCache();

        // Auto-push config so ACL/outbound edits take effect without Auto Setup.
        syncService.schedulePush(req.params.id, { outbounds, aclRules });

        logger.info(`[Panel] Outbounds updated for node: ${node.name} (${outbounds.length} outbounds, ${aclRules.length} ACL rules)`);
        
        res.redirect(`/panel/nodes/${req.params.id}/outbounds?message=` + encodeURIComponent('Outbounds сохранены'));
    } catch (error) {
        logger.error('[Panel] Outbounds save error:', error.message);
        res.redirect(`/panel/nodes/${req.params.id}/outbounds?error=` + encodeURIComponent(`${res.locals.t?.('common.error') || 'Error'}: ${error.message}`));
    }
});

// GET /panel/nodes/:id/terminal - SSH terminal
router.get('/nodes/:id/terminal', async (req, res) => {
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
router.get('/network', (req, res) => {
    res.redirect('/panel/nodes');
});

// ==================== STATS ====================

// GET /panel/stats - Stats page
router.get('/stats', async (req, res) => {
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

// GET /panel/stats/api/summary - Summary stats
router.get('/stats/api/summary', async (req, res) => {
    try {
        const summary = await statsService.getSummary();
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/online - Online chart data
router.get('/stats/api/online', async (req, res) => {
    try {
        const period = req.query.period || '24h';
        const data = await statsService.getOnlineChart(period);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/traffic - Traffic chart data
router.get('/stats/api/traffic', async (req, res) => {
    try {
        const period = req.query.period || '24h';
        const data = await statsService.getTrafficChart(period);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/nodes - Nodes chart data
router.get('/stats/api/nodes', async (req, res) => {
    try {
        const period = req.query.period || '24h';
        const data = await statsService.getNodesChart(period);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/host - Host/process load chart data
router.get('/stats/api/host', async (req, res) => {
    try {
        const period = req.query.period || '24h';
        const data = await statsService.getHostChart(period);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/stats/cleanup - Manual old data cleanup
router.post('/stats/cleanup', async (req, res) => {
    try {
        const result = await statsService.cleanup();
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/clients - VPN client distribution
router.get('/stats/api/clients', async (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
        const data = await uaStatsService.getAggregated(days);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/ssh-pool - SSH pool stats
router.get('/stats/api/ssh-pool', async (req, res) => {
    try {
        const sshPool = require('../../services/sshPoolService');
        res.json(sshPool.getStats());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /nodes/:id/restart - Restart node service (via Agent for Xray, SSH for Hysteria)
router.post('/nodes/:id/restart', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }

        if (node.type === 'virtual') {
            return res.status(400).json({ error: 'Virtual nodes have no remote service to restart' });
        }

        // Xray nodes with agent: restart + sync through the agent API
        if (node.type === 'xray' && node.xray?.agentToken) {
            try {
                await syncService.updateNodeConfig(node);
                return res.json({ success: true, output: 'Restarted and synced via agent' });
            } catch (agentErr) {
                return res.status(500).json({ error: `Agent restart failed: ${agentErr.message}` });
            }
        }

        // Hysteria nodes (and Xray without agent): SSH restart
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ error: 'SSH credentials not configured' });
        }

        const conn = await nodeSetup.connectSSH(node);
        const serviceName = node.type === 'xray' ? 'xray' : 'hysteria-server';
        const result = await nodeSetup.execSSH(conn, `systemctl restart ${serviceName} && sleep 2 && systemctl is-active ${serviceName}`);
        conn.end();

        const isActive = result.output.trim().includes('active');

        await HyNode.findByIdAndUpdate(req.params.id, {
            $set: { status: isActive ? 'online' : 'error', lastSync: new Date() }
        });
        await invalidateNodesCache();

        res.json({ success: isActive, output: result.output });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
