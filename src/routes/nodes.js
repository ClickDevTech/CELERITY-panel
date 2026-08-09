/**
 * API for managing Hysteria + Xray nodes
 */

const express = require('express');
const router = express.Router();
const HyNode = require('../models/hyNodeModel');
const HyUser = require('../models/hyUserModel');
const ServerGroup = require('../models/serverGroupModel');
const cryptoService = require('../services/cryptoService');
const logger = require('../utils/logger');
const { requireScope } = require('../middleware/auth');
const { invalidateNodesCache } = require('../utils/helpers');
const nodeSetup = require('../services/nodeSetup');
const syncService = require('../services/syncService');

function hasSshCredentials(node) {
    return !!(node?.ssh?.password || node?.ssh?.privateKey);
}

function runtimeErrorMessage(result, fallback) {
    return result?.error || result?.reason || fallback;
}

async function disableNodeRuntime(node) {
    if (node.type === 'virtual') {
        return { success: true, attempted: false, reason: 'virtual node' };
    }

    if (!hasSshCredentials(node)) {
        return { success: false, attempted: false, reason: 'SSH credentials not configured' };
    }

    try {
        return await nodeSetup.stopNodeRuntime(node);
    } catch (error) {
        return { success: false, attempted: true, error: error.message };
    }
}

async function startNodeRuntime(node) {
    if (node.type === 'virtual') {
        return { success: true, attempted: false, reason: 'virtual node' };
    }

    if (node.type === 'xray' && node.xray?.agentToken) {
        const synced = await syncService.updateNodeConfig(node);
        return synced
            ? { success: true, attempted: true, service: 'xray', via: 'agent-sync' }
            : { success: false, attempted: true, service: 'xray', via: 'agent-sync', error: 'Node startup could not be confirmed' };
    }

    if (!hasSshCredentials(node)) {
        return { success: false, attempted: false, reason: 'SSH credentials not configured' };
    }

    return nodeSetup.startNodeRuntime(node);
}

