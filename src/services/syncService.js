/**
 * Hysteria + Xray nodes sync service
 *
 * Hysteria: HTTP auth callback — no user sync needed, auth happens in realtime.
 * Xray: managed via CC Agent HTTP API (add/remove users, traffic stats, health).
 *       SSH is only used for full config uploads (rare: node setup / config changes).
 *
 * This service handles:
 * - Node config updates (Hysteria YAML / Xray JSON)
 * - Traffic stats collection
 * - Node health checks
 * - Xray user add/remove via Agent HTTP API (no SSH per-operation)
 */

const HyUser = require('../models/hyUserModel');
const HyNode = require('../models/hyNodeModel');
const Settings = require('../models/settingsModel');
const NodeSSH = require('./nodeSSH');
const configGenerator = require('./configGenerator');
const cache = require('./cacheService');
const logger = require('../utils/logger');
const axios = require('axios');
const https = require('https');
const config = require('../../config');
const webhook = require('./webhookService');
const { getPanelCertificates, isSameVpsAsPanel } = require('./nodeSetup');

// HTTPS agent that ignores self-signed certs (agent uses self-signed cert by default)
const selfSignedAgent = new https.Agent({ rejectUnauthorized: false });

// Mark node offline after this many consecutive health check failures (1 check/min)
const HEALTH_FAILURE_THRESHOLD = 3;

class SyncService {
    constructor() {
        this.isSyncing = false;
        this.lastSyncTime = null;
        // Track which users have already received a traffic/expiry webhook in this
        // process lifetime to avoid spamming the same event every stats cycle.
        this._notifiedTraffic = new Set();
        this._notifiedExpired = new Set();
    }

    /**
     * Get HTTP auth URL
     */
    getAuthUrl() {
        return `${config.BASE_URL}/api/auth`;
    }

    // ==================== XRAY AGENT METHODS ====================

    /**
     * Make an authenticated HTTP request to the CC Agent on a node.
     * Uses HTTPS if agentTls !== false, HTTP otherwise.
     * Self-signed certificates are accepted.
     */
    async _agentRequest(node, method, path, body = null) {
        const xray = node.xray || {};
        const useTls = xray.agentTls !== false;
        const port = xray.agentPort || 62080;
        const token = xray.agentToken;

        if (!token) {
            throw new Error(`[Agent] Node ${node.name} has no agentToken — install agent first`);
        }

        const protocol = useTls ? 'https' : 'http';
        const url = `${protocol}://${node.ip}:${port}${path}`;

        const options = {
            method,
            url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
            validateStatus: null, // handle errors manually
        };

        if (body !== null) {
            options.data = body;
        }

        if (useTls) {
            options.httpsAgent = selfSignedAgent;
        }

        const response = await axios(options);

        if (response.status === 401) {
            throw new Error(`[Agent] Unauthorized — check agentToken for node ${node.name}`);
        }

        return response;
    }

    /**
     * Check agent health and update node metadata (xrayVersion, agentVersion, agentStatus).
     * Called by the periodic health check loop.
     */
    async checkXrayAgentHealth(node) {
        try {
            const response = await this._agentRequest(node, 'GET', '/info');
            const data = response.data || {};

            await HyNode.updateOne({ _id: node._id }, {
                $set: {
                    xrayVersion: data.xray_version || '',
                    agentVersion: data.agent_version || '',
                    agentStatus: 'online',
                    agentLastSeen: new Date(),
                    onlineUsers: data.users_count || 0,
                    status: 'online',
                    healthFailures: 0,
                },
            });

            return { online: true, xrayVersion: data.xray_version, usersCount: data.users_count };
        } catch (error) {
            logger.warn(`[Agent] ${node.name} health check failed: ${error.message}`);

            const prevNode = await HyNode.findOneAndUpdate(
                { _id: node._id },
                {
                    $inc: { healthFailures: 1 },
                    $set: { agentStatus: 'offline', lastError: `Agent: ${error.message}` },
                }
            );

            const failures = (prevNode?.healthFailures || 0) + 1;

            if (failures >= HEALTH_FAILURE_THRESHOLD && prevNode?.status === 'online') {
                await HyNode.updateOne({ _id: node._id }, { $set: { status: 'offline' } });
                webhook.emit(webhook.EVENTS.NODE_OFFLINE, { nodeId: node._id, name: node.name, lastError: error.message });
                logger.warn(`[Agent] ${node.name}: marked offline after ${failures} consecutive failures`);
            }
            return { online: false };
        }
    }

