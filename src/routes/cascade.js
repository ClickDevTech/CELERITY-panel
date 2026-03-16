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
const logger = require('../utils/logger');
const { requireScope } = require('../middleware/auth');

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
    return require('crypto').randomUUID();
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
            tcpFastOpen, tcpKeepAlive, tcpNoDelay } = req.body;

        if (!name || !portalNodeId || !bridgeNodeId) {
            return res.status(400).json({ error: 'name, portalNodeId and bridgeNodeId are required' });
        }

        if (!isValidObjectId(portalNodeId) || !isValidObjectId(bridgeNodeId)) {
            return res.status(400).json({ error: 'Invalid node ID format' });
        }

        if (portalNodeId === bridgeNodeId) {
            return res.status(400).json({ error: 'Portal and Bridge must be different nodes' });
        }

        const port = parseInt(tunnelPort) || 10086;
        if (port < 1 || port > 65535) {
            return res.status(400).json({ error: 'tunnelPort must be between 1 and 65535' });
        }

        const [portalNode, bridgeNode] = await Promise.all([
            HyNode.findById(portalNodeId),
            HyNode.findById(bridgeNodeId),
        ]);

        if (!portalNode) return res.status(404).json({ error: 'Portal node not found' });
        if (!bridgeNode) return res.status(404).json({ error: 'Bridge node not found' });

        const link = await CascadeLink.create({
            name,
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
        });

        const populated = await CascadeLink.findById(link._id)
            .populate('portalNode', 'name ip flag status')
            .populate('bridgeNode', 'name ip flag status');

        logger.info(`[Cascade API] Created link ${name}: ${portalNode.name} -> ${bridgeNode.name}`);
        res.status(201).json(populated);
    } catch (error) {
        logger.error(`[Cascade API] Create error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /cascade/links/:id — update a cascade link
 */
router.put('/links/:id', requireScope('nodes:write'), async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const allowedFields = [
            'name', 'tunnelPort', 'tunnelDomain', 'tunnelProtocol',
            'tunnelSecurity', 'tunnelTransport', 'tunnelUuid',
            'tcpFastOpen', 'tcpKeepAlive', 'tcpNoDelay', 'active',
        ];

        const updates = {};
        for (const key of allowedFields) {
            if (req.body[key] !== undefined) {
                updates[key] = req.body[key];
            }
        }

        if (updates.tunnelPort !== undefined) {
            const port = parseInt(updates.tunnelPort);
            if (port < 1 || port > 65535) {
                return res.status(400).json({ error: 'tunnelPort must be between 1 and 65535' });
            }
            updates.tunnelPort = port;
        }

        const link = await CascadeLink.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true }
        ).populate('portalNode', 'name ip flag status')
         .populate('bridgeNode', 'name ip flag status');

        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        logger.info(`[Cascade API] Updated link ${link.name}`);
        res.json(link);
    } catch (error) {
        logger.error(`[Cascade API] Update error: ${error.message}`);
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
        res.json({ success: true, message: 'Cascade link undeployed' });
    } catch (error) {
        logger.error(`[Cascade API] Undeploy error: ${error.message}`);
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
