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
const { invalidateNodesCache, invalidateUserCache } = require('../utils/helpers');
const logger = require('../utils/logger');
const axios = require('axios');
const https = require('https');
const config = require('../../config');
const webhook = require('./webhookService');
const nodeSetup = require('./nodeSetup');
const { getPanelCertificates, isSameVpsAsPanel } = nodeSetup;

// HTTPS agent that ignores self-signed certs (agent uses self-signed cert by default)
const selfSignedAgent = new https.Agent({ rejectUnauthorized: false });

// Mark node offline after this many consecutive health check failures (1 check/min)
const HEALTH_FAILURE_THRESHOLD = 3;

// Fields whose change requires regenerating the runtime config on the node.
// Anything not listed here (name, groups, flag, rankingCoefficient, ssh.*, ...)
// is treated as cosmetic and does not trigger an auto-push.
// Dotted keys (e.g. "xray.realityPrivateKey") are matched via their root.
const CONFIG_AFFECTING_FIELDS = new Set([
    // Shared
    'domain', 'sni', 'port', 'portRange', 'statsPort', 'statsSecret',
    'useCustomConfig', 'customConfig',
    // Hysteria
    'obfs', 'hopInterval', 'acme', 'masquerade', 'bandwidth',
    'ignoreClientBandwidth', 'speedTest', 'disableUDP', 'udpIdleTimeout',
    'sniff', 'quic', 'resolver', 'acl', 'aclRules', 'outbounds', 'useTlsFiles',
    // Xray (any xray.* sub-path triggers regeneration)
    'xray',
]);

// Minimum elapsed time between two traffic samples for a speed calculation to be
// trusted. Guards against bogus Mbps spikes from clock skew, overlapping manual
// POST /nodes/:id/sync calls, or the very first poll after a node is added
// (prevLastUpdate is null then, so callers skip the calculation entirely).
const MIN_SPEED_INTERVAL_MS = 2000;

/**
 * Average load (Mbit/s) since the previous traffic sample, derived from the same
 * byte counters already fetched during the periodic stats poll — no extra
 * requests to the node. Returns null when the interval is unknown or too short
 * to trust (first poll after restart/add, or overlapping manual syncs).
 */
function computeMbps(txBytes, rxBytes, prevLastUpdate, now) {
    if (!prevLastUpdate) return null;
    const intervalMs = now.getTime() - new Date(prevLastUpdate).getTime();
    if (intervalMs < MIN_SPEED_INTERVAL_MS) return null;

    const intervalSec = intervalMs / 1000;
    return {
        txMbps: Number(((txBytes * 8) / intervalSec / 1e6).toFixed(2)),
        rxMbps: Number(((rxBytes * 8) / intervalSec / 1e6).toFixed(2)),
    };
}

function hasConfigRelevantUpdates(updates) {
    // null/undefined means "unknown" — err on the side of pushing.
    if (!updates) return true;
    const keys = Object.keys(updates);
    if (keys.length === 0) return false;
    return keys.some(k => {
        const root = k.split('.')[0];
        return CONFIG_AFFECTING_FIELDS.has(k) || CONFIG_AFFECTING_FIELDS.has(root);
    });
}

/**
 * The manualKey field is select:false at the schema level. When sync code
 * receives a node loaded by another caller (panel route, scheduled job),
 * the private key is therefore absent. For nodes using tlsSource==='manual'
 * we must lazy-load it before generating config — without it the inlined
 * tlsSettings.certificates[0].key would be empty and Xray would refuse to
 * start with a TLS handshake error.
 *
 * Mutates `node.xray.manualKey` in place when needed; otherwise no-op.
 *
 * @param {Object} node - HyNode document or plain object
 */