    /**
     * Add a single user to a running Xray node via Agent HTTP API.
     * No SSH, no restart needed.
     */
    async addXrayUser(node, user) {
        if (!user.xrayUuid) {
            logger.warn(`[Agent] User ${user.userId} has no xrayUuid, skipping`);
            return false;
        }

        const xray = node.xray || {};
        const flow = ((xray.security === 'reality' || xray.security === 'tls') && xray.transport === 'tcp')
            ? (xray.flow || 'xtls-rprx-vision')
            : '';

        try {
            await this._agentRequest(node, 'POST', '/users', {
                id: user.xrayUuid,
                email: user.userId,
                flow,
            });
            logger.info(`[Agent] Added user ${user.userId} to ${node.name}`);
            return true;
        } catch (error) {
            logger.error(`[Agent] addXrayUser ${node.name}/${user.userId}: ${error.message}`);
            return false;
        }
    }

    /**
     * Remove a single user from a running Xray node via Agent HTTP API.
     * No SSH, no restart needed.
     */
    async removeXrayUser(node, user) {
        try {
            await this._agentRequest(node, 'DELETE', `/users/${encodeURIComponent(user.userId)}`);
            logger.info(`[Agent] Removed user ${user.userId} from ${node.name}`);
            return true;
        } catch (error) {
            logger.error(`[Agent] removeXrayUser ${node.name}/${user.userId}: ${error.message}`);
            return false;
        }
    }

    /**
     * Get all enabled users for a given node (by groups or explicit node list)
     */
    async _getUsersForNode(node) {
        const nodeId = node._id.toString();
        // Users with explicit node assignment
        const byNodes = await HyUser.find({ nodes: node._id, enabled: true }).lean();
        // Users linked via groups
        const nodeGroupIds = (node.groups || []).map(g => g._id?.toString() || g.toString());
        let byGroups = [];
        if (nodeGroupIds.length > 0) {
            byGroups = await HyUser.find({ groups: { $in: node.groups }, enabled: true, nodes: { $size: 0 } }).lean();
        } else {
            // Node has no groups — all users without group assignment
            byGroups = await HyUser.find({ enabled: true, nodes: { $size: 0 }, groups: { $size: 0 } }).lean();
        }
        // Merge and deduplicate by userId
        const seen = new Set();
        return [...byNodes, ...byGroups].filter(u => {
            if (seen.has(u.userId)) return false;
            seen.add(u.userId);
            return true;
        });
    }

    /**
     * Add user to all active Xray nodes they belong to (fire-and-forget safe)
     */
    async addUserToAllXrayNodes(user) {
        const xrayNodes = await HyNode.find({ type: 'xray', active: true });
        for (const node of xrayNodes) {
            const nodeUsers = await this._getUsersForNode(node);
            const belongs = nodeUsers.some(u => u.userId === user.userId);
            if (belongs) {
                this.addXrayUser(node, user).catch(() => {});
            }
        }
    }

    /**
     * Remove user from all active Xray nodes (fire-and-forget safe)
     */
    async removeUserFromAllXrayNodes(user) {
        const xrayNodes = await HyNode.find({ type: 'xray', active: true });
        for (const node of xrayNodes) {
            this.removeXrayUser(node, user).catch(() => {});
        }
    }

