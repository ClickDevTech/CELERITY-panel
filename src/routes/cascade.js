/**
 * Cascade API routes — CRUD for cascade links, deploy/undeploy, topology.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const CascadeLink = require('../models/cascadeLinkModel');
const HyNode = require('../models/hyNodeModel');
const cascadeService = require('../services/cascadeService');
const cache = require('../services/cacheService');
const logger = require('../utils/logger');
const { requireScope } = require('../middleware/auth');
const { isServerlessNode } = require('../utils/nodeTypes');

async function invalidateCascadeCache() {
    await cache.invalidateAllSubscriptions();
}

const deployLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
});

function isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

function generateUuid() {
    return crypto.randomUUID();
}

const REALITY_KEY_RE = /^[A-Za-z0-9_\-+/]{43,44}=?$/;
const REALITY_SHORT_ID_RE = /^[0-9a-fA-F]{0,16}$/;

function normalizeStringArray(value) {
    if (Array.isArray(value)) return value.map(v => String(v).trim());
    if (value === undefined || value === null || value === '') return [];
    return [String(value).trim()];
}

function generateRealityKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const pub = publicKey.export({ format: 'jwk' });
    const priv = privateKey.export({ format: 'jwk' });

    if (!pub?.x || !priv?.d) {
        throw new Error('Failed to generate REALITY x25519 key pair');
    }

    return {
        privateKey: priv.d,
        publicKey: pub.x,
    };
}

function resolveRealitySettings(input = {}) {
    let privateKey = String(input.realityPrivateKey || '').trim();
    let publicKey = String(input.realityPublicKey || '').trim();

    // If either side is missing, generate a fresh pair so both values match.
    if (!privateKey || !publicKey) {
        const generated = generateRealityKeyPair();
        privateKey = generated.privateKey;
        publicKey = generated.publicKey;
    }

    if (!REALITY_KEY_RE.test(privateKey)) {
        throw new Error('Invalid REALITY privateKey format (expected base64 x25519 key)');
    }
    if (!REALITY_KEY_RE.test(publicKey)) {
        throw new Error('Invalid REALITY publicKey format (expected base64 x25519 key)');
    }

    const inputShortIds = normalizeStringArray(input.realityShortIds);
    for (const sid of inputShortIds) {
        if (!REALITY_SHORT_ID_RE.test(sid)) {
            throw new Error('Invalid REALITY shortId format (expected hex string, max 16 chars)');
        }
    }

    const hasRealShortId = inputShortIds.some(Boolean);
    const shortIds = hasRealShortId
        ? inputShortIds
        : [crypto.randomBytes(8).toString('hex')];

    const realitySni = normalizeStringArray(input.realitySni).filter(Boolean);

    return {
        realityDest: String(input.realityDest || '').trim() || 'www.google.com:443',
        realitySni: realitySni.length > 0 ? realitySni : ['www.google.com'],
        realityPrivateKey: privateKey,
        realityPublicKey: publicKey,
        realityShortIds: shortIds,
        realityFingerprint: String(input.realityFingerprint || 'chrome').trim() || 'chrome',
    };
}

// ==================== LINKS CRUD ====================

/**
 * GET /cascade/links — list all cascade links
 */
