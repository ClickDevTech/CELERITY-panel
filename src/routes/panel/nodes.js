const express = require('express');
const mongoose = require('mongoose');
const dns = require('dns').promises;
const rateLimit = require('express-rate-limit');
const router = express.Router();

const Admin = require('../../models/adminModel');
const HyNode = require('../../models/hyNodeModel');
const HyUser = require('../../models/hyUserModel');
const ServerGroup = require('../../models/serverGroupModel');
const Settings = require('../../models/settingsModel');
const cryptoService = require('../../services/cryptoService');
const syncService = require('../../services/syncService');
const configGenerator = require('../../services/configGenerator');
const nodeSetup = require('../../services/nodeSetup');
const xrayVersionService = require('../../services/xrayVersionService');
const totpService = require('../../services/totpService');
const { isSameVpsAsPanel } = nodeSetup;
const NodeSSH = require('../../services/nodeSSH');
const sshKeyService = require('../../services/sshKeyService');
const cache = require('../../services/cacheService');
const cascadeService = require('../../services/cascadeService');
const statsService = require('../../services/statsService');
const uaStatsService = require('../../services/uaStatsService');
const { getActiveGroups, invalidateNodesCache } = require('../../utils/helpers');
const { buildNodeUiMeta } = require('../../utils/nodeUi');
const { isServerlessNode, checkCascadeMembership } = require('../../utils/nodeTypes');
const {
    normalizeCdnConfig,
    validateCdnOrigin,
    checkCdnDependents,
    isValidHostname,
    CDN_ORIGIN_CANDIDATE_SELECT,
} = require('../../utils/cdnConfig');
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
    parseAclRulesInput,
    parseOutboundsFormFields,
    getHysteriaAclInlineState,
    validateHysteriaFormFields,
    buildSshKeyFilename,
    connectNodeSSH,
    generateSshKeyLimiter,
    sniScanLimiter,
    buildClonedNodePrefill,
} = require('./helpers');

const sniScanner = require('../../services/sniScanner');

const xrayVersionCheckLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
});

const xrayVersionApplyLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
});

const cdnResolveLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
});

async function reauthenticateXrayVersionChange(req, res) {
    const password = String(req.body?.currentPassword || '');
    const token = String(req.body?.totpToken || '');
    const admin = await Admin.verifyPassword(req.session.adminUsername, password);
    if (!admin) {
        res.status(401).json({ error: res.locals.t?.('auth.invalidCurrentPassword') || 'Invalid current password' });
        return false;
    }
    if (!admin.twoFactor?.enabled) return true;

    const secret = totpService.decryptSecret(admin.twoFactor.secretEncrypted);
    if (!secret) {
        res.status(500).json({ error: res.locals.t?.('auth.totpConfigError') || 'TOTP configuration error' });
        return false;
    }
    if (!(await totpService.verifyToken({ secret, token }))) {
        res.status(401).json({ error: res.locals.t?.('auth.invalidCurrentTotp') || 'Invalid current TOTP code' });
        return false;
    }
    return true;
}

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

    const toleranceRaw = parseInt(body['virtual.tolerance'], 10);
    const tolerance = Number.isFinite(toleranceRaw)
        ? Math.min(Math.max(toleranceRaw, 0), 5000)
        : 50;

    nodeData.virtual = {
        selectMode,
        sources,
        sourceGroup,
        strategy,
        fallbackToFirst: body['virtual.fallbackToFirst'] === 'on',
        tolerance,
        idleTimeout: (body['virtual.idleTimeout'] || '').trim(),
        interruptExistConnections: body['virtual.interruptExistConnections'] === 'on',
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

async function applyCdnFormFields(nodeData, body, selfId) {
    const asArray = (value) => {
        if (value === undefined || value === null) return [];
        return Array.isArray(value) ? value : [value];
    };
    const ids = asArray(body.cdn_edge_id);
    const labels = asArray(body.cdn_edge_label);
    const addresses = asArray(body.cdn_edge_address);
    const enabledIds = new Set(asArray(body.cdn_edge_enabled).map(String));
    const edges = ids.map((id, index) => ({
        id,
        label: labels[index],
        address: addresses[index],
        enabled: enabledIds.has(String(id)),
    }));

    const normalized = normalizeCdnConfig({
        originNode: body['cdn.originNode'],
        originInboundId: body['cdn.originInboundId'],
        edges,
        domain: body['cdn.domain'],
        port: body['cdn.port'],
        security: body['cdn.security'],
        sni: body['cdn.sni'],
        host: body['cdn.host'],
        path: body['cdn.path'],
        alpn: body['cdn.alpn'],
        fingerprint: body['cdn.fingerprint'],
        xhttpMode: body['cdn.xhttpMode'],
    });
    if (normalized.error) return normalized.error;

    const originCheck = await validateCdnOrigin(normalized.value, HyNode, { selfId });
    if (originCheck.error) return originCheck.error;
    nodeData.cdn = normalized.value;
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
            const realNodeFilter = { type: { $nin: ['virtual', 'cdn'] } };
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
        const nodes = await HyNode.find({ active: true, type: { $nin: ['virtual', 'cdn'] } })
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
            HyNode.find()
                .populate('groups', 'name color')
                .populate('cdn.originNode', 'name flag')
                .sort({ rankingCoefficient: 1, name: 1 }),
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
            // Virtual sources may include CDN fronts; CDN origins are filtered to Xray in the form.
            HyNode.find({ type: { $ne: 'virtual' } })
                .select(CDN_ORIGIN_CANDIDATE_SELECT)
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
            if (source && !isServerlessNode(source)) {
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
            canAddPairedProtocol: false,
        });
    } catch (error) {
        logger.error('[Panel] GET /nodes/add error:', error.message);
        res.status(500).send('Error: ' + error.message);
    }
});