    /**
     * Full config update for an Xray node.
     *
     * Step 1: Upload xray config.json via SSH (inbound/outbound settings, no user list).
     * Step 2: Restart Xray via Agent API (no SSH restart needed).
     * Step 3: Sync all users to Xray runtime via Agent /sync endpoint.
     *
     * SSH is only used for the config upload. If agent is not yet installed,
     * falls back to SSH restart.
     */
    async updateXrayNodeConfig(node) {
        logger.info(`[Xray Sync] Updating config for node ${node.name} (${node.ip})`);
        await HyNode.updateOne({ _id: node._id }, { $set: { status: 'syncing' } });

        const users = await this._getUsersForNode(node);

        // Step 1: Upload config.json via SSH (only if SSH is configured)
        if (node.ssh?.password || node.ssh?.privateKey) {
            const ssh = new NodeSSH(node);
            try {
                await ssh.connect();
                let configContent = configGenerator.generateXrayConfig(node, users);

                // Apply cascade reverse-portal settings if this node is a portal
                try {
                    const CascadeLink = require('../models/cascadeLinkModel');
                    const portalLinks = await CascadeLink.find({ portalNode: node._id, active: true });
                    if (portalLinks.length > 0) {
                        const configObj = JSON.parse(configContent);
                        const inboundTag = node.xray?.inboundTag || 'vless-in';
                        configGenerator.applyReversePortal(configObj, portalLinks, inboundTag);
                        configContent = JSON.stringify(configObj, null, 2);
                        logger.info(`[Xray Sync] Node ${node.name}: applied ${portalLinks.length} cascade portal link(s)`);
                    }
                } catch (cascadeErr) {
                    logger.warn(`[Xray Sync] Node ${node.name}: cascade apply skipped: ${cascadeErr.message}`);
                }

                await ssh.uploadContent(configContent, node.paths?.config || '/usr/local/etc/xray/config.json');
                logger.info(`[Xray Sync] Node ${node.name}: config uploaded`);
            } catch (error) {
                logger.warn(`[Xray Sync] Node ${node.name}: config upload failed (SSH): ${error.message}`);
            } finally {
                ssh.disconnect();
            }
        }

        // Step 2: Restart Xray via Agent (preferred) or SSH fallback
        const hasAgent = !!(node.xray?.agentToken);
        if (hasAgent) {
            try {
                // /restart blocks until Xray is running and users are restored (~2-3s)
                await this._agentRequest(node, 'POST', '/restart');
                logger.info(`[Xray Sync] Node ${node.name}: restarted via agent`);
            } catch (error) {
                logger.warn(`[Xray Sync] Node ${node.name}: agent restart failed: ${error.message}`);
            }
        } else if (node.ssh?.password || node.ssh?.privateKey) {
            const ssh = new NodeSSH(node);
            try {
                await ssh.connect();
                await ssh.exec('systemctl restart xray');
                logger.info(`[Xray Sync] Node ${node.name}: restarted via SSH`);
            } catch (error) {
                logger.warn(`[Xray Sync] Node ${node.name}: SSH restart failed: ${error.message}`);
            } finally {
                ssh.disconnect();
            }
        }

        // Step 3: Sync users via Agent (builds the runtime user list in Xray without restart)
        if (hasAgent) {
            try {
                const xray = node.xray || {};
                const userPayload = users.map(u => {
                    const flow = ((xray.security === 'reality' || xray.security === 'tls') && xray.transport === 'tcp')
                        ? (xray.flow || 'xtls-rprx-vision') : '';
                    return { id: u.xrayUuid, email: u.userId, flow };
                }).filter(u => u.id);

                await this._agentRequest(node, 'POST', '/sync', { users: userPayload });
                logger.info(`[Xray Sync] Node ${node.name}: synced ${userPayload.length} users via agent`);
            } catch (error) {
                logger.warn(`[Xray Sync] Node ${node.name}: agent sync failed: ${error.message}`);
            }
        }

        // Update node status
        try {
            const health = await this.checkXrayAgentHealth(node);
            if (!health.online && hasAgent) {
                await HyNode.updateOne({ _id: node._id }, { $set: { status: 'error', lastSync: new Date(), healthFailures: 0 } });
                return false;
            }
        } catch (_) {}

        await HyNode.updateOne({ _id: node._id }, {
            $set: { status: 'online', lastSync: new Date(), lastError: '', healthFailures: 0 },
        });

        logger.info(`[Xray Sync] Node ${node.name}: sync complete, ${users.length} users`);
        return true;
    }