router.get('/links', requireScope('nodes:read'), async (req, res) => {
    try {
        const filter = {};
        if (req.query.active !== undefined) filter.active = req.query.active === 'true';
        if (req.query.status) filter.status = req.query.status;
        if (req.query.nodeId) {
            filter.$or = [{ portalNode: req.query.nodeId }, { bridgeNode: req.query.nodeId }];
        }

        const links = await CascadeLink.find(filter)
            .populate('portalNode', 'name ip flag status')
            .populate('bridgeNode', 'name ip flag status')
            .sort({ createdAt: -1 });

        res.json(links);
    } catch (error) {
        logger.error(`[Cascade API] List error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /cascade/links/:id — get single link
 */
router.get('/links/:id', requireScope('nodes:read'), async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const link = await CascadeLink.findById(req.params.id)
            .populate('portalNode', 'name ip flag status')
            .populate('bridgeNode', 'name ip flag status');

        if (!link) return res.status(404).json({ error: 'Cascade link not found' });
        res.json(link);
    } catch (error) {
        logger.error(`[Cascade API] Get error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /cascade/links — create a new cascade link
 */
router.post('/links', requireScope('nodes:write'), async (req, res) => {
    try {
        const { name, portalNodeId, bridgeNodeId, tunnelPort, tunnelProtocol,
            tunnelSecurity, tunnelTransport, tunnelDomain, tunnelUuid,
            tcpFastOpen, tcpKeepAlive, tcpNoDelay,
            wsPath, wsHost, grpcServiceName,
            xhttpPath, xhttpHost, xhttpMode,
            mode, muxEnabled, muxConcurrency,
            geoRouting, realityDest, realitySni, realityPrivateKey,
            realityPublicKey, realityShortIds, realityFingerprint,
            priority } = req.body;

        if (!name || !portalNodeId || !bridgeNodeId) {
            return res.status(400).json({ error: 'name, portalNodeId and bridgeNodeId are required' });
        }

        if (!isValidObjectId(portalNodeId) || !isValidObjectId(bridgeNodeId)) {
            return res.status(400).json({ error: 'Invalid node ID format' });
        }

        if (portalNodeId === bridgeNodeId) {
            return res.status(400).json({ error: 'Portal and Bridge must be different nodes' });
        }

        const linkMode = mode || 'reverse';
        if (!['reverse', 'forward'].includes(linkMode)) {
            return res.status(400).json({ error: 'mode must be "reverse" or "forward"' });
        }

        const port = parseInt(tunnelPort) || 10086;
        if (port < 1 || port > 65535) {
            return res.status(400).json({ error: 'tunnelPort must be between 1 and 65535' });
        }

        // REALITY is only supported on tcp, grpc, splithttp — not ws
        const sec = tunnelSecurity || 'none';
        const trans = tunnelTransport || 'tcp';
        if (sec === 'reality' && trans === 'ws') {
            return res.status(400).json({ error: 'REALITY security is not compatible with WebSocket transport. Use TCP, gRPC, or SplitHTTP.' });
        }

        const [portalNode, bridgeNode] = await Promise.all([
            HyNode.findById(portalNodeId),
            HyNode.findById(bridgeNodeId),
        ]);

        if (!portalNode) return res.status(404).json({ error: 'Portal node not found' });
        if (!bridgeNode) return res.status(404).json({ error: 'Bridge node not found' });
        if (isServerlessNode(portalNode) || isServerlessNode(bridgeNode)) {
            return res.status(400).json({ error: 'Serverless nodes cannot participate in cascade links' });
        }

        // Port conflict: for forward mode the listening side is the bridge; for reverse it is the portal.
        // Also check the opposite side: for forward we check the portal too because the same node
        // might be both a bridge for one link and a portal for another, sharing the same port.
        const portCheckField = linkMode === 'forward' ? 'bridgeNode' : 'portalNode';
        const portCheckId    = linkMode === 'forward' ? bridgeNodeId : portalNodeId;
        const existingLink = await CascadeLink.findOne({
            [portCheckField]: portCheckId,
            tunnelPort: port,
            active: true,
        });
        if (existingLink) {
            const sideLabel = linkMode === 'forward' ? 'bridge/relay' : 'portal';
            return res.status(400).json({
                error: `Port ${port} is already used by link "${existingLink.name}" on the ${sideLabel} node`,
            });
        }

        const linkData = {
            name,
            mode: linkMode,
            portalNode: portalNodeId,
            bridgeNode: bridgeNodeId,
            tunnelUuid: tunnelUuid || generateUuid(),
            tunnelPort: port,
            tunnelDomain: tunnelDomain || 'reverse.tunnel.internal',
            tunnelProtocol: tunnelProtocol || 'vless',
            tunnelSecurity: tunnelSecurity || 'none',
            tunnelTransport: tunnelTransport || 'tcp',
            tcpFastOpen: tcpFastOpen !== false,
            tcpKeepAlive: parseInt(tcpKeepAlive) || 100,
            tcpNoDelay: tcpNoDelay !== false,
            wsPath: wsPath || '/cascade',
            wsHost: wsHost || '',
            grpcServiceName: grpcServiceName || 'cascade',
            xhttpPath: xhttpPath || '/cascade',
            xhttpHost: xhttpHost || '',
            xhttpMode: xhttpMode || 'auto',
            muxEnabled: !!muxEnabled,
            muxConcurrency: parseInt(muxConcurrency) || 8,
            priority: parseInt(priority) || 100,
        };

        // REALITY fields with auto-generated x25519 keys + shortId when omitted
        if (sec === 'reality') {
            Object.assign(linkData, resolveRealitySettings({
                realityDest,
                realitySni,
                realityPrivateKey,
                realityPublicKey,
                realityShortIds,
                realityFingerprint,
            }));
        }

        // Geo-routing
        if (geoRouting && typeof geoRouting === 'object') {
            linkData.geoRouting = {
                enabled: !!geoRouting.enabled,
                domains: Array.isArray(geoRouting.domains) ? geoRouting.domains.filter(Boolean) : [],
                geoip: Array.isArray(geoRouting.geoip) ? geoRouting.geoip.filter(Boolean) : [],
            };
        }

        const link = await CascadeLink.create(linkData);

        const populated = await CascadeLink.findById(link._id)
            .populate('portalNode', 'name ip flag status')
            .populate('bridgeNode', 'name ip flag status');

        logger.info(`[Cascade API] Created ${linkMode} link ${name}: ${portalNode.name} -> ${bridgeNode.name}`);

        await invalidateCascadeCache();

        const connectedLinksCount = await CascadeLink.countDocuments({
            active: true,
            _id: { $ne: link._id },
            $or: [
                { portalNode: portalNodeId },
                { bridgeNode: portalNodeId },
                { portalNode: bridgeNodeId },
                { bridgeNode: bridgeNodeId },
            ],
        });

        // Auto-sync the full chain either when explicitly requested or when
        // this new link extends an already existing chain.
        if (req.body.autoDeploy || connectedLinksCount > 0) {
            cascadeService.deployChain(portalNodeId).catch(err => {
                logger.warn(`[Cascade API] Auto chain sync failed: ${err.message}`);
            });
        }

        res.status(201).json(populated);
    } catch (error) {
        logger.error(`[Cascade API] Create error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /cascade/links/:id — update link settings (non-topology fields)
 */
router.put('/links/:id', requireScope('nodes:write'), async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const allowedFields = [
            'name', 'mode', 'tunnelPort', 'tunnelDomain', 'tunnelProtocol',
            'tunnelSecurity', 'tunnelTransport', 'tunnelUuid',
            'tcpFastOpen', 'tcpKeepAlive', 'tcpNoDelay', 'active', 'priority',
            'wsPath', 'wsHost', 'grpcServiceName',
            'xhttpPath', 'xhttpHost', 'xhttpMode',
            'muxEnabled', 'muxConcurrency',
            'realityDest', 'realityPrivateKey', 'realityPublicKey',
            'realityFingerprint',
        ];

        const updates = {};
        for (const key of allowedFields) {
            if (req.body[key] !== undefined) {
                updates[key] = req.body[key];
            }
        }

        // Fetch current link once for all validation checks
        let currentLink = null;
        const needsCurrentLink = updates.tunnelPort !== undefined ||
            updates.mode !== undefined ||
            updates.tunnelSecurity !== undefined ||
            updates.tunnelTransport !== undefined ||
            updates.realityDest !== undefined ||
            updates.realityFingerprint !== undefined ||
            updates.realityPrivateKey !== undefined ||
            updates.realityPublicKey !== undefined ||
            req.body.realitySni !== undefined ||
            req.body.realityShortIds !== undefined;
        if (needsCurrentLink) {
            currentLink = await CascadeLink.findById(req.params.id);
            if (!currentLink) return res.status(404).json({ error: 'Cascade link not found' });
        }

        if (updates.tunnelPort !== undefined) {
            const port = parseInt(updates.tunnelPort);
            if (port < 1 || port > 65535) {
                return res.status(400).json({ error: 'tunnelPort must be between 1 and 65535' });
            }
            updates.tunnelPort = port;

            if (currentLink) {
                // Forward: port is on bridge, Reverse: port is on portal
                const effectiveMode = updates.mode || currentLink.mode || 'reverse';
                const nodeField = effectiveMode === 'forward' ? 'bridgeNode' : 'portalNode';
                const nodeId = currentLink[nodeField];
                const conflictingLink = await CascadeLink.findOne({
                    [nodeField]: nodeId,
                    tunnelPort: port,
                    active: true,
                    _id: { $ne: req.params.id },
                });
                if (conflictingLink) {
                    return res.status(400).json({
                        error: `Port ${port} is already used by link "${conflictingLink.name}" on this node`,
                    });
                }
            }
        }

        // Validate REALITY + transport compatibility
        if (updates.tunnelSecurity === 'reality' || updates.tunnelTransport) {
            const effectiveSec = updates.tunnelSecurity || currentLink?.tunnelSecurity || 'none';
            const effectiveTrans = updates.tunnelTransport || currentLink?.tunnelTransport || 'tcp';
            if (effectiveSec === 'reality' && effectiveTrans === 'ws') {
                return res.status(400).json({ error: 'REALITY security is not compatible with WebSocket transport' });
            }
        }

        // Geo-routing settings
        if (req.body.geoRouting !== undefined) {
            const gr = req.body.geoRouting;
            updates['geoRouting.enabled'] = !!gr.enabled;
            if (Array.isArray(gr.domains)) updates['geoRouting.domains'] = gr.domains.map(String);
            if (Array.isArray(gr.geoip))   updates['geoRouting.geoip']   = gr.geoip.map(String);
        }

        // REALITY array fields
        if (req.body.realitySni !== undefined) {
            updates.realitySni = normalizeStringArray(req.body.realitySni).filter(Boolean);
        }
        if (req.body.realityShortIds !== undefined) {
            updates.realityShortIds = normalizeStringArray(req.body.realityShortIds);
        }

        const effectiveSec = updates.tunnelSecurity || currentLink?.tunnelSecurity || 'none';
        if (effectiveSec === 'reality') {
            Object.assign(updates, resolveRealitySettings({
                realityDest: updates.realityDest !== undefined ? updates.realityDest : currentLink?.realityDest,
                realitySni: updates.realitySni !== undefined ? updates.realitySni : currentLink?.realitySni,
                realityPrivateKey: updates.realityPrivateKey !== undefined ? updates.realityPrivateKey : currentLink?.realityPrivateKey,
                realityPublicKey: updates.realityPublicKey !== undefined ? updates.realityPublicKey : currentLink?.realityPublicKey,
                realityShortIds: updates.realityShortIds !== undefined ? updates.realityShortIds : currentLink?.realityShortIds,
                realityFingerprint: updates.realityFingerprint !== undefined ? updates.realityFingerprint : currentLink?.realityFingerprint,
            }));
        }

        const link = await CascadeLink.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true }
        ).populate('portalNode', 'name ip flag status')
         .populate('bridgeNode', 'name ip flag status');

        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        logger.info(`[Cascade API] Updated link ${link.name}`);

        // Invalidate subscription cache
        await invalidateCascadeCache();

        // Auto-redeploy chain if link was deployed and settings changed
        if (req.body.autoRedeploy && ['deployed', 'online', 'offline'].includes(link.status)) {
            cascadeService.deployChain(link.portalNode._id || link.portalNode).catch(err => {
                logger.warn(`[Cascade API] Auto-redeploy failed: ${err.message}`);
            });
        }

        res.json(link);
    } catch (error) {
        logger.error(`[Cascade API] Update error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /cascade/links/:id/reconnect — change portal or bridge node of an existing link.
 * Undeploys the link first, updates the topology, resets status to pending.
 */
router.patch('/links/:id/reconnect', requireScope('nodes:write'), async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const { portalNodeId, bridgeNodeId } = req.body;
        if (!portalNodeId && !bridgeNodeId) {
            return res.status(400).json({ error: 'portalNodeId or bridgeNodeId is required' });
        }

        if (portalNodeId && !isValidObjectId(portalNodeId)) {
            return res.status(400).json({ error: 'Invalid portalNodeId' });
        }
        if (bridgeNodeId && !isValidObjectId(bridgeNodeId)) {
            return res.status(400).json({ error: 'Invalid bridgeNodeId' });
        }

        const link = await CascadeLink.findById(req.params.id);
        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        // Validate new nodes exist
        const [newPortal, newBridge] = await Promise.all([
            portalNodeId ? HyNode.findById(portalNodeId) : Promise.resolve(null),
            bridgeNodeId ? HyNode.findById(bridgeNodeId) : Promise.resolve(null),
        ]);

        if (portalNodeId && !newPortal) return res.status(404).json({ error: 'Portal node not found' });
        if (bridgeNodeId && !newBridge) return res.status(404).json({ error: 'Bridge node not found' });
        if ((newPortal && isServerlessNode(newPortal)) || (newBridge && isServerlessNode(newBridge))) {
            return res.status(400).json({ error: 'Serverless nodes cannot participate in cascade links' });
        }

        const effectivePortalId = portalNodeId || String(link.portalNode);
        const effectiveBridgeId = bridgeNodeId || String(link.bridgeNode);
        if (effectivePortalId === effectiveBridgeId) {
            return res.status(400).json({ error: 'Portal and Bridge must be different nodes' });
        }

        // Undeploy before changing topology
        if (['deployed', 'online', 'offline'].includes(link.status)) {
            try { await cascadeService.undeployLink(link); } catch (_) {}
        }

        const updates = { status: 'pending', lastError: '' };
        if (portalNodeId) updates.portalNode = portalNodeId;
        if (bridgeNodeId) updates.bridgeNode = bridgeNodeId;

        const updated = await CascadeLink.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true }
        ).populate('portalNode', 'name ip flag status')
         .populate('bridgeNode', 'name ip flag status');

        logger.info(`[Cascade API] Reconnected link ${updated.name}`);

        // Invalidate subscription cache
        await invalidateCascadeCache();

        res.json(updated);
    } catch (error) {
        logger.error(`[Cascade API] Reconnect error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /cascade/links/:id — delete with optional undeploy
 */
router.delete('/links/:id', requireScope('nodes:write'), async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const link = await CascadeLink.findById(req.params.id);
        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        if (['deployed', 'online', 'offline'].includes(link.status)) {
            await cascadeService.undeployLink(link);
        }

        await CascadeLink.findByIdAndDelete(req.params.id);

        // Invalidate subscription cache
        await invalidateCascadeCache();
        logger.info(`[Cascade API] Deleted link ${link.name}`);
        res.json({ success: true, message: 'Cascade link deleted' });
    } catch (error) {
        logger.error(`[Cascade API] Delete error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ==================== DEPLOY / UNDEPLOY ====================

/**
 * POST /cascade/links/:id/deploy — deploy configs to both nodes
 */
router.post('/links/:id/deploy', requireScope('nodes:write'), deployLimiter, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const link = await CascadeLink.findById(req.params.id)
            .populate('portalNode')
            .populate('bridgeNode');

        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        const result = await cascadeService.deployLink(link);

        // Invalidate subscription cache after deploy
        await invalidateCascadeCache();

        if (result.success) {
            res.json({ success: true, message: 'Cascade link deployed' });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        logger.error(`[Cascade API] Deploy error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /cascade/links/:id/undeploy — remove cascade config from nodes
 */
router.post('/links/:id/undeploy', requireScope('nodes:write'), deployLimiter, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const link = await CascadeLink.findById(req.params.id);
        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        await cascadeService.undeployLink(link);

        // Invalidate subscription cache after undeploy
        await invalidateCascadeCache();

        res.json({ success: true, message: 'Cascade link undeployed' });
    } catch (error) {
        logger.error(`[Cascade API] Undeploy error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ==================== CHAIN DEPLOY ====================

/**
 * POST /cascade/chain/deploy — deploy entire cascade chain in correct order
 * Accepts either nodeId or linkId to identify the chain
 */
router.post('/chain/deploy', requireScope('nodes:write'), deployLimiter, async (req, res) => {
    try {
        const { nodeId, linkId } = req.body;

        let startNodeId;
        if (nodeId) {
            if (!isValidObjectId(nodeId)) {
                return res.status(400).json({ error: 'Invalid nodeId' });
            }
            startNodeId = nodeId;
        } else if (linkId) {
            if (!isValidObjectId(linkId)) {
                return res.status(400).json({ error: 'Invalid linkId' });
            }
            const link = await CascadeLink.findById(linkId);
            if (!link) return res.status(404).json({ error: 'Link not found' });
            startNodeId = link.portalNode;
        } else {
            return res.status(400).json({ error: 'nodeId or linkId is required' });
        }

        const result = await cascadeService.deployChain(startNodeId);

        // Invalidate subscription cache after chain deploy
        await invalidateCascadeCache();

        if (result.success) {
            res.json({
                success: true,
                message: `Chain deployed: ${result.deployed} nodes`,
                deployed: result.deployed,
            });
        } else {
            res.status(500).json({
                success: false,
                deployed: result.deployed,
                errors: result.errors,
            });
        }
    } catch (error) {
        logger.error(`[Cascade API] Chain deploy error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ==================== HEALTH ====================

/**
 * GET /cascade/links/:id/health — health-check a single link
 */
router.get('/links/:id/health', requireScope('nodes:read'), async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const link = await CascadeLink.findById(req.params.id);
        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        const healthy = await cascadeService.healthCheckLink(link);
        const updated = await CascadeLink.findById(req.params.id);

        res.json({
            healthy,
            status: updated.status,
            lastHealthCheck: updated.lastHealthCheck,
            latencyMs: updated.latencyMs,
        });
    } catch (error) {
        logger.error(`[Cascade API] Health error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ==================== TOPOLOGY ====================

/**
 * GET /cascade/topology — full network graph for the visual map
 */
router.get('/topology', requireScope('nodes:read'), async (req, res) => {
    try {
        const topology = await cascadeService.getTopology();
        res.json(topology);
    } catch (error) {
        logger.error(`[Cascade API] Topology error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /cascade/topology/positions — save node positions from the map editor
 */
router.post('/topology/positions', requireScope('nodes:write'), async (req, res) => {
    try {
        const { positions } = req.body;
        if (!Array.isArray(positions)) {
            return res.status(400).json({ error: 'positions must be an array' });
        }

        await cascadeService.savePositions(positions);
        res.json({ success: true });
    } catch (error) {
        logger.error(`[Cascade API] Positions error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