router.get('/nodes/resolve-cdn', cdnResolveLimiter, async (req, res) => {
    const domain = String(req.query.domain || '').trim().toLowerCase();
    if (!isValidHostname(domain)) {
        return res.status(400).json({ error: 'A valid CDN domain is required' });
    }
    try {
        const [v4, v6] = await Promise.allSettled([
            dns.resolve4(domain),
            dns.resolve6(domain),
        ]);
        const addresses = [
            ...(v4.status === 'fulfilled' ? v4.value : []),
            ...(v6.status === 'fulfilled' ? v6.value : []),
        ];
        const unique = [...new Set(addresses)].slice(0, 32);
        if (unique.length === 0) return res.status(404).json({ error: 'No A or AAAA records found' });
        return res.json({ domain, addresses: unique });
    } catch (error) {
        logger.warn(`[Panel] CDN DNS lookup failed for ${domain}: ${error.code || error.message}`);
        return res.status(502).json({ error: 'DNS lookup failed' });
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
        const nodeType = ['xray', 'virtual', 'cdn'].includes(req.body.type) ? req.body.type : 'hysteria';
        const ip = req.body.ip || '';

        if (!name) {
            return res.redirect(`/panel/nodes/add?error=${encodeURIComponent('Name is required')}`);
        }
        if (!isServerlessNode(nodeType) && !ip) {
            return res.redirect(`/panel/nodes/add?error=${encodeURIComponent('IP address is required')}`);
        }

        // Ensure no duplicate node for the same IP + protocol type (skipped for virtual: no IP).
        if (!isServerlessNode(nodeType)) {
            const existing = await HyNode.findOne({ ip, type: nodeType });
            if (existing) {
                return res.redirect(`/panel/nodes/add?error=${encodeURIComponent(`A ${nodeType} node with this IP already exists`)}`);
            }
        }

        const labelConflict = await HyNode.findLabelConflict(name, req.body.flag);
        if (labelConflict) {
            return res.redirect(`/panel/nodes/add?error=${encodeURIComponent('A node with this name and flag already exists — subscription tags must be unique')}`);
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

        // Inherit SSH credentials from sibling node (same IP, different protocol) if caller left them blank.
        // Serverless nodes have no IP, so they must never pick up a sibling's keys.
        const callerProvidedSsh = !!(encryptedPassword || encryptedPrivateKey);
        let siblingSsh = null;
        if (!callerProvidedSsh && !isServerlessNode(nodeType)) {
            const sibling = await HyNode.findOne({ ip, type: { $ne: nodeType } }).select('ssh').lean();
            siblingSsh = sibling?.ssh || null;
        }

        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }

        const statsSecret = req.body.statsSecret || cryptoService.generateNodeSecret();

        // Resolve SSH: use provided values, or fall back to sibling node values
        const resolvedSsh = isServerlessNode(nodeType)
            ? { port: 22, username: 'root', password: '', privateKey: '' }
            : {
                port: parseInt(req.body['ssh.port']) || siblingSsh?.port || 22,
                username: req.body['ssh.username'] || siblingSsh?.username || 'root',
                password: encryptedPassword || siblingSsh?.password || '',
                privateKey: encryptedPrivateKey || siblingSsh?.privateKey || '',
            };

        const nodeData = {
            name,
            ip: isServerlessNode(nodeType) ? null : ip,
            type: nodeType,
            domain: isServerlessNode(nodeType) ? '' : (req.body.domain || ''),
            sni: isServerlessNode(nodeType) ? '' : (req.body.sni || ''),
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
            cascadeRole: isServerlessNode(nodeType) ? 'standalone' : (req.body.cascadeRole || 'standalone'),
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
            // Only the Xray create form renders the outbounds/ACL block. The
            // hidden Hysteria and virtual sections post their own fields, so
            // these are read inside this branch and nowhere else.
            nodeData.outbounds = parseOutboundsFormFields(req.body);
            nodeData.aclRules = parseAclRulesInput(req.body.xrayAclRules);
            if (nodeData.cascadeRole !== 'bridge' && !nodeData.xray.agentToken) {
                nodeData.xray.agentToken = nodeSetup.generateAgentToken();
            }
        } else if (nodeType === 'virtual') {
            const virtualError = applyVirtualFormFields(nodeData, req.body);
            if (virtualError) {
                return res.redirect(`/panel/nodes/add?error=${encodeURIComponent(virtualError)}`);
            }
        } else if (nodeType === 'cdn') {
            const cdnError = await applyCdnFormFields(nodeData, req.body);
            if (cdnError) {
                return res.redirect(`/panel/nodes/add?error=${encodeURIComponent(cdnError)}`);
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
        syncService.maybePushCdnOrigins(null, newNode);
        logger.info(`[Panel] Created ${nodeType} node ${name} (${isServerlessNode(nodeType) ? nodeType : ip})`);
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

router.get('/nodes/:id/xray-version-status', async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid node id' });
        }
        const node = await HyNode.findById(req.params.id);
        if (!node) return res.status(404).json({ error: 'Node not found' });
        if (node.type !== 'xray') return res.status(400).json({ error: 'Node is not an Xray node' });

        const [versionInfo, currentVersion] = await Promise.all([
            xrayVersionService.getVersionInfo(),
            req.query.live === '1'
                ? xrayVersionService.detectInstalledVersion(node)
                : Promise.resolve(xrayVersionService.normalizeVersion(node.xrayVersion)),
        ]);
        return res.json({
            ...versionInfo,
            currentVersion: currentVersion || null,
            canChangeVersion: !!(node.ssh?.password || node.ssh?.privateKey),
            task: xrayVersionService.getTask(node._id),
        });
    } catch (error) {
        logger.error(`[Panel] Xray version status error: ${error.message}`);
        return res.status(500).json({ error: error.message });
    }
});

router.post('/nodes/:id/xray-version-check', xrayVersionCheckLimiter, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid node id' });
        }
        const node = await HyNode.findById(req.params.id);
        if (!node) return res.status(404).json({ error: 'Node not found' });
        if (node.type !== 'xray') return res.status(400).json({ error: 'Node is not an Xray node' });

        const [versionInfo, currentVersion] = await Promise.all([
            xrayVersionService.getVersionInfo({ force: true }),
            xrayVersionService.detectInstalledVersion(node, { forceSsh: true }),
        ]);
        return res.json({
            ...versionInfo,
            currentVersion: currentVersion || null,
            canChangeVersion: !!(node.ssh?.password || node.ssh?.privateKey),
            task: xrayVersionService.getTask(node._id),
        });
    } catch (error) {
        logger.error(`[Panel] Xray version check error: ${error.message}`);
        return res.status(500).json({ error: error.message });
    }
});

