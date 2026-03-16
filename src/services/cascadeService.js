/**
 * Cascade service — manages Xray reverse-proxy tunnels between nodes.
 *
 * Handles deployment, health checking, and topology retrieval for
 * CascadeLink connections (Portal <-> Bridge pairs).
 */

const CascadeLink = require('../models/cascadeLinkModel');
const HyNode = require('../models/hyNodeModel');
const configGenerator = require('./configGenerator');
const NodeSSH = require('./nodeSSH');
const cache = require('./cacheService');
const logger = require('../utils/logger');
const webhook = require('./webhookService');

const TOPOLOGY_CACHE_KEY = 'c3:cascade:topology';
const TOPOLOGY_CACHE_TTL = 15;

/**
 * Safe Redis helpers — cache module exposes .redis but may not be connected.
 */
async function cacheGet(key) {
    try { return cache.redis?.get ? await cache.redis.get(key) : null; } catch { return null; }
}
async function cacheSet(key, value, ttl) {
    try { if (cache.redis?.set) await cache.redis.set(key, value, 'EX', ttl); } catch {}
}
async function cacheDel(key) {
    try { if (cache.redis?.del) await cache.redis.del(key); } catch {}
}

class CascadeService {
    /**
     * Deploy a single cascade link: upload configs to both Portal and Bridge,
     * restart services, and verify tunnel establishment.
     * @param {Object} link - CascadeLink document (populated with portalNode, bridgeNode)
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async deployLink(link) {
        const linkId = link._id;
        logger.info(`[Cascade] Deploying link ${link.name} (${linkId})`);

        await CascadeLink.updateOne({ _id: linkId }, { $set: { status: 'pending', lastError: '' } });

        const portalNode = link.portalNode._id ? link.portalNode : await HyNode.findById(link.portalNode);
        const bridgeNode = link.bridgeNode._id ? link.bridgeNode : await HyNode.findById(link.bridgeNode);

        if (!portalNode || !bridgeNode) {
            const err = 'Portal or Bridge node not found';
            await CascadeLink.updateOne({ _id: linkId }, { $set: { status: 'error', lastError: err } });
            return { success: false, error: err };
        }

        try {
            // Step 1: Update Portal node config (add reverse.portals + bridge-connector inbound)
            await this._deployPortalConfig(portalNode);

            // Step 2: Upload Bridge config via SSH
            await this._deployBridgeConfig(link, bridgeNode, portalNode);

            // Step 3: Open firewall port on Portal for the tunnel
            await this._openFirewallPort(portalNode, link.tunnelPort || 10086);

            // Step 4: Verify tunnel (give Bridge time to connect)
            await new Promise(r => setTimeout(r, 3000));
            const healthy = await this._checkTunnel(portalNode, link.tunnelPort || 10086);

            const newStatus = healthy ? 'online' : 'deployed';
            await CascadeLink.updateOne({ _id: linkId }, {
                $set: {
                    status: newStatus,
                    lastError: '',
                    lastHealthCheck: new Date(),
                },
            });

            await this._updateNodeRoles();
            await this._invalidateTopologyCache();

            logger.info(`[Cascade] Link ${link.name} deployed, status=${newStatus}`);
            return { success: true };
        } catch (error) {
            logger.error(`[Cascade] Deploy failed for ${link.name}: ${error.message}`);
            await CascadeLink.updateOne({ _id: linkId }, {
                $set: { status: 'error', lastError: error.message },
            });
            return { success: false, error: error.message };
        }
    }

    /**
     * Undeploy a cascade link: regenerate Portal config without this link's
     * reverse settings and stop the Bridge Xray service.
     */
    async undeployLink(link) {
        const portalNode = await HyNode.findById(link.portalNode);
        const bridgeNode = await HyNode.findById(link.bridgeNode);

        if (portalNode) {
            try {
                await this._deployPortalConfig(portalNode);
            } catch (err) {
                logger.warn(`[Cascade] Portal redeploy on undeploy: ${err.message}`);
            }
        }

        if (bridgeNode && (bridgeNode.ssh?.password || bridgeNode.ssh?.privateKey)) {
            const ssh = new NodeSSH(bridgeNode);
            try {
                await ssh.connect();
                await ssh.exec('systemctl stop xray-bridge 2>/dev/null; systemctl disable xray-bridge 2>/dev/null');
                logger.info(`[Cascade] Bridge service stopped on ${bridgeNode.name}`);
            } catch (err) {
                logger.warn(`[Cascade] Bridge stop on undeploy: ${err.message}`);
            } finally {
                ssh.disconnect();
            }
        }

        await CascadeLink.updateOne({ _id: link._id }, { $set: { status: 'pending', lastError: '' } });
        await this._updateNodeRoles();
        await this._invalidateTopologyCache();
    }