    /**
     * Collect traffic stats from Xray node via Agent GET /stats.
     * Agent accumulates stats between polls (Xray counters are reset on each agent collection).
     */
    async collectXrayTrafficStats(node) {
        if (!(node.xray?.agentToken)) {
            logger.debug(`[Agent Stats] ${node.name}: no agent token, skipping`);
            return;
        }

        try {
            const response = await this._agentRequest(node, 'GET', '/stats');
            const stats = response.data || {};

            if (Object.keys(stats).length === 0) return;

            let nodeTx = 0;
            let nodeRx = 0;
            const bulkOps = [];
            const now = new Date();

            for (const [email, traffic] of Object.entries(stats)) {
                const tx = traffic.tx || 0;
                const rx = traffic.rx || 0;
                if (tx === 0 && rx === 0) continue;

                nodeTx += tx;
                nodeRx += rx;

                // email == userId (as set in configGenerator and agent)
                bulkOps.push({
                    updateOne: {
                        filter: { userId: email },
                        update: {
                            $inc: { 'traffic.tx': tx, 'traffic.rx': rx },
                            $set: { 'traffic.lastUpdate': now },
                        },
                    },
                });
            }

            if (bulkOps.length > 0) {
                const result = await HyUser.bulkWrite(bulkOps, { ordered: false });
                logger.debug(`[Agent Stats] ${node.name}: updated ${result.modifiedCount}/${bulkOps.length} users`);
                this._checkUserLimits(Object.keys(stats)).catch(() => {});
            }

            if (nodeTx > 0 || nodeRx > 0) {
                await HyNode.updateOne(
                    { _id: node._id },
                    {
                        $inc: { 'traffic.tx': nodeTx, 'traffic.rx': nodeRx },
                        $set: { 'traffic.lastUpdate': now },
                    }
                );
                logger.info(`[Agent Stats] ${node.name}: ${bulkOps.length} users, ↑${(nodeTx / 1024 / 1024).toFixed(1)}MB ↓${(nodeRx / 1024 / 1024).toFixed(1)}MB`);
            }
        } catch (error) {
            logger.error(`[Agent Stats] ${node.name} error: ${error.message}`);
        }
    }

    /**
     * Get online users and health info from Xray node via Agent GET /info.
     * Also updates xrayVersion and agentStatus in DB.
     */
    async getXrayOnlineUsers(node) {
        if (!(node.xray?.agentToken)) {
            logger.debug(`[Agent] ${node.name}: no agent token, skipping health check`);
            return 0;
        }

        try {
            const response = await this._agentRequest(node, 'GET', '/info');
            const data = response.data || {};

            const usersCount = data.users_count || 0;

            const prevNode = await HyNode.findOneAndUpdate(
                { _id: node._id },
                {
                    $set: {
                        onlineUsers: usersCount,
                        status: 'online',
                        healthFailures: 0,
                        xrayVersion: data.xray_version || '',
                        agentVersion: data.agent_version || '',
                        agentStatus: 'online',
                        agentLastSeen: new Date(),
                    },
                }
            );

            if (prevNode && prevNode.status !== 'online') {
                webhook.emit(webhook.EVENTS.NODE_ONLINE, { nodeId: node._id, name: node.name });
            }

            return usersCount;
        } catch (error) {
            logger.warn(`[Agent] ${node.name}: unavailable - ${error.message}`);

            const prevNode = await HyNode.findOneAndUpdate(
                { _id: node._id },
                {
                    $inc: { healthFailures: 1 },
                    $set: { agentStatus: 'offline', lastError: `Agent: ${error.message}` },
                }
            );

            const failures = (prevNode?.healthFailures || 0) + 1;

            if (failures >= HEALTH_FAILURE_THRESHOLD && prevNode?.status === 'online') {
                await HyNode.updateOne({ _id: node._id }, { $set: { status: 'offline' } });
                webhook.emit(webhook.EVENTS.NODE_OFFLINE, { nodeId: node._id, name: node.name, lastError: error.message });
                logger.warn(`[Agent] ${node.name}: marked offline after ${failures} consecutive failures`);
            }
            return 0;
        }
    }

    // ==================== HYSTERIA / COMMON METHODS ====================

    /**
     * Update config on a specific node (dispatches by type)
     */
    async updateNodeConfig(node) {
        if (node.type === 'xray') {
            return this.updateXrayNodeConfig(node);
        }
        return this._updateHysteriaNodeConfig(node);
    }