router.get('/nodes/:id/xray-version-changelog', async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid node id' });
        }
        const changelog = await xrayVersionService.getReleaseChangelog(req.query.version);
        if (!changelog) return res.status(404).json({ error: 'Unknown Xray release' });
        return res.json(changelog);
    } catch (error) {
        logger.error(`[Panel] Xray changelog error: ${error.message}`);
        return res.status(500).json({ error: error.message });
    }
});

router.get('/nodes/:id/xray-version-task', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ error: 'Invalid node id' });
    }
    return res.json(xrayVersionService.getTask(req.params.id));
});

router.post('/nodes/:id/xray-version', xrayVersionApplyLimiter, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid node id' });
        }
        const node = await HyNode.findById(req.params.id);
        if (!node) return res.status(404).json({ error: 'Node not found' });
        if (node.type !== 'xray') return res.status(400).json({ error: 'Node is not an Xray node' });
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(409).json({ error: 'SSH credentials are required to change Xray version' });
        }
        if (!(await reauthenticateXrayVersionChange(req, res))) return undefined;

        const task = await xrayVersionService.startVersionChange(node._id, req.body?.version);
        logger.warn(`[Panel] Xray version change to ${task.targetVersion} started for ${node.name} by ${req.session.adminUsername} (IP: ${req.ip})`);
        return res.status(202).json({ accepted: true, task });
    } catch (error) {
        logger.error(`[Panel] Xray version change error: ${error.message}`);
        return res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// GET /panel/nodes/:id - Edit node form
router.get('/nodes/:id', async (req, res) => {
    try {
        const CascadeLink = require('../../models/cascadeLinkModel');
        // Pull manualKey explicitly (schema marks it select:false) so we can
        // populate the manualKeySet flag in the rendered form. The actual
        // PEM is then stripped via sanitizeXrayForRender before reaching EJS.
        const [node, groups, cascadeLinks, settings, candidateNodes, currentAdmin] = await Promise.all([
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
            // Virtual sources may include CDN fronts; CDN origins are filtered to Xray in the form.
            HyNode.find({ type: { $ne: 'virtual' }, _id: { $ne: req.params.id } })
                .select(CDN_ORIGIN_CANDIDATE_SELECT)
                .sort({ name: 1 })
                .lean(),
            Admin.findOne({ username: req.session.adminUsername }).select('twoFactor.enabled').lean(),
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

        let canAddPairedProtocol = false;
        if (node.type !== 'virtual' && node.ip) {
            const sibling = await HyNode.exists({ _id: { $ne: node._id }, ip: node.ip });
            canAddPairedProtocol = !sibling;
        }

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
            canAddPairedProtocol,
            xrayUpdateTotpEnabled: !!currentAdmin?.twoFactor?.enabled,
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
        const nodeType = ['xray', 'virtual', 'cdn'].includes(req.body.type) ? req.body.type : 'hysteria';
        const ip = req.body.ip || '';

        if (!name) {
            return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent('Name is required')}`);
        }
        if (!isServerlessNode(nodeType) && !ip) {
            return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent('IP address is required')}`);
        }

        // Only checked when the label actually changes: a database that already
        // holds duplicates from before this validation must stay editable, and
        // the generator deduplicates such tags anyway.
        const labelChanged = String(name).trim() !== String(existingNode.name || '').trim()
            || String(req.body.flag || '').trim() !== String(existingNode.flag || '').trim();
        if (labelChanged) {
            const labelConflict = await HyNode.findLabelConflict(name, req.body.flag, nodeId);
            if (labelConflict) {
                return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent('A node with this name and flag already exists — subscription tags must be unique')}`);
            }
        }

        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }

        const updates = {
            name,
            ip: isServerlessNode(nodeType) ? null : ip,
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
            cascadeRole: isServerlessNode(nodeType) ? 'standalone' : (req.body.cascadeRole || 'standalone'),
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
        } else if (nodeType === 'cdn') {
            const cdnError = await applyCdnFormFields(updates, req.body, nodeId);
            if (cdnError) {
                return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent(cdnError)}`);
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
        if (isServerlessNode(nodeType)) {
            delete updates['ssh.port'];
            delete updates['ssh.username'];
            delete updates['ssh.password'];
            delete updates['ssh.privateKey'];
            updates.ssh = cryptoService.encryptSshCredentials({});
            updates.domain = '';
            updates.sni = '';
        }

        // Only an Xray node can be a CDN origin, and switching its type or
        // reshaping the published inbound breaks the fronts as thoroughly as
        // deleting it would — just silently.
        if (existingNode.type === 'xray') {
            const dependentError = await checkCdnDependents(
                nodeId,
                {
                    type: nodeType,
                    name: existingNode.name,
                    active: updates.active,
                    xray: updates.xray || {},
                },
                HyNode
            );
            if (dependentError) {
                return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent(dependentError)}`);
            }
        }

        const cascadeError = await checkCascadeMembership(existingNode, nodeType);
        if (cascadeError) {
            return res.redirect(`/panel/nodes/${nodeId}?error=${encodeURIComponent(cascadeError)}`);
        }

        const previousCdnSync = {
            type: existingNode.type,
            active: existingNode.active,
            groups: existingNode.groups,
            cdn: existingNode.cdn,
        };

        // Use doc.save() — $set on subdoc with select:false field hits Mongoose 8 path collision.
        existingNode.set(updates);
        await existingNode.save();

        syncService.schedulePush(nodeId, updates);
        syncService.maybePushCdnOrigins(previousCdnSync, existingNode);

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

        if (isServerlessNode(node)) {
            return res.status(400).json({ success: false, error: 'This node type has no remote service to set up', logs: [] });
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
        
        const rawBody = req.body;
        const outbounds = parseOutboundsFormFields(rawBody);

        let aclRules = Array.isArray(node.aclRules) ? node.aclRules : [];
        if (aclInlineState.editable) {
            aclRules = parseAclRulesInput(rawBody.aclRules);
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

        if (isServerlessNode(node)) {
            return res.status(400).json({ error: 'This node type has no remote service to restart' });
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