    /**
     * Redeploy all cascade links associated with a given node.
     * Called when a node's configuration changes.
     */
    async redeployAllLinksForNode(nodeId) {
        const links = await CascadeLink.find({
            $or: [{ portalNode: nodeId }, { bridgeNode: nodeId }],
            active: true,
            status: { $in: ['deployed', 'online', 'offline'] },
        }).populate('portalNode bridgeNode');

        for (const link of links) {
            await this.deployLink(link).catch(err => {
                logger.error(`[Cascade] Redeploy link ${link.name}: ${err.message}`);
            });
        }
    }

    /**
     * Health-check a single cascade link by verifying ESTABLISHED connections
     * on the Portal's tunnel port.
     */
    async healthCheckLink(link) {
        const portalNode = await HyNode.findById(link.portalNode);
        if (!portalNode) return false;

        try {
            const healthy = await this._checkTunnel(portalNode, link.tunnelPort || 10086);
            const prevStatus = link.status;
            const newStatus = healthy ? 'online' : 'offline';

            await CascadeLink.updateOne({ _id: link._id }, {
                $set: {
                    status: newStatus,
                    lastHealthCheck: new Date(),
                    lastError: healthy ? '' : 'No ESTABLISHED tunnel connections',
                },
            });

            if (prevStatus !== newStatus) {
                const event = healthy ? 'cascade.online' : 'cascade.offline';
                webhook.emit(event, { linkId: link._id, name: link.name });
                logger.info(`[Cascade] Link ${link.name}: ${prevStatus} -> ${newStatus}`);
            }

            return healthy;
        } catch (error) {
            await CascadeLink.updateOne({ _id: link._id }, {
                $set: { status: 'error', lastError: error.message, lastHealthCheck: new Date() },
            });
            return false;
        }
    }

    /**
     * Health-check all active, deployed cascade links.
     * Called periodically by cron.
     */
    async healthCheckAll() {
        const links = await CascadeLink.find({
            active: true,
            status: { $in: ['deployed', 'online', 'offline'] },
        });

        if (links.length === 0) return;

        const CONCURRENCY = 5;
        for (let i = 0; i < links.length; i += CONCURRENCY) {
            const batch = links.slice(i, i + CONCURRENCY);
            await Promise.allSettled(batch.map(l => this.healthCheckLink(l)));
        }

        await this._invalidateTopologyCache();
    }

    /**
     * Build the full network topology graph for the visual map.
     * Returns nodes and edges formatted for cytoscape.js consumption.
     * Cached in Redis for performance.
     *
     * @returns {Promise<{nodes: Array, edges: Array}>}
     */
    async getTopology() {
        const cached = await cacheGet(TOPOLOGY_CACHE_KEY);
        if (cached) {
            try { return JSON.parse(cached); } catch (_) {}
        }

        const [allNodes, allLinks] = await Promise.all([
            HyNode.find({ active: true })
                .select('name ip domain flag type status onlineUsers cascadeRole mapPosition country port')
                .lean(),
            CascadeLink.find({ active: true })
                .populate('portalNode', 'name ip')
                .populate('bridgeNode', 'name ip')
                .lean(),
        ]);

        const nodes = allNodes.map(n => ({
            data: {
                id: String(n._id),
                label: n.name,
                ip: n.ip,
                domain: n.domain || '',
                flag: n.flag || '',
                type: n.type,
                status: n.status,
                onlineUsers: n.onlineUsers || 0,
                cascadeRole: n.cascadeRole || 'standalone',
                country: n.country || '',
                port: n.port,
            },
            position: (n.mapPosition?.x != null && n.mapPosition?.y != null)
                ? { x: n.mapPosition.x, y: n.mapPosition.y }
                : undefined,
        }));

        const edges = allLinks.map(l => ({
            data: {
                id: `link-${l._id}`,
                linkId: String(l._id),
                source: String(l.portalNode?._id || l.portalNode),
                target: String(l.bridgeNode?._id || l.bridgeNode),
                label: l.name,
                status: l.status,
                tunnelPort: l.tunnelPort,
                latencyMs: l.latencyMs,
                tunnelProtocol: l.tunnelProtocol,
                tunnelTransport: l.tunnelTransport,
            },
        }));

        const topology = { nodes, edges };
        await cacheSet(TOPOLOGY_CACHE_KEY, JSON.stringify(topology), TOPOLOGY_CACHE_TTL);
        return topology;
    }