async function ensureManualKeyLoaded(node) {
    const xray = node?.xray;
    if (!xray) return;
    if (xray.tlsSource !== 'manual') return;
    if (xray.manualKey && String(xray.manualKey).trim().length > 0) return;
    try {
        const fresh = await HyNode.findById(node._id).select('+xray.manualKey').lean();
        const key = fresh?.xray?.manualKey || '';
        if (key) {
            // node.xray may be a Mongoose subdoc — assign directly.
            xray.manualKey = key;
        }
    } catch (err) {
        logger.warn(`[Sync] Failed to lazy-load manualKey for node ${node.name || node._id}: ${err.message}`);
    }
}

// ─── Panel certificate rotation watcher ──────────────────────────────────────
//
// When Caddy/Greenlock renews the panel's LE certificate the on-disk file
// changes. Xray nodes that masquerade under the panel domain
// (xray.tlsSource === 'panel') need to receive an updated config.json with the
// new inline PEM, otherwise their TLS cert grows stale within ~24h of expiry.
//
// Poll cert mtime on cron; on change, invalidate cache and re-push to all
// panel-source nodes. mtime advances only when every push succeeds; failed
// nodes are retried with exponential backoff (capped) on subsequent ticks.
let _lastPanelCertMtime = null;
const _failedNodeBackoff = new Map(); // nodeId -> { attempts, nextAttemptAt }
const _MAX_RETRY_ATTEMPTS = 6;
const _BACKOFF_BASE_MS = 5 * 60 * 1000;

async function checkPanelCertRotation(syncInstance) {
    const fs = require('fs');
    const path = require('path');
    const domain = (config?.PANEL_DOMAIN || '').trim();
    if (!domain) return;
    const candidates = [
        path.join('/caddy_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory', domain, `${domain}.crt`),
        path.join(__dirname, '../../greenlock.d/live', domain, 'fullchain.pem'),
    ];
    let currentMtime = 0;
    let foundPath = '';
    for (const candidate of candidates) {
        try {
            const stat = fs.statSync(candidate);
            currentMtime = stat.mtimeMs;
            foundPath = candidate;
            break;
        } catch (_) { /* try next */ }
    }
    if (!foundPath) return;

    if (_lastPanelCertMtime === null) {
        _lastPanelCertMtime = currentMtime;
        return;
    }

    // Fresh cert → full sweep; same mtime + pending retries → retry-only sweep.
    const certIsFresh = currentMtime > _lastPanelCertMtime;
    const hasPendingRetries = _failedNodeBackoff.size > 0;
    if (!certIsFresh && !hasPendingRetries) return;

    if (certIsFresh) {
        logger.info(`[CertWatch] Panel certificate mtime changed (${foundPath}), pushing config to panel-source Xray nodes`);
        try {
            const configGen = require('./configGenerator');
            if (typeof configGen.invalidatePanelCertCache === 'function') {
                configGen.invalidatePanelCertCache();
            }
        } catch (_) { /* configGen may not be loaded yet at first invocation */ }
    } else {
        logger.info(`[CertWatch] Retrying ${_failedNodeBackoff.size} previously-failed cert push(es)`);
    }

    let nodes;
    try {
        nodes = await HyNode.find({
            type: 'xray',
            active: true,
            'xray.security': 'tls',
            'xray.tlsSource': 'panel',
        });
    } catch (err) {
        logger.error(`[CertWatch] Failed to list panel-source nodes: ${err.message}`);
        return;
    }
    if (!nodes || nodes.length === 0) {
        logger.info('[CertWatch] No panel-source Xray nodes to update');
        if (certIsFresh) _lastPanelCertMtime = currentMtime;
        _failedNodeBackoff.clear();
        return;
    }

    const now = Date.now();
    let targets;
    if (certIsFresh) {
        _failedNodeBackoff.clear();
        targets = nodes;
    } else {
        targets = nodes.filter(n => {
            const entry = _failedNodeBackoff.get(String(n._id));
            return entry && entry.nextAttemptAt <= now;
        });
        if (targets.length === 0) return;
    }

    const CONCURRENCY = 4;
    let cursor = 0;
    const total = targets.length;
    let failures = 0;
    const stillPending = new Set();
    const worker = async () => {
        while (cursor < total) {
            const idx = cursor++;
            const node = targets[idx];
            const id = String(node._id);
            try {
                await syncInstance.updateXrayNodeConfig(node);
                _failedNodeBackoff.delete(id);
                logger.info(`[CertWatch] Pushed renewed cert to ${node.name} (${node.ip})`);
            } catch (err) {
                failures++;
                const prev = _failedNodeBackoff.get(id) || { attempts: 0, nextAttemptAt: 0 };
                const attempts = prev.attempts + 1;
                const delay = _BACKOFF_BASE_MS * Math.min(16, Math.pow(2, Math.max(0, attempts - 1)));
                _failedNodeBackoff.set(id, { attempts, nextAttemptAt: now + delay });
                stillPending.add(id);
                if (attempts >= _MAX_RETRY_ATTEMPTS) {
                    logger.error(`[CertWatch] Push failed for ${node.name} (${node.ip}) [attempt ${attempts}, giving up until next rotation]: ${err.message}`);
                } else {
                    logger.warn(`[CertWatch] Push failed for ${node.name} (${node.ip}) [attempt ${attempts}, retry in ${Math.round(delay / 1000)}s]: ${err.message}`);
                }
            }
        }
    };
    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
    await Promise.all(workers);

    // Advance mtime only on a fully clean sweep so the next tick re-enters
    // when any node still has pending failures.
    if (failures === 0) {
        _lastPanelCertMtime = currentMtime;
        logger.info(`[CertWatch] Panel cert rotation push completed for ${total} node(s)`);
    } else {
        logger.warn(`[CertWatch] ${failures}/${total} cert push(es) failed; will retry on next tick (mtime kept at ${_lastPanelCertMtime})`);
    }
}