    /**
     * Update Hysteria config on a specific node
     */
    async _updateHysteriaNodeConfig(node) {
        logger.info(`[Sync] Updating config for node ${node.name} (${node.ip})`);
        
        await HyNode.updateOne(
            { _id: node._id },
            { $set: { status: 'syncing' } }
        );
        
        const ssh = new NodeSSH(node);
        
        try {
            await ssh.connect();
            
            // Determine if this node uses TLS files (not ACME)
            const useTlsFiles = node.useTlsFiles || !node.domain;
            
            // For same-VPS nodes or nodes using TLS files, ensure certificates exist
            if (useTlsFiles || isSameVpsAsPanel(node)) {
                const panelCerts = getPanelCertificates(config.PANEL_DOMAIN);
                const certResult = await ssh.ensureCertificates(panelCerts);
                
                if (certResult.success) {
                    if (certResult.action === 'uploaded') {
                        logger.info(`[Sync] ${node.name}: certificates uploaded from panel`);
                    }
                } else {
                    logger.warn(`[Sync] ${node.name}: certificate issue - ${certResult.error}`);
                    logger.warn(`[Sync] ${node.name}: Hysteria may fail to start without valid certificates`);
                }
            }
            
            // Use custom config or generate automatically
            let configContent;
            const customConfig = (node.customConfig || '').trim();
            if (node.useCustomConfig && customConfig && customConfig.length > 50) {
                if (!customConfig.includes('listen:')) {
                    throw new Error('Custom config invalid: missing listen:');
                }
                if (!customConfig.includes('acme:') && !customConfig.includes('tls:')) {
                    throw new Error('Custom config invalid: missing acme: or tls:');
                }
                configContent = customConfig;
                logger.info(`[Sync] Using custom config for ${node.name}`);
            } else {
                if (node.useCustomConfig) {
                    logger.warn(`[Sync] Custom config for ${node.name} is empty or too short, using auto-generation`);
                }
                const authUrl = this.getAuthUrl();
                const settings = await Settings.get();
                const authInsecure = settings?.nodeAuth?.insecure ?? true;
                configContent = configGenerator.generateNodeConfig(node, authUrl, { authInsecure, useTlsFiles });
            }
            
            // Update config on node
            const success = await ssh.updateConfig(configContent);
            
            if (success) {
                const isRunning = await ssh.checkHysteriaStatus();
                
                await HyNode.updateOne(
                    { _id: node._id },
                    {
                        $set: {
                            status: isRunning ? 'online' : 'error',
                            lastSync: new Date(),
                            lastError: isRunning ? '' : 'Service not running after sync',
                            healthFailures: 0,
                        }
                    }
                );
                
                logger.info(`[Sync] Node ${node.name}: config updated`);
                return true;
            } else {
                throw new Error('Failed to update config');
            }
        } catch (error) {
            logger.error(`[Sync] Node ${node.name} error: ${error.message}`);
            await HyNode.updateOne(
                { _id: node._id },
                { $set: { status: 'error', lastError: error.message, healthFailures: 0 } }
            );
            webhook.emit(webhook.EVENTS.NODE_ERROR, { nodeId: node._id, name: node.name, error: error.message });
            return false;
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Update configs on all active nodes (parallel, up to 5 concurrent)
     */
    async syncAllNodes() {
        if (this.isSyncing) {
            logger.warn('[Sync] Sync already in progress');
            return;
        }
        
        this.isSyncing = true;
        const syncStart = Date.now();
        logger.info('[Sync] Starting sync for all nodes');
        
        try {
            const nodes = await HyNode.find({ active: true });
            
            // Parallel sync with concurrency limit
            const CONCURRENCY = 5;
            for (let i = 0; i < nodes.length; i += CONCURRENCY) {
                const batch = nodes.slice(i, i + CONCURRENCY);
                await Promise.allSettled(
                    batch.map(node => this.updateNodeConfig(node))
                );
            }
            
            this.lastSyncTime = new Date();
            logger.info('[Sync] Sync completed');
            webhook.emit(webhook.EVENTS.SYNC_COMPLETED, {
                nodesCount: nodes.length,
                duration: Math.round((Date.now() - syncStart) / 1000),
            });
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Collect traffic stats from node and update users (dispatches by type)
     */
    async collectTrafficStats(node) {
        if (node.type === 'xray') {
            return this.collectXrayTrafficStats(node);
        }
        return this._collectHysteriaTrafficStats(node);
    }

    /**
     * Collect traffic stats from Hysteria node via HTTP API
     * Uses bulkWrite for optimization (99% fewer MongoDB queries)
     */
    async _collectHysteriaTrafficStats(node) {
        try {
            if (!node.statsPort || !node.statsSecret) {
                return;
            }
            
            const url = `http://${node.ip}:${node.statsPort}/traffic?clear=true`;
            
            const response = await axios.get(url, {
                headers: { Authorization: node.statsSecret },
                timeout: 10000,
            });
            
            const stats = response.data;
            
            // Sum node traffic
            let nodeTx = 0;
            let nodeRx = 0;
            
            // Prepare bulk operations for all users
            const bulkOps = [];
            const now = new Date();
            
            for (const [userId, traffic] of Object.entries(stats)) {
                nodeTx += traffic.tx || 0;
                nodeRx += traffic.rx || 0;
                
                bulkOps.push({
                    updateOne: {
                        filter: { userId },
                        update: {
                            $inc: {
                                'traffic.tx': traffic.tx || 0,
                                'traffic.rx': traffic.rx || 0,
                            },
                            $set: { 'traffic.lastUpdate': now }
                        }
                    }
                });
            }
            
            // Execute bulk update (1 query instead of N)
            if (bulkOps.length > 0) {
                const result = await HyUser.bulkWrite(bulkOps, { ordered: false });
                logger.debug(`[Stats] ${node.name}: Bulk updated ${result.modifiedCount}/${bulkOps.length} users`);

                // Check traffic limits and expiry for affected users (fire-and-forget)
                this._checkUserLimits(Object.keys(stats)).catch(() => {});
            }
            
            // Update node traffic
            await HyNode.updateOne(
                { _id: node._id },
                {
                    $inc: {
                        'traffic.tx': nodeTx,
                        'traffic.rx': nodeRx,
                    },
                    $set: { 'traffic.lastUpdate': now }
                }
            );
            
            logger.info(`[Stats] ${node.name}: ${Object.keys(stats).length} users, traffic: ↑${(nodeTx / 1024 / 1024).toFixed(1)}MB ↓${(nodeRx / 1024 / 1024).toFixed(1)}MB`);
        } catch (error) {
            logger.error(`[Stats] ${node.name} error: ${error.message}`);
        }
    }

    /**
     * Get online users from node (dispatches by type)
     */
    async getOnlineUsers(node) {
        if (node.type === 'xray') {
            return this.getXrayOnlineUsers(node);
        }
        return this._getHysteriaOnlineUsers(node);
    }

    /**
     * Get online users from Hysteria node via HTTP Stats API
     */
    async _getHysteriaOnlineUsers(node) {
        try {
            // If Stats API not configured - skip, don't change status
            if (!node.statsPort || !node.statsSecret) {
                logger.debug(`[Stats] ${node.name}: Stats API not configured, skipping`);
                return 0;
            }
            
            const url = `http://${node.ip}:${node.statsPort}/online`;
            
            const response = await axios.get(url, {
                headers: { Authorization: node.statsSecret },
                timeout: 5000,
            });
            
            const online = Object.keys(response.data).length;
            
            const prevNode = await HyNode.findOneAndUpdate(
                { _id: node._id },
                { $set: { onlineUsers: online, status: 'online', healthFailures: 0 } }
            );

            if (prevNode && prevNode.status !== 'online') {
                webhook.emit(webhook.EVENTS.NODE_ONLINE, { nodeId: node._id, name: node.name });
            }
            
            if (online > 0) {
                logger.info(`[Stats] ${node.name}: ${online} online`);
            }
            return online;
        } catch (error) {
            logger.warn(`[Stats] ${node.name}: Stats unavailable - ${error.message}`);

            const prevNode = await HyNode.findOneAndUpdate(
                { _id: node._id },
                {
                    $inc: { healthFailures: 1 },
                    $set: { lastError: `Stats: ${error.message}` },
                }
            );

            const failures = (prevNode?.healthFailures || 0) + 1;

            if (failures >= HEALTH_FAILURE_THRESHOLD && prevNode?.status === 'online') {
                await HyNode.updateOne({ _id: node._id }, { $set: { status: 'offline' } });
                webhook.emit(webhook.EVENTS.NODE_OFFLINE, { nodeId: node._id, name: node.name, lastError: error.message });
                logger.warn(`[Stats] ${node.name}: marked offline after ${failures} consecutive failures`);
            }
            return 0;
        }
    }

    /**
     * Kick user from all nodes
     */
    async kickUser(userId) {
        const user = await HyUser.findOne({ userId }).populate('nodes', 'name ip statsPort statsSecret');
        
        if (!user) {
            return;
        }
        
        for (const node of user.nodes) {
            try {
                if (!node.statsPort || !node.statsSecret) continue;
                
                const url = `http://${node.ip}:${node.statsPort}/kick`;
                
                await axios.post(url, [userId], {
                    headers: {
                        Authorization: node.statsSecret,
                        'Content-Type': 'application/json',
                    },
                    timeout: 5000,
                });
                
                logger.info(`[Kick] ${userId} kicked from ${node.name}`);
            } catch (error) {
                logger.error(`[Kick] Kick error on ${node.name}: ${error.message}`);
            }
        }
    }

    /**
     * Collect stats from all nodes (parallel with concurrency limit)
     */
    async collectAllStats() {
        const nodes = await HyNode.find({ active: true });
        
        // Parallel processing with concurrency limit
        const CONCURRENCY = 5;
        for (let i = 0; i < nodes.length; i += CONCURRENCY) {
            const batch = nodes.slice(i, i + CONCURRENCY);
            await Promise.allSettled(
                batch.flatMap(node => [
                    this.collectTrafficStats(node),
                    this.getOnlineUsers(node)
                ])
            );
        }
        
        // Update last stats collection time
        this.lastSyncTime = new Date();
        
        // Invalidate traffic stats cache (data updated)
        await cache.invalidateTrafficStats();
    }

    /**
     * Health check all nodes (parallel)
     */
    async healthCheck() {
        const nodes = await HyNode.find({ active: true });
        
        // Parallel check with concurrency limit
        const CONCURRENCY = 5;
        for (let i = 0; i < nodes.length; i += CONCURRENCY) {
            const batch = nodes.slice(i, i + CONCURRENCY);
            await Promise.allSettled(
                batch.map(node => this.getOnlineUsers(node))
            );
        }
    }

    /**
     * Check traffic limits and expiry for a list of userIds after stats update.
     * Emits user.traffic_exceeded and user.expired webhooks only ONCE per user
     * (when they first cross the threshold, not on every subsequent cycle).
     *
     * Uses a simple in-memory Set to deduplicate across calls within a process lifetime.
     * The Set is cleared on process restart, which is acceptable — one extra notification
     * on redeploy is not a problem.
     */
    async _checkUserLimits(userIds) {
        if (!userIds || userIds.length === 0) return;

        const users = await HyUser.find(
            { userId: { $in: userIds }, enabled: true },
            { userId: 1, trafficLimit: 1, 'traffic.tx': 1, 'traffic.rx': 1, expireAt: 1 }
        ).lean();

        const now = new Date();
        for (const user of users) {
            // Traffic exceeded — emit only once per user per process lifetime
            if (user.trafficLimit > 0) {
                const used = (user.traffic?.tx || 0) + (user.traffic?.rx || 0);
                if (used >= user.trafficLimit && !this._notifiedTraffic.has(user.userId)) {
                    this._notifiedTraffic.add(user.userId);
                    webhook.emit(webhook.EVENTS.USER_TRAFFIC_EXCEEDED, {
                        userId: user.userId,
                        used,
                        limit: user.trafficLimit,
                    });
                } else if (used < user.trafficLimit) {
                    // Traffic was reset — allow future notifications
                    this._notifiedTraffic.delete(user.userId);
                }
            }
            // Expired — emit only once per user per process lifetime
            if (user.expireAt && new Date(user.expireAt) < now && !this._notifiedExpired.has(user.userId)) {
                this._notifiedExpired.add(user.userId);
                webhook.emit(webhook.EVENTS.USER_EXPIRED, {
                    userId: user.userId,
                    expiredAt: user.expireAt,
                });
            }
        }
    }

    /**
     * Setup port hopping on node
     */
    async setupPortHopping(node) {
        const ssh = new NodeSSH(node);
        
        try {
            await ssh.connect();
            await ssh.setupPortHopping(node.portRange);
            return true;
        } catch (error) {
            logger.error(`[PortHop] Error on ${node.name}: ${error.message}`);
            return false;
        } finally {
            ssh.disconnect();
        }
    }
}

module.exports = new SyncService();