    /**
     * Save node positions from the visual map editor.
     * @param {Array<{id: string, x: number, y: number}>} positions
     */
    async savePositions(positions) {
        if (!Array.isArray(positions) || positions.length === 0) return;

        const bulkOps = positions
            .filter(p => p.id && typeof p.x === 'number' && typeof p.y === 'number')
            .map(p => ({
                updateOne: {
                    filter: { _id: p.id },
                    update: { $set: { 'mapPosition.x': p.x, 'mapPosition.y': p.y } },
                },
            }));

        if (bulkOps.length > 0) {
            await HyNode.bulkWrite(bulkOps, { ordered: false });
            await this._invalidateTopologyCache();
        }
    }

    // ==================== INTERNAL HELPERS ====================

    /**
     * Regenerate and upload the Portal node's full Xray config, including
     * all reverse-portal settings from its active cascade links.
     */
    async _deployPortalConfig(portalNode) {
        const syncService = require('./syncService');
        const users = await syncService._getUsersForNode(portalNode);

        const configStr = configGenerator.generateXrayConfig(portalNode, users);
        const config = JSON.parse(configStr);

        const portalLinks = await CascadeLink.find({
            portalNode: portalNode._id,
            active: true,
        });

        const inboundTag = portalNode.xray?.inboundTag || 'vless-in';
        configGenerator.applyReversePortal(config, portalLinks, inboundTag);

        const finalConfig = JSON.stringify(config, null, 2);

        if (portalNode.ssh?.password || portalNode.ssh?.privateKey) {
            const ssh = new NodeSSH(portalNode);
            try {
                await ssh.connect();
                const configPath = portalNode.paths?.config || '/usr/local/etc/xray/config.json';
                await ssh.uploadContent(finalConfig, configPath);
                logger.info(`[Cascade] Portal config uploaded to ${portalNode.name}`);
            } finally {
                ssh.disconnect();
            }
        }

        const hasAgent = !!(portalNode.xray?.agentToken);
        if (hasAgent) {
            try {
                await syncService._agentRequest(portalNode, 'POST', '/restart');
                logger.info(`[Cascade] Portal ${portalNode.name} restarted via agent`);
            } catch (err) {
                logger.warn(`[Cascade] Portal agent restart: ${err.message}`);
                if (portalNode.ssh?.password || portalNode.ssh?.privateKey) {
                    const ssh = new NodeSSH(portalNode);
                    try {
                        await ssh.connect();
                        await ssh.exec('systemctl restart xray');
                    } finally { ssh.disconnect(); }
                }
            }
        } else if (portalNode.ssh?.password || portalNode.ssh?.privateKey) {
            const ssh = new NodeSSH(portalNode);
            try {
                await ssh.connect();
                await ssh.exec('systemctl restart xray');
            } finally { ssh.disconnect(); }
        }
    }