class SyncService {
    constructor() {
        this.isSyncing = false;
        this.lastSyncTime = null;
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

            const prevNode = await HyNode.findOneAndUpdate(
                { _id: node._id },
                {
                    $set: {
                        xrayVersion: data.xray_version || '',
                        agentVersion: data.agent_version || '',
                        agentStatus: 'online',
                        agentLastSeen: new Date(),
                        status: 'online',
                        healthFailures: 0,
                    },
                }
            );

            if (prevNode && prevNode.status !== 'online') {
                await invalidateNodesCache();
            }

            return { online: true, xrayVersion: data.xray_version };
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
                await HyNode.updateOne({ _id: node._id }, { $set: { status: 'offline', onlineUsers: 0 } });
                await invalidateNodesCache();
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
        const noExplicitNodes = {
            $or: [
                { nodes: { $size: 0 } },
                { nodes: { $exists: false } },
            ],
        };
        let byGroups = [];
        if (nodeGroupIds.length > 0) {
            byGroups = await HyUser.find({ groups: { $in: node.groups }, enabled: true, ...noExplicitNodes }).lean();
        } else {
            // Node has no groups — all users without group assignment
            byGroups = await HyUser.find({ enabled: true, groups: { $size: 0 }, ...noExplicitNodes }).lean();
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
     * Resolve the full downstream forward-chain path for an Xray node.
     * Delegates to cascadeService to avoid duplication.
     *
     * @param {string|ObjectId} startNodeId
     * @returns {Promise<Array>}
     */
    async _getForwardChainLinks(startNodeId) {
        const cascadeService = require('./cascadeService');
        return cascadeService._getForwardChainLinks(startNodeId);
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

        // Pull the operator-supplied private key if the node uses manual TLS;
        // it is intentionally hidden from default queries (select:false).
        await ensureManualKeyLoaded(node);

        const users = await this._getUsersForNode(node);

        // Bail out early on cert-availability errors — pushing a broken
        // config would silently crash Xray on the node.
        let configContent;
        try {
            configContent = configGenerator.generateXrayConfig(node, users);
        } catch (genErr) {
            if (genErr.code === 'PANEL_CERT_UNAVAILABLE' || genErr.code === 'MANUAL_CERT_UNAVAILABLE') {
                logger.error(`[Xray Sync] Node ${node.name}: skipping push — ${genErr.message}`);
                await HyNode.updateOne({ _id: node._id }, {
                    $set: {
                        status: 'error',
                        lastSync: new Date(),
                        lastError: genErr.message,
                    },
                });
                await invalidateNodesCache();
                return false;
            }
            throw genErr;
        }

        // Step 1: Upload config.json via SSH (only if SSH is configured)
        if (node.ssh?.password || node.ssh?.privateKey) {
            const ssh = new NodeSSH(node);
            try {
                await ssh.connect();

                // Apply cascade settings (reverse-portal + forward-chain + forward-hop inbounds)
                try {
                    const CascadeLink = require('../models/cascadeLinkModel');
                    const allPortalLinks = await CascadeLink.find({ portalNode: node._id, active: true }).populate('bridgeNode');
                    const forwardHopLinks = await CascadeLink.find({ bridgeNode: node._id, mode: 'forward', active: true });

                    if (allPortalLinks.length > 0 || forwardHopLinks.length > 0) {
                        const configObj = JSON.parse(configContent);
                        // Cascade routing applies to ALL client-facing inbounds
                        // (main + extras), so traffic from any inbound goes
                        // into the cascade.
                        const inboundTags = [
                            node.xray?.inboundTag || 'vless-in',
                            ...(node.xray?.extraInbounds || [])
                                .map(i => i.inboundTag)
                                .filter(Boolean),
                        ];

                        const reverseLinks = allPortalLinks.filter(l => l.mode !== 'forward');
                        const forwardLinks = await this._getForwardChainLinks(node._id);

                        if (reverseLinks.length > 0) {
                            configGenerator.applyReversePortal(configObj, reverseLinks, inboundTags);
                        }
                        if (forwardLinks.length > 0) {
                            configGenerator.applyForwardChain(configObj, forwardLinks, inboundTags);
                        }
                        if (forwardHopLinks.length > 0) {
                            configGenerator.applyForwardHopInbound(configObj, forwardHopLinks);
                        }

                        // geoip:private block must be last, after all cascade rules
                        configGenerator.ensurePrivateIpBlock(configObj);

                        configContent = JSON.stringify(configObj, null, 2);
                        const total = reverseLinks.length + forwardLinks.length + forwardHopLinks.length;
                        logger.info(`[Xray Sync] Node ${node.name}: applied ${total} cascade link(s) (${reverseLinks.length}R/${forwardLinks.length}F/${forwardHopLinks.length}H)`);
                    } else {
                        // No cascade links, still ensure geoip:private is present
                        const configObj = JSON.parse(configContent);
                        configGenerator.ensurePrivateIpBlock(configObj);
                        configContent = JSON.stringify(configObj, null, 2);
                    }
                } catch (cascadeErr) {
                    logger.warn(`[Xray Sync] Node ${node.name}: cascade apply skipped: ${cascadeErr.message}`);
                }

                // When access logging is enabled, the log directory must exist
                // and be writable by the Xray service user (User=nobody in the
                // systemd unit) BEFORE Xray restarts with the new config —
                // otherwise Xray fails to start and the node goes down.
                if (node.xray?.accessLogs?.enabled) {
                    try {
                        await ssh.exec(
                            'mkdir -p /var/log/xray && '
                            + 'chown nobody /var/log/xray 2>/dev/null || chown nobody:nogroup /var/log/xray 2>/dev/null || true; '
                            + 'chmod 755 /var/log/xray; '
                            + 'touch /var/log/xray/access.log && chown nobody /var/log/xray/access.log 2>/dev/null || true'
                        );
                    } catch (dirErr) {
                        logger.warn(`[Xray Sync] Node ${node.name}: access-log dir prep failed: ${dirErr.message}`);
                    }
                }

                // Xray config always goes to /usr/local/etc/xray/config.json
                const xrayConfigPath = '/usr/local/etc/xray/config.json';
                await ssh.uploadContent(configContent, xrayConfigPath);
                logger.info(`[Xray Sync] Node ${node.name}: config uploaded to ${xrayConfigPath}`);

                // Also refresh cc-agent config when extra inbounds may have
                // changed, so the agent picks up new tag→flow mapping. The
                // helper restarts cc-agent via systemctl; safe to call always.
                if (node.xray?.agentToken) {
                    try {
                        await nodeSetup.reloadCcAgent(node, ssh);
                    } catch (reloadErr) {
                        logger.warn(`[Xray Sync] Node ${node.name}: cc-agent reload failed: ${reloadErr.message}`);
                    }
                }
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
                await invalidateNodesCache();
                return false;
            }
        } catch (_) {}

        await HyNode.updateOne({ _id: node._id }, {
            $set: { status: 'online', lastSync: new Date(), lastError: '', healthFailures: 0 },
        });
        await invalidateNodesCache();

        logger.info(`[Xray Sync] Node ${node.name}: sync complete, ${users.length} users`);
        return true;
    }

    /**
     * Collect traffic stats from Xray node via Agent GET /stats.
     * Response shape (agent v1.1.0+):
     *   { users: { <userId>: { tx, rx } }, node: { tx, rx } }
     * Node tx/rx come from Xray outbound stats (real traffic that traversed
     * Xray), not from summing per-user counters.
     */
    async collectXrayTrafficStats(node) {
        if (!(node.xray?.agentToken)) {
            logger.debug(`[Agent Stats] ${node.name}: no agent token, skipping`);
            return;
        }

        try {
            const response = await this._agentRequest(node, 'GET', '/stats');
            const data = response.data || {};
            const users = data.users || {};
            const nodeTraffic = data.node || { tx: 0, rx: 0 };
            const nodeTx = nodeTraffic.tx || 0;
            const nodeRx = nodeTraffic.rx || 0;

            const userEntries = Object.entries(users);
            const bulkOps = [];
            const now = new Date();

            for (const [email, traffic] of userEntries) {
                const tx = traffic.tx || 0;
                const rx = traffic.rx || 0;
                if (tx === 0 && rx === 0) continue;

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
                this.enforceTrafficLimit(userEntries.map(([email]) => email)).catch(() => {});
            }

            // Online = users with non-zero traffic in the last poll interval.
            // Always update (even to 0) so the counter falls back after idle intervals.
            const activeUsers = bulkOps.length;
            const nodeUpdate = { $set: { onlineUsers: activeUsers } };
            if (nodeTx > 0 || nodeRx > 0) {
                nodeUpdate.$inc = { 'traffic.tx': nodeTx, 'traffic.rx': nodeRx };
                nodeUpdate.$set['traffic.lastUpdate'] = now;
            }
            const speed = computeMbps(nodeTx, nodeRx, node.traffic?.lastUpdate, now);
            if (speed) {
                nodeUpdate.$set['traffic.txMbps'] = speed.txMbps;
                nodeUpdate.$set['traffic.rxMbps'] = speed.rxMbps;
                nodeUpdate.$set['traffic.speedUpdatedAt'] = now;
            }
            await HyNode.updateOne({ _id: node._id }, nodeUpdate);

            if (nodeTx > 0 || nodeRx > 0) {
                logger.info(`[Agent Stats] ${node.name}: ${activeUsers} online, node ↑${(nodeTx / 1024 / 1024).toFixed(1)}MB ↓${(nodeRx / 1024 / 1024).toFixed(1)}MB`);
            }
        } catch (error) {
            logger.error(`[Agent Stats] ${node.name} error: ${error.message}`);
        }
    }

    /**
     * Health-check an Xray node via Agent GET /info and refresh metadata
     * (xrayVersion, agentVersion, agentStatus, status). Does NOT touch
     * `onlineUsers` — that counter is owned by collectXrayTrafficStats,
     * which derives it from per-user traffic deltas over the poll interval.
     */
    async getXrayOnlineUsers(node) {
        if (!(node.xray?.agentToken)) {
            logger.debug(`[Agent] ${node.name}: no agent token, skipping health check`);
            return 0;
        }

        try {
            const response = await this._agentRequest(node, 'GET', '/info');
            const data = response.data || {};

            const prevNode = await HyNode.findOneAndUpdate(
                { _id: node._id },
                {
                    $set: {
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
                await invalidateNodesCache();
                webhook.emit(webhook.EVENTS.NODE_ONLINE, { nodeId: node._id, name: node.name });
            }

            return 0;
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
                await HyNode.updateOne({ _id: node._id }, { $set: { status: 'offline', onlineUsers: 0 } });
                await invalidateNodesCache();
                webhook.emit(webhook.EVENTS.NODE_OFFLINE, { nodeId: node._id, name: node.name, lastError: error.message });
                logger.warn(`[Agent] ${node.name}: marked offline after ${failures} consecutive failures`);
            }
            return 0;
        }
    }

    // ==================== HYSTERIA / COMMON METHODS ====================

    /**
     * Update config on a specific node (dispatches by type).
     * Virtual nodes have no remote server — sync is a no-op.
     */
    async updateNodeConfig(node) {
        if (node.type === 'virtual') return;
        if (node.type === 'xray') {
            return this.updateXrayNodeConfig(node);
        }
        return this._updateHysteriaNodeConfig(node);
    }

    /**
     * Fire-and-forget config push after a settings save.
     *
     * Non-blocking: defers to the next tick via setImmediate so the HTTP
     * response is flushed before any SSH/Agent round-trip starts.
     *
     * Silently skipped when:
     *  - `updates` contains only cosmetic fields (see CONFIG_AFFECTING_FIELDS);
     *  - node is inactive or acts as a cascade bridge (cascade deploy owns those);
     *  - node has neither SSH credentials nor an agent token (never set up yet).
     *
     * @param {string} nodeId  - Node _id
     * @param {Object} [updates] - $set payload applied to the node. When omitted,
     *                             the push is assumed relevant and runs unconditionally.
     */
    schedulePush(nodeId, updates = null) {
        if (!hasConfigRelevantUpdates(updates)) return;
        setImmediate(async () => {
            try {
                const node = await HyNode.findById(nodeId);
                if (!node || !node.active) return;
                if (node.cascadeRole === 'bridge') return;

                const hasSsh = !!(node.ssh?.password || node.ssh?.privateKey);
                const hasAgent = !!(node.xray && node.xray.agentToken);
                if (!hasSsh && !hasAgent) return;

                await this.updateNodeConfig(node);
            } catch (error) {
                logger.warn(`[AutoPush] node ${nodeId}: ${error.message}`);
            }
        });
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
                await invalidateNodesCache();
                
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
            await invalidateNodesCache();
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
     * Collect traffic stats from node and update users (dispatches by type).
     * Virtual nodes never carry traffic of their own.
     */
    async collectTrafficStats(node) {
        if (node.type === 'virtual') return;
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

                // Enforce traffic limits on users whose counters just moved (fire-and-forget).
                this.enforceTrafficLimit(Object.keys(stats)).catch(() => {});
            }
            
            // Update node traffic
            const nodeSet = { 'traffic.lastUpdate': now };
            const speed = computeMbps(nodeTx, nodeRx, node.traffic?.lastUpdate, now);
            if (speed) {
                nodeSet['traffic.txMbps'] = speed.txMbps;
                nodeSet['traffic.rxMbps'] = speed.rxMbps;
                nodeSet['traffic.speedUpdatedAt'] = now;
            }
            await HyNode.updateOne(
                { _id: node._id },
                {
                    $inc: {
                        'traffic.tx': nodeTx,
                        'traffic.rx': nodeRx,
                    },
                    $set: nodeSet,
                }
            );
            
            logger.info(`[Stats] ${node.name}: ${Object.keys(stats).length} users, traffic: ↑${(nodeTx / 1024 / 1024).toFixed(1)}MB ↓${(nodeRx / 1024 / 1024).toFixed(1)}MB`);
        } catch (error) {
            logger.error(`[Stats] ${node.name} error: ${error.message}`);
        }
    }

    /**
     * Get online users from node (dispatches by type).
     * Virtual nodes are aggregators with no online state of their own.
     */
    async getOnlineUsers(node) {
        if (node.type === 'virtual') return 0;
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
                await invalidateNodesCache();
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
                await HyNode.updateOne({ _id: node._id }, { $set: { status: 'offline', onlineUsers: 0 } });
                await invalidateNodesCache();
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
        const user = await HyUser.findOne({ userId }).populate('nodes', 'name type ip statsPort statsSecret');
        
        if (!user) {
            return;
        }
        
        for (const node of user.nodes) {
            try {
                // Virtual nodes have no remote service to kick from.
                if (node.type === 'virtual') continue;
                if (!node.statsPort || !node.statsSecret || !node.ip) continue;

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
     * Atomically flip an enabled user to disabled, tear down their runtime
     * presence (Xray clients, Hysteria sessions), invalidate caches and emit
     * the appropriate webhook.
     *
     * Compare-and-set on { enabled: true } makes this idempotent: concurrent
     * scheduler/catchup/stats callers race only on the DB write — the loser
     * exits early and no side-effect is duplicated.
     *
     * @param {object} user   plain user object; must have userId
     * @param {string} reason 'expired' | 'traffic'
     * @returns {Promise<boolean>} true if this call actually disabled the user
     */
    async disableUser(user, reason) {
        if (!user || !user.userId) return false;

        const result = await HyUser.updateOne(
            { userId: user.userId, enabled: true },
            { $set: { enabled: false } }
        );
        if (result.modifiedCount === 0) return false;

        // subscriptionToken is needed to invalidate the subscription cache.
        // Most callers already pass it; fall back to a tiny lookup if missing.
        let token = user.subscriptionToken;
        if (!token) {
            const fresh = await HyUser.findOne(
                { userId: user.userId },
                { subscriptionToken: 1 }
            ).lean();
            token = fresh?.subscriptionToken;
        }

        await Promise.allSettled([
            this.removeUserFromAllXrayNodes(user),
            this.kickUser(user.userId),
            require('./wgEasyService').setUserEnabled(user.userId, false),
            invalidateUserCache(user.userId, token),
        ]);

        const event = reason === 'traffic'
            ? webhook.EVENTS.USER_TRAFFIC_EXCEEDED
            : webhook.EVENTS.USER_EXPIRED;
        webhook.emit(event, { userId: user.userId, reason });

        logger.info(`[Disable] ${user.userId} (${reason})`);
        return true;
    }

    /**
     * Fast-path traffic enforcement triggered right after stats bulkWrite.
     * Looks only at users whose counters just moved; disables any that
     * crossed their limit. Full sweep on boot lives in expireScheduler.init.
     */
    async enforceTrafficLimit(userIds) {
        if (!userIds || userIds.length === 0) return;

        const users = await HyUser.find(
            { userId: { $in: userIds }, enabled: true, trafficLimit: { $gt: 0 } },
            { userId: 1, subscriptionToken: 1, trafficLimit: 1, 'traffic.tx': 1, 'traffic.rx': 1, xrayUuid: 1 }
        ).lean();

        const overLimit = users.filter(u =>
            (u.traffic?.tx || 0) + (u.traffic?.rx || 0) >= u.trafficLimit
        );
        if (overLimit.length === 0) return;

        await Promise.allSettled(overLimit.map(u => this.disableUser(u, 'traffic')));
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

const _service = new SyncService();
_service.ensureManualKeyLoaded = ensureManualKeyLoaded;
_service.checkPanelCertRotation = function() {
    return checkPanelCertRotation(_service);
};
module.exports = _service;