async function setNodeActive(req, res, active) {
    try {
        const node = await HyNode.findById(req.params.id);
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }

        if (!active) {
            const runtime = await disableNodeRuntime(node);
            const disabledNode = await HyNode.findByIdAndUpdate(
                req.params.id,
                { $set: { active: false, status: 'offline', onlineUsers: 0 } },
                { new: true }
            );

            await invalidateNodesCache();

            const warning = runtime.success === false
                ? runtimeErrorMessage(runtime, 'Runtime stop failed')
                : undefined;

            if (warning) {
                logger.warn(`[Nodes API] Disabled node ${node.name}, runtime stop warning: ${warning}`);
            } else {
                logger.info(`[Nodes API] Disabled node ${node.name}`);
            }

            return res.json({
                success: true,
                node: disabledNode,
                runtime,
                ...(warning ? { warning } : {}),
            });
        }

        let runtime;
        try {
            runtime = await startNodeRuntime(node);
        } catch (error) {
            runtime = { success: false, attempted: true, error: error.message };
        }

        if (!runtime.success) {
            const errorMessage = runtimeErrorMessage(runtime, 'Node startup could not be confirmed');
            const failedNode = await HyNode.findByIdAndUpdate(
                req.params.id,
                {
                    $set: {
                        active: false,
                        status: 'offline',
                        onlineUsers: 0,
                        lastError: errorMessage,
                    },
                },
                { new: true }
            );

            await invalidateNodesCache();

            logger.warn(`[Nodes API] Enable node ${node.name} failed: ${errorMessage}`);
            return res.status(500).json({
                error: errorMessage,
                node: failedNode,
                runtime,
            });
        }

        const enabledNode = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $set: { active: true, status: node.type === 'virtual' ? node.status : 'online', lastError: '' } },
            { new: true }
        );

        await invalidateNodesCache();

        logger.info(`[Nodes API] Enabled node ${node.name}`);

        res.json({ success: true, node: enabledNode, runtime });
    } catch (error) {
        logger.error(`[Nodes API] ${active ? 'Enable' : 'Disable'} node error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
}

/**
 * GET /nodes - List all nodes
 */
router.get('/', requireScope('nodes:read'), async (req, res) => {
    try {
        const { active, group, status } = req.query;
        
        const filter = {};
        if (active !== undefined) filter.active = active === 'true';
        if (group) filter.groups = group;
        if (status) filter.status = status;
        
        const nodes = await HyNode.find(filter)
            .populate('groups', 'name color')
            .sort({ name: 1 });
        
        res.json(nodes);
    } catch (error) {
        logger.error(`[Nodes API] List error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/check-ip - Check which protocol nodes exist for a given IP address.
 * Used by the UI to show a sibling-node hint when adding a node.
 * Returns { nodes: [{ type, name, _id }] } — only safe fields, no credentials.
 */
router.get('/check-ip', requireScope('nodes:read'), async (req, res) => {
    try {
        const ip = (req.query.ip || '').trim();
        if (!ip) return res.json({ nodes: [] });
        const nodes = await HyNode.find({ ip }).select('type name _id').lean();
        res.json({ nodes });
    } catch (error) {
        logger.error(`[Nodes API] check-ip error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id - Get a node
 */
router.get('/:id', requireScope('nodes:read'), async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id).populate('groups', 'name color');
        
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        // Count users on this node
        const userCount = await HyUser.countDocuments({
            nodes: node._id,
            enabled: true,
            isProbe: { $ne: true }
        });
        
        res.json({
            ...node.toObject(),
            userCount,
        });
    } catch (error) {
        logger.error(`[Nodes API] Get node error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/enable - Enable node in subscriptions
 */
router.post('/:id/enable', requireScope('nodes:write'), (req, res) => setNodeActive(req, res, true));

/**
 * POST /nodes/:id/disable - Disable node from subscriptions without stopping the service
 */
router.post('/:id/disable', requireScope('nodes:write'), (req, res) => setNodeActive(req, res, false));

/**
 * POST /nodes - Create a node
 */
router.post('/', requireScope('nodes:write'), async (req, res) => {
    try {
        const {
            name, ip, domain, sni, port, portRange, statsPort,
            groups, ssh, paths, settings, rankingCoefficient,
            type, xray, virtual, cascadeRole, country, comment,
            hopInterval, acme, masquerade, bandwidth,
            ignoreClientBandwidth, speedTest, disableUDP,
            udpIdleTimeout, sniff, quic, resolver, acl,
            aclRules, useTlsFiles,
        } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'name is required' });
        }

        if (type && !['hysteria', 'xray', 'virtual'].includes(type)) {
            return res.status(400).json({ error: 'type must be hysteria, xray, or virtual' });
        }

        const nodeType = type || 'hysteria';

        if (nodeType !== 'virtual' && !ip) {
            return res.status(400).json({ error: 'ip is required for hysteria and xray nodes' });
        }

        // Validate virtual-specific fields up-front (pre('validate') hook is
        // skipped on findOneAndUpdate but still runs on .save(); keeping the
        // explicit check here gives callers a clear 400 instead of a generic
        // ValidationError 500).
        if (nodeType === 'virtual') {
            const v = virtual || {};
            const selectMode = v.selectMode === 'group' ? 'group' : 'manual';
            if (selectMode === 'group' && !v.sourceGroup) {
                return res.status(400).json({ error: 'Virtual node (group): sourceGroup required' });
            }
            if (selectMode === 'manual' && (!Array.isArray(v.sources) || v.sources.length === 0)) {
                return res.status(400).json({ error: 'Virtual node (manual): at least one source required' });
            }
        }

        // Ensure no duplicate node for the same IP + protocol type
        // (skipped for virtual: it has no IP and the partial unique index excludes it).
        if (nodeType !== 'virtual') {
            const existing = await HyNode.findOne({ ip, type: nodeType });
            if (existing) {
                return res.status(409).json({ error: `A ${nodeType} node with this IP already exists` });
            }
        }

        const statsSecret = cryptoService.generateNodeSecret();

        // Resolve SSH: use caller-provided credentials, or inherit from sibling node on the same IP.
        // Virtual nodes never need SSH — emit empty (still encrypted) shell.
        let resolvedSsh;
        const rawSsh = ssh || {};
        if (nodeType === 'virtual') {
            resolvedSsh = cryptoService.encryptSshCredentials({});
        } else if (rawSsh.password || rawSsh.privateKey) {
            resolvedSsh = cryptoService.encryptSshCredentials(rawSsh);
        } else {
            const sibling = await HyNode.findOne({ ip, type: { $ne: nodeType } }).select('ssh').lean();
            resolvedSsh = sibling?.ssh || cryptoService.encryptSshCredentials({});
        }

        const nodeData = {
            name,
            ip: nodeType === 'virtual' ? null : ip,
            type: nodeType,
            domain: domain || '',
            sni: sni || '',
            port: port || 443,
            portRange: portRange || '20000-50000',
            statsPort: statsPort || 9999,
            statsSecret,
            groups: groups || [],
            ssh: resolvedSsh,
            paths: paths || {},
            settings: settings || {},
            rankingCoefficient: rankingCoefficient || 1.0,
            cascadeRole: nodeType === 'virtual' ? 'standalone' : (cascadeRole || 'standalone'),
            country: country || '',
            comment: typeof comment === 'string' ? comment.trim().slice(0, 500) : '',
            initScript: req.body.initScript || '',
            active: true,
            status: 'offline',
        };

        if (nodeType === 'xray' && xray) {
            nodeData.xray = xray;
        }

        if (nodeType === 'virtual') {
            const v = virtual || {};
            nodeData.virtual = {
                selectMode: v.selectMode === 'group' ? 'group' : 'manual',
                sources: Array.isArray(v.sources) ? v.sources : [],
                sourceGroup: v.sourceGroup || null,
                strategy: ['random', 'roundRobin', 'leastPing', 'leastLoad'].includes(v.strategy)
                    ? v.strategy
                    : 'leastLoad',
                fallbackToFirst: v.fallbackToFirst !== false,
                observatory: {
                    destination: (v.observatory?.destination || '').trim() || 'http://www.gstatic.com/generate_204',
                    connectivity: (v.observatory?.connectivity || '').trim(),
                    interval: (v.observatory?.interval || '').trim() || '1m',
                    timeout: (v.observatory?.timeout || '').trim() || '5s',
                    sampling: parseInt(v.observatory?.sampling, 10) || 3,
                },
            };
        }

        // Hysteria 2 advanced configuration fields
        const hy2Fields = { hopInterval, acme, masquerade, bandwidth, ignoreClientBandwidth, speedTest, disableUDP, udpIdleTimeout, sniff, quic, resolver, acl, aclRules, useTlsFiles };
        for (const [key, value] of Object.entries(hy2Fields)) {
            if (value !== undefined) nodeData[key] = value;
        }

        const node = new HyNode(nodeData);
        await node.save();

        await invalidateNodesCache();

        logger.info(`[Nodes API] Created ${nodeType} node ${name} (${nodeType === 'virtual' ? 'virtual' : ip})`);

        res.status(201).json(node);
    } catch (error) {
        logger.error(`[Nodes API] Create node error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /nodes/:id - Update a node
 */
router.put('/:id', requireScope('nodes:write'), async (req, res) => {
    try {
        const allowedUpdates = [
            'name', 'domain', 'sni', 'port', 'portRange', 'statsPort',
            'groups', 'ssh', 'paths', 'settings', 'active', 'rankingCoefficient',
            'type', 'xray', 'virtual', 'cascadeRole', 'country', 'comment',
            'hopInterval', 'acme', 'masquerade', 'bandwidth',
            'ignoreClientBandwidth', 'speedTest', 'disableUDP',
            'udpIdleTimeout', 'sniff', 'quic', 'resolver', 'acl',
            'aclRules', 'useTlsFiles', 'initScript',
        ];

        const updates = {};
        for (const key of allowedUpdates) {
            if (req.body[key] !== undefined) {
                if (key === 'ssh') {
                    updates[key] = cryptoService.encryptSshCredentials(req.body[key]);
                } else if (key === 'comment') {
                    updates[key] = typeof req.body[key] === 'string'
                        ? req.body[key].trim().slice(0, 500)
                        : '';
                } else {
                    updates[key] = req.body[key];
                }
            }
        }

        // findByIdAndUpdate bypasses pre('validate') hooks even with runValidators,
        // so enforce type-specific invariants explicitly here. We need the existing
        // doc to know the resulting type when only one of {type,virtual} is sent.
        const existing = await HyNode.findById(req.params.id).select('type ip virtual').lean();
        if (!existing) {
            return res.status(404).json({ error: 'Node not found' });
        }
        const nextType = updates.type || existing.type;
        const nextVirtual = updates.virtual !== undefined ? updates.virtual : existing.virtual;
        const nextIp = updates.ip !== undefined ? updates.ip : existing.ip;

        if (nextType === 'virtual') {
            const v = nextVirtual || {};
            if (v.selectMode === 'group' && !v.sourceGroup) {
                return res.status(400).json({ error: 'Virtual node (group): sourceGroup required' });
            }
            if (v.selectMode !== 'group' && (!Array.isArray(v.sources) || v.sources.length === 0)) {
                return res.status(400).json({ error: 'Virtual node (manual): at least one source required' });
            }
            // Virtual nodes carry no IP — clear any leftover from a prior type.
            updates.ip = null;
        } else if (!nextIp) {
            return res.status(400).json({ error: `Node type ${nextType} requires ip` });
        }

        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true }
        ).populate('groups', 'name color');

        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }

        // Sync SSH credentials to sibling node on the same IP (if SSH was updated)
        if (updates.ssh) {
            await HyNode.updateMany(
                { ip: node.ip, _id: { $ne: node._id } },
                { $set: { ssh: node.ssh } }
            );
        }

        // Auto-push config to the node if any config-affecting field changed.
        require('../services/syncService').schedulePush(node._id, updates);

        // Invalidate cache
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Updated node ${node.name}`);
        
        res.json(node);
    } catch (error) {
        logger.error(`[Nodes API] Update error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /nodes/:id - Delete a node
 */
router.delete('/:id', requireScope('nodes:write'), async (req, res) => {
    try {
        const node = await HyNode.findByIdAndDelete(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        // Remove the node from users' node lists
        await HyUser.updateMany(
            { nodes: node._id },
            { $pull: { nodes: node._id } }
        );
        
        // Invalidate cache
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Deleted node ${node.name}`);
        
        res.json({ success: true, message: 'Нода удалена' });
    } catch (error) {
        logger.error(`[Nodes API] Delete error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id/status - Get node status
 */
router.get('/:id/status', requireScope('nodes:read'), async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id).select('name status lastError onlineUsers lastSync traffic');
        
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        res.json({
            name: node.name,
            status: node.status,
            lastError: node.lastError,
            onlineUsers: node.onlineUsers,
            lastSync: node.lastSync,
            // Average load since the previous stats-collection poll (cron */5 * * * *,
            // see syncService.collectXrayTrafficStats/_collectHysteriaTrafficStats).
            // Not instantaneous — cheap byproduct of traffic accounting that's
            // already happening, not a live SSH probe.
            load: {
                txMbps: node.traffic?.txMbps || 0,
                rxMbps: node.traffic?.rxMbps || 0,
                updatedAt: node.traffic?.speedUpdatedAt || null,
            },
        });
    } catch (error) {
        logger.error(`[Nodes API] Get status error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/reset-status - Reset node status to online
 */
router.post('/:id/reset-status', requireScope('nodes:write'), async (req, res) => {
    try {
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $set: { status: 'online', lastError: '', healthFailures: 0 } },
            { new: true }
        );
        
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Node ${node.name} status reset to online`);
        
        res.json({ success: true, message: 'Статус сброшен', node });
    } catch (error) {
        logger.error(`[Nodes API] Status reset error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id/agent-info - Fetch live info from CC Agent (version, users, uptime)
 */
router.get('/:id/agent-info', requireScope('nodes:read'), async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        if (!node) return res.status(404).json({ error: 'Node not found' });
        if (node.type !== 'xray') return res.status(400).json({ error: 'Not an Xray node' });

        const syncService = require('../services/syncService');
        const response = await syncService._agentRequest(node, 'GET', '/info');
        res.json(response.data);
    } catch (error) {
        logger.error(`[Nodes API] agent-info error: ${error.message}`);
        res.status(502).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/sync - Force sync a single node
 */
router.post('/:id/sync', requireScope('nodes:write'), async (req, res) => {
    try {
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $set: { status: 'syncing' } },
            { new: true }
        );
        
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        await invalidateNodesCache();
        
        const syncService = require('../services/syncService');
        syncService.updateNodeConfig(node).catch(err => {
            logger.error(`[Nodes API] Sync error for ${node.name}: ${err.message}`);
        });
        
        logger.info(`[Nodes API] Started sync for node ${node.name}`);
        
        res.json({ success: true, message: 'Синхронизация запущена' });
    } catch (error) {
        logger.error(`[Nodes API] Start sync error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id/users - Users on the node
 */
router.get('/:id/users', requireScope('nodes:read'), async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        const users = await HyUser.find({
            nodes: node._id,
            enabled: true,
            isProbe: { $ne: true }
        }).select('userId username traffic');
        
        res.json(users);
    } catch (error) {
        logger.error(`[Nodes API] Get users error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/groups - Add node to groups
 */
router.post('/:id/groups', requireScope('nodes:write'), async (req, res) => {
    try {
        const { groups } = req.body;
        
        if (!Array.isArray(groups)) {
            return res.status(400).json({ error: 'groups должен быть массивом' });
        }
        
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $addToSet: { groups: { $each: groups } } },
            { new: true }
        ).populate('groups', 'name color');
        
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        // Invalidate cache
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Added groups for node ${node.name}`);
        res.json(node);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /nodes/:id/groups/:groupId - Remove node from a group
 */
router.delete('/:id/groups/:groupId', requireScope('nodes:write'), async (req, res) => {
    try {
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $pull: { groups: req.params.groupId } },
            { new: true }
        ).populate('groups', 'name color');
        
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        // Invalidate cache
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Removed group ${req.params.groupId} from node ${node.name}`);
        res.json(node);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id/config - Get the node's current config
 */
router.get('/:id/config', requireScope('nodes:read'), async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        // Generate config with HTTP authorization
        const configGenerator = require('../services/configGenerator');
        const config = require('../../config');
        
        const baseUrl = process.env.BASE_URL || `http://localhost:${config.PORT}`;
        const authUrl = `${baseUrl}/api/auth`;
        
        const configContent = configGenerator.generateNodeConfig(node, authUrl);
        
        res.type('text/yaml').send(configContent);
    } catch (error) {
        logger.error(`[Nodes API] Config generation error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/setup-port-hopping - Configure port hopping on the node
 */
router.post('/:id/setup-port-hopping', requireScope('nodes:write'), async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        const syncService = require('../services/syncService');
        const success = await syncService.setupPortHopping(node);
        
        if (success) {
            res.json({ success: true, message: 'Port hopping настроен' });
        } else {
            res.status(500).json({ error: 'Не удалось настроить port hopping' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/update-config - Update config on the node via SSH
 */
router.post('/:id/update-config', requireScope('nodes:write'), async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        const syncService = require('../services/syncService');
        const success = await syncService.updateNodeConfig(node);
        
        if (success) {
            res.json({ success: true, message: 'Конфиг обновлён' });
        } else {
            res.status(500).json({ error: 'Не удалось обновить конфиг' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/setup - Auto-setup node via SSH
 *
 * Installs Hysteria, generates certs, configures port hopping, opens firewall ports
 * and starts the service — same as the one-click setup in the web panel.
 *
 * This is a long-running operation (30s–2min). The response is returned only after
 * all steps complete. Set your HTTP client timeout accordingly (e.g. 3–5 minutes).
 *
 * Body (all optional, all default to true):
 *   installHysteria  {boolean}  Install/update Hysteria binary
 *   setupPortHopping {boolean}  Configure iptables NAT rules for port range
 *   restartService   {boolean}  Enable and restart hysteria-server systemd unit
 *
 * Returns:
 *   200 { success: true,  logs: string[] }
 *   500 { success: false, error: string, logs: string[] }
 */
router.post('/:id/setup', requireScope('nodes:write'), async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);

        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }

        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ error: 'SSH credentials not configured for this node' });
        }

        const {
            installHysteria  = true,
            setupPortHopping = true,
            restartService   = true,
        } = req.body || {};

        if (node.type === 'virtual') {
            return res.status(400).json({ success: false, error: 'Virtual nodes have no remote server to set up' });
        }

        logger.info(`[Nodes API] Auto-setup started for ${node.name} (${node.ip}) via API`);

        const nodeSetup = require('../services/nodeSetup');

        let result;
        if (node.type === 'xray') {
            result = await nodeSetup.setupXrayNode(node, { restartService });
        } else {
            result = await nodeSetup.setupNode(node, {
                installHysteria,
                setupPortHopping,
                restartService,
            });
        }

        if (result.success) {
            const updateFields = { status: 'online', lastSync: new Date(), lastError: '', healthFailures: 0 };
            if (node.type !== 'xray') updateFields.useTlsFiles = result.useTlsFiles;
            await HyNode.findByIdAndUpdate(req.params.id, { $set: updateFields });
            await invalidateNodesCache();
            logger.info(`[Nodes API] Auto-setup completed for ${node.name} (${node.type})`);
            res.json({ success: true, logs: result.logs });
        } else {
            await HyNode.findByIdAndUpdate(req.params.id, {
                $set: { status: 'error', lastError: result.error, healthFailures: 0 },
            });
            logger.warn(`[Nodes API] Auto-setup failed for ${node.name}: ${result.error}`);
            res.status(500).json({ success: false, error: result.error, logs: result.logs });
        }
    } catch (error) {
        logger.error(`[Nodes API] Setup error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