    /**
     * Generate and upload the Bridge config, create systemd service, and start it.
     */
    async _deployBridgeConfig(link, bridgeNode, portalNode) {
        if (!bridgeNode.ssh?.password && !bridgeNode.ssh?.privateKey) {
            throw new Error(`Bridge node ${bridgeNode.name} has no SSH credentials`);
        }

        const bridgeConfig = configGenerator.generateBridgeConfig(link, portalNode);
        const serviceUnit = configGenerator.generateBridgeSystemdService();

        const ssh = new NodeSSH(bridgeNode);
        try {
            await ssh.connect();

            // Ensure Xray is installed
            const xrayCheck = await ssh.exec('command -v xray');
            if (!xrayCheck.stdout || !xrayCheck.stdout.trim()) {
                logger.info(`[Cascade] Installing Xray on bridge ${bridgeNode.name}`);
                await ssh.exec(
                    'curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh -o /tmp/xray-install.sh ' +
                    '&& chmod +x /tmp/xray-install.sh && bash /tmp/xray-install.sh install 2>&1 && rm -f /tmp/xray-install.sh'
                );
            }

            await ssh.exec('mkdir -p /usr/local/etc/xray-bridge');
            await ssh.uploadContent(bridgeConfig, '/usr/local/etc/xray-bridge/config.json');
            await ssh.uploadContent(serviceUnit, '/etc/systemd/system/xray-bridge.service');

            await ssh.exec('systemctl daemon-reload && systemctl enable xray-bridge && systemctl restart xray-bridge');

            // Verify the service started
            const statusResult = await ssh.exec('sleep 1 && systemctl is-active xray-bridge');
            const isActive = (statusResult.stdout || '').trim() === 'active';

            if (!isActive) {
                const logs = await ssh.exec('journalctl -u xray-bridge --no-pager -n 20');
                throw new Error(`Bridge service not active. Logs: ${(logs.stdout || logs.stderr || '').slice(0, 500)}`);
            }

            logger.info(`[Cascade] Bridge config deployed to ${bridgeNode.name}`);
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Open the tunnel port in the firewall on the Portal node.
     */
    async _openFirewallPort(node, port) {
        if (!node.ssh?.password && !node.ssh?.privateKey) return;

        const ssh = new NodeSSH(node);
        try {
            await ssh.connect();
            await ssh.exec(`
                if command -v ufw &>/dev/null; then
                    ufw allow ${port}/tcp 2>/dev/null
                elif command -v firewall-cmd &>/dev/null; then
                    firewall-cmd --permanent --add-port=${port}/tcp 2>/dev/null
                    firewall-cmd --reload 2>/dev/null
                fi
            `);
        } catch (err) {
            logger.warn(`[Cascade] Firewall open port ${port}: ${err.message}`);
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Check if there are ESTABLISHED connections on a given port (tunnel alive).
     */
    async _checkTunnel(node, port) {
        if (!node.ssh?.password && !node.ssh?.privateKey) return false;

        const ssh = new NodeSSH(node);
        try {
            await ssh.connect();
            const result = await ssh.exec(`ss -tn state established '( sport = :${port} )' | grep -c ESTAB || echo 0`);
            const count = parseInt((result.stdout || '0').trim(), 10);
            return count > 0;
        } catch {
            return false;
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Recalculate cascadeRole for all nodes based on their active links.
     */
    async _updateNodeRoles() {
        const links = await CascadeLink.find({ active: true }).lean();

        const portalSet = new Set(links.map(l => String(l.portalNode)));
        const bridgeSet = new Set(links.map(l => String(l.bridgeNode)));

        const allNodes = await HyNode.find({ active: true }).select('_id cascadeRole').lean();

        const bulkOps = [];
        for (const node of allNodes) {
            const id = String(node._id);
            const isPortal = portalSet.has(id);
            const isBridge = bridgeSet.has(id);

            let role = 'standalone';
            if (isPortal && isBridge) role = 'relay';
            else if (isPortal) role = 'entry';
            else if (isBridge) role = 'exit';

            if (node.cascadeRole !== role) {
                bulkOps.push({
                    updateOne: {
                        filter: { _id: node._id },
                        update: { $set: { cascadeRole: role } },
                    },
                });
            }
        }

        if (bulkOps.length > 0) {
            await HyNode.bulkWrite(bulkOps, { ordered: false });
        }
    }

    async _invalidateTopologyCache() {
        await cacheDel(TOPOLOGY_CACHE_KEY);
    }
}

module.exports = new CascadeService();
