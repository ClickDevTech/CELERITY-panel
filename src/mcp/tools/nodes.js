/**
 * MCP Tools — Node management, SSH execution, SSH sessions
 * Tools: query (nodes), manage_node, execute_ssh, ssh_session
 */

const { z } = require('zod');
const { Client } = require('ssh2');
const HyNode = require('../../models/hyNodeModel');
const HyUser = require('../../models/hyUserModel');
const cache = require('../../services/cacheService');
const cryptoService = require('../../services/cryptoService');
const logger = require('../../utils/logger');

async function invalidateNodesCache() {
    await cache.invalidateNodes();
    await cache.invalidateAllSubscriptions();
    await cache.invalidateDashboardCounts();
}

function getSyncService() {
    return require('../../services/syncService');
}

// Active SSH sessions managed by ssh_session tool (sessionId -> {conn, buffer})
const sshSessions = new Map();

// Fields excluded from all node queries returned to MCP clients
const NODE_SAFE_SELECT = '-ssh.password -ssh.privateKey -xray.realityPrivateKey -statsSecret';

// ─── Schemas ────────────────────────────────────────────────────────────────

const queryNodesSchema = z.object({
    id: z.string().optional().describe('Node MongoDB _id to fetch'),
    filter: z.object({
        active: z.boolean().optional(),
        group: z.string().optional(),
        status: z.enum(['online', 'offline', 'error', 'syncing']).optional(),
    }).optional(),
    includeUsers: z.boolean().default(false).describe('Include users list for a single node'),
    includeConfig: z.boolean().default(false).describe('Include generated config for a single node'),
});

// Xray stream/security fields shared by the main inbound and extras. Enums
// mirror xrayConfigSchema/xrayExtraInboundSchema in hyNodeModel.js.
const xrayInboundCommonZ = {
    transport: z.enum(['tcp', 'ws', 'grpc', 'xhttp']).optional(),
    security: z.enum(['reality', 'tls', 'none']).optional(),
    flow: z.string().optional(),
    fingerprint: z.string().optional().describe('uTLS fingerprint: chrome, firefox, safari, ios, android, edge, 360, qq, random, randomized'),
    fingerprintPool: z.array(z.string()).optional().describe('Set of fingerprints; when non-empty one is picked at random per subscription-cache rebuild (overrides fingerprint)'),
    alpn: z.array(z.string()).optional().describe('e.g. ["h3","h2","http/1.1"]'),
    realityDest: z.string().optional(),
    realitySni: z.array(z.string()).optional(),
    realityPrivateKey: z.string().optional(),
    realityPublicKey: z.string().optional(),
    realityShortIds: z.array(z.string()).optional(),
    realitySpiderX: z.string().optional(),
    wsPath: z.string().optional(),
    wsHost: z.string().optional(),
    grpcServiceName: z.string().optional(),
    xhttpPath: z.string().optional(),
    xhttpHost: z.string().optional(),
    xhttpMode: z.enum(['auto', 'packet-up', 'stream-up', 'stream-one']).optional(),
    // Ranges use the Xray "min-max" string form (a bare number means min==max);
    // empty keeps the core default. Values failing that shape are stored empty.
    xhttpXPaddingBytes: z.string().optional().describe('XHTTP padding length range, e.g. "100-1000". Default 100-1000'),
    xhttpScMaxEachPostBytes: z.string().optional().describe('packet-up upload split threshold in bytes, e.g. "1000000"'),
    xhttpNoGrpcHeader: z.boolean().optional().describe('Omit the gRPC content-type on stream-up/stream-one requests (client-side only)'),
    xhttpXmuxMaxConcurrency: z.string().optional().describe('XMUX streams per connection, e.g. "16-32" (client-side only)'),
    xhttpXmuxHMaxRequestTimes: z.string().optional().describe('XMUX requests per connection, e.g. "600-900" (client-side only)'),
    xhttpXmuxHMaxReusableSecs: z.string().optional().describe('XMUX connection lifetime in seconds, e.g. "1800-3000" (client-side only)'),
    fallbackDest: z.string().optional().describe('VLESS fallbacks[].dest — emitted only on tcp+tls'),
};

const xrayExtraInboundZ = z.object({
    ...xrayInboundCommonZ,
    id: z.string().describe('Stable client-generated uuid tracking the inbound across edits'),
    label: z.string().optional(),
    uniqueName: z.boolean().optional(),
    port: z.number(),
    inboundTag: z.string(),
});

const xrayConfigZ = z.object({
    ...xrayInboundCommonZ,
    tlsSource: z.enum(['panel', 'acme', 'manual', 'self-signed']).optional(),
    acmeEmail: z.string().optional(),
    manualCert: z.string().optional(),
    manualKey: z.string().optional(),
    apiPort: z.number().optional(),
    inboundTag: z.string().optional(),
    agentPort: z.number().optional(),
    agentToken: z.string().optional(),
    agentTls: z.boolean().optional(),
    extraInbounds: z.array(xrayExtraInboundZ).optional(),
});

const manageNodeSchema = z.object({
    action: z.enum(['create', 'update', 'delete', 'sync', 'setup', 'reset_status', 'update_config', 'setup_port_hopping', 'generate_xray_keys']),
    id: z.string().optional().describe('Node MongoDB _id (required for all except create)'),
    data: z.object({
        name: z.string().optional(),
        ip: z.string().optional().describe('IPv4/IPv6 of the host (required for hysteria/xray; ignored for virtual)'),
        domain: z.string().optional(),
        sni: z.string().optional(),
        port: z.number().optional(),
        portRange: z.string().optional(),
        type: z.enum(['hysteria', 'xray', 'virtual']).optional().describe('Node type. "virtual" is a load-balancer entry (HAPP/Xray-core balancer + Singbox/Clash url-test/load-balance group) without its own remote server'),
        groups: z.array(z.string()).optional(),
        active: z.boolean().optional(),
        country: z.string().optional(),
        cascadeRole: z.enum(['standalone', 'portal', 'bridge', 'relay']).optional(),
        // Virtual-node specific (load balancer over real sibling nodes).
        // Only consumed when type==='virtual'. Mirrors hyNodeModel.virtualConfigSchema.
        virtual: z.object({
            selectMode: z.enum(['manual', 'group']).optional().describe('"manual": pick from `sources`. "group": dynamically include every active node in `sourceGroup`'),
            sources: z.array(z.string()).optional().describe('HyNode _ids — required when selectMode==="manual"'),
            sourceGroup: z.string().optional().describe('ServerGroup _id — required when selectMode==="group"'),
            strategy: z.enum(['random', 'roundRobin', 'leastPing', 'leastLoad']).optional().describe('Xray balancer strategy. leastPing/leastLoad require observatory'),
            fallbackToFirst: z.boolean().optional().describe('Use the first source as fallback when all observed peers are down (Xray fallbackTag)'),
            tolerance: z.number().int().min(0).max(5000).optional().describe('Latency-test clients (sing-box urltest, Mihomo url-test): ms another source must beat the current pick by before switching. Ignored by Xray'),
            idleTimeout: z.string().optional().describe('sing-box urltest only: stop probing after this long without traffic, e.g. "30m". Empty keeps the core default'),
            interruptExistConnections: z.boolean().optional().describe('sing-box urltest only: drop open connections when the pick changes'),
            observatory: z.object({
                destination: z.string().optional().describe('Probe URL returning HTTP 204 (default http://www.gstatic.com/generate_204)'),
                connectivity: z.string().optional().describe('Local connectivity check URL — only probed when destination fails'),
                interval: z.string().optional().describe('Probe interval, e.g. "1m", "30s" (min "10s")'),
                timeout: z.string().optional().describe('Probe timeout, e.g. "5s"'),
                sampling: z.number().int().min(1).max(50).optional().describe('Burst Observatory sample window — recent probe results to keep'),
            }).optional(),
        }).optional(),
        ssh: z.object({
            host: z.string().optional(),
            port: z.number().optional(),
            username: z.string().optional(),
            password: z.string().optional(),
            privateKey: z.string().optional(),
        }).optional(),
        statsPort: z.number().optional(),
        paths: z.object({
            config: z.string().optional(),
            cert: z.string().optional(),
            key: z.string().optional(),
        }).optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
        rankingCoefficient: z.number().optional(),
        comment: z.string().optional().describe('Free-form operator note (trimmed, max 500 chars)'),
        // Xray inbound config (only for type="xray"). On update only the provided
        // keys are changed; omit reality keys / manualKey to keep generated values.
        xray: xrayConfigZ.optional().describe('Xray inbound config (only for type="xray"). On update only provided keys change; omit realityPrivateKey/realityPublicKey/manualKey to preserve generated values'),
        // Hysteria 2 advanced configuration
        hopInterval: z.string().optional().describe('Port-hopping interval, e.g. "30s"'),
        acme: z.object({
            email: z.string().optional(),
            ca: z.string().optional(),
            listenHost: z.string().optional(),
            type: z.enum(['', 'http', 'tls', 'dns']).optional(),
            httpAltPort: z.number().optional(),
            tlsAltPort: z.number().optional(),
            dnsName: z.string().optional(),
            dnsConfig: z.record(z.string(), z.unknown()).optional(),
        }).optional(),
        masquerade: z.object({
            type: z.enum(['proxy', 'string']).optional(),
            proxy: z.object({
                url: z.string().optional(),
                rewriteHost: z.boolean().optional(),
                insecure: z.boolean().optional(),
            }).optional(),
            string: z.object({
                content: z.string().optional(),
                headers: z.record(z.string(), z.string()).optional(),
                statusCode: z.number().optional(),
            }).optional(),
            listenHTTP: z.string().optional(),
            listenHTTPS: z.string().optional(),
            forceHTTPS: z.boolean().optional(),
        }).optional(),
        bandwidth: z.object({
            up: z.string().optional(),
            down: z.string().optional(),
        }).optional(),
        ignoreClientBandwidth: z.boolean().optional(),
        speedTest: z.boolean().optional(),
        disableUDP: z.boolean().optional(),
        udpIdleTimeout: z.string().optional().describe('UDP idle timeout, e.g. "60s"'),
        sniff: z.object({
            enabled: z.boolean().optional(),
            enable: z.boolean().optional().describe('Enable sniffing within the protocol'),
            timeout: z.string().optional().describe('Sniff timeout, e.g. "2s"'),
            rewriteDomain: z.boolean().optional(),
            tcpPorts: z.string().optional().describe('TCP ports to sniff, e.g. "80,443,8000-9000"'),
            udpPorts: z.string().optional().describe('UDP ports to sniff, e.g. "443,80,53"'),
        }).optional(),
        quic: z.object({
            enabled: z.boolean().optional(),
            initStreamReceiveWindow: z.number().optional(),
            maxStreamReceiveWindow: z.number().optional(),
            initConnReceiveWindow: z.number().optional(),
            maxConnReceiveWindow: z.number().optional(),
            maxIdleTimeout: z.string().optional(),
            maxIncomingStreams: z.number().optional(),
            disablePathMTUDiscovery: z.boolean().optional(),
        }).optional(),
        resolver: z.object({
            enabled: z.boolean().optional(),
            type: z.enum(['udp', 'tcp', 'tls', 'https']).optional(),
            udpAddr: z.string().optional(),
            udpTimeout: z.string().optional(),
            tcpAddr: z.string().optional(),
            tcpTimeout: z.string().optional(),
            tlsAddr: z.string().optional(),
            tlsTimeout: z.string().optional(),
            tlsSni: z.string().optional(),
            tlsInsecure: z.boolean().optional(),
            httpsAddr: z.string().optional(),
            httpsTimeout: z.string().optional(),
            httpsSni: z.string().optional(),
            httpsInsecure: z.boolean().optional(),
        }).optional(),
        acl: z.object({
            enabled: z.boolean().optional(),
            type: z.enum(['inline', 'file']).optional(),
            file: z.string().optional(),
            geoip: z.string().optional(),
            geosite: z.string().optional(),
            geoUpdateInterval: z.string().optional(),
        }).optional(),
        aclRules: z.array(z.string()).optional().describe('Inline ACL rules (stored on node root, not inside acl)'),
        useTlsFiles: z.boolean().optional().describe('Whether to use TLS cert/key files instead of ACME'),
        initScript: z.string().optional().describe('Bash script executed before auto-setup via SSH'),
    }).optional(),
    setupOptions: z.object({
        installHysteria: z.boolean().default(true),
        setupPortHopping: z.boolean().default(true),
        restartService: z.boolean().default(true),
    }).optional(),
});

const scanSniSchema = z.object({
    ip: z.string().describe('Target IPv4 address. The whole /24 around it is scanned'),
    port: z.number().int().min(1).max(65535).default(443).describe('TLS port to probe'),
    threads: z.number().int().min(1).max(200).default(50).describe('Concurrent probes'),
    timeout: z.number().int().min(2).max(30).default(5).describe('Per-host timeout in seconds'),
});

const executeSshSchema = z.object({
    nodeId: z.string().describe('Node MongoDB _id'),
    command: z.string().min(1).describe('Shell command to execute'),
    timeout: z.number().int().min(1000).max(120000).default(30000).describe('Timeout in ms'),
});

const sshSessionSchema = z.object({
    action: z.enum(['start', 'input', 'close']).describe('Session action'),
    nodeId: z.string().optional().describe('Required for start'),
    sessionId: z.string().optional().describe('Required for input/close'),
    data: z.string().optional().describe('Input data for action=input'),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildSshConfig(node) {
    const cfg = {
        host: node.ip,
        port: node.ssh?.port || 22,
        username: node.ssh?.username || 'root',
        readyTimeout: 30000,
    };
    if (node.ssh?.privateKey) {
        cfg.privateKey = cryptoService.decryptPrivateKey(node.ssh.privateKey);
    } else if (node.ssh?.password) {
        cfg.password = cryptoService.decryptSafe(node.ssh.password);
    } else {
        throw new Error('SSH credentials not configured for this node');
    }
    return cfg;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function queryNodes(args) {
    const parsed = queryNodesSchema.parse(args);

    if (parsed.id) {
        const node = await HyNode.findById(parsed.id).select(NODE_SAFE_SELECT).populate('groups', 'name color');
        if (!node) return { error: `Node '${parsed.id}' not found`, code: 404 };

        const result = { ...node.toObject() };

        if (parsed.includeUsers) {
            result.users = await HyUser.find({ nodes: node._id, enabled: true, isProbe: { $ne: true } })
                .select('userId username traffic');
        }

        if (parsed.includeConfig) {
            const configGenerator = require('../../services/configGenerator');
            const config = require('../../../config');
            const baseUrl = process.env.BASE_URL || `http://localhost:${config.PORT}`;
            result.config = configGenerator.generateNodeConfig(node, `${baseUrl}/api/auth`);
        }

        result.userCount = await HyUser.countDocuments({ nodes: node._id, enabled: true, isProbe: { $ne: true } });
        return { node: result };
    }

    const filter = {};
    if (parsed.filter?.active !== undefined) filter.active = parsed.filter.active;
    if (parsed.filter?.group) filter.groups = parsed.filter.group;
    if (parsed.filter?.status) filter.status = parsed.filter.status;

    const nodes = await HyNode.find(filter).select(NODE_SAFE_SELECT).populate('groups', 'name color').sort({ name: 1 });
    return { nodes };
}

async function manageNode(args, emit) {
    const parsed = manageNodeSchema.parse(args);
    const { action, id, data = {}, setupOptions } = parsed;

    switch (action) {
        case 'create': {
            if (!data.name) throw new Error('name is required for create');
            const nodeType = data.type || 'hysteria';

            if (nodeType !== 'virtual' && !data.ip) {
                throw new Error('ip is required for hysteria and xray nodes');
            }

            // Validate virtual-specific fields up-front so the caller gets a
            // clear 400 instead of a generic ValidationError 500 from save().
            if (nodeType === 'virtual') {
                const v = data.virtual || {};
                const selectMode = v.selectMode === 'group' ? 'group' : 'manual';
                if (selectMode === 'group' && !v.sourceGroup) {
                    return { error: 'Virtual node (group): sourceGroup required', code: 400 };
                }
                if (selectMode === 'manual' && (!Array.isArray(v.sources) || v.sources.length === 0)) {
                    return { error: 'Virtual node (manual): at least one source required', code: 400 };
                }
            } else {
                const existing = await HyNode.findOne({ ip: data.ip, type: nodeType });
                if (existing) return { error: `A ${nodeType} node with this IP already exists`, code: 409 };
            }

            const labelConflict = await HyNode.findLabelConflict(data.name, data.flag);
            if (labelConflict) {
                return { error: 'A node with this name and flag already exists — subscription tags must be unique', code: 409 };
            }

            const statsSecret = cryptoService.generateNodeSecret();

            // Resolve SSH: virtual has no remote host; for hysteria/xray either use
            // caller-provided credentials or inherit from a sibling on the same IP.
            const rawSsh = data.ssh || {};
            let resolvedSsh;
            if (nodeType === 'virtual') {
                resolvedSsh = cryptoService.encryptSshCredentials({});
            } else if (rawSsh.password || rawSsh.privateKey) {
                resolvedSsh = cryptoService.encryptSshCredentials(rawSsh);
            } else {
                const sibling = await HyNode.findOne({ ip: data.ip, type: { $ne: nodeType } }).select('ssh').lean();
                resolvedSsh = sibling?.ssh || cryptoService.encryptSshCredentials({});
            }

            const nodeData = {
                name: data.name,
                ip: nodeType === 'virtual' ? null : data.ip,
                type: nodeType,
                domain: data.domain || '',
                sni: data.sni || '',
                port: data.port || 443,
                portRange: data.portRange || '20000-50000',
                statsPort: 9999,
                statsSecret,
                groups: data.groups || [],
                ssh: resolvedSsh,
                active: true,
                status: 'offline',
                cascadeRole: nodeType === 'virtual' ? 'standalone' : (data.cascadeRole || 'standalone'),
                country: data.country || '',
            };
            if (data.initScript !== undefined) nodeData.initScript = data.initScript;

            if (nodeType === 'virtual') {
                const v = data.virtual || {};
                nodeData.virtual = {
                    selectMode: v.selectMode === 'group' ? 'group' : 'manual',
                    sources: Array.isArray(v.sources) ? v.sources : [],
                    sourceGroup: v.sourceGroup || null,
                    strategy: v.strategy || 'leastLoad',
                    fallbackToFirst: v.fallbackToFirst !== false,
                    tolerance: Number.isFinite(v.tolerance)
                        ? Math.min(Math.max(v.tolerance, 0), 5000)
                        : 50,
                    idleTimeout: (v.idleTimeout || '').trim(),
                    interruptExistConnections: v.interruptExistConnections !== false,
                    observatory: {
                        destination: (v.observatory?.destination || '').trim() || 'http://www.gstatic.com/generate_204',
                        connectivity: (v.observatory?.connectivity || '').trim(),
                        interval: (v.observatory?.interval || '').trim() || '1m',
                        timeout: (v.observatory?.timeout || '').trim() || '5s',
                        sampling: parseInt(v.observatory?.sampling, 10) || 3,
                    },
                };
            }

            const hy2Keys = [
                'hopInterval', 'acme', 'masquerade', 'bandwidth',
                'ignoreClientBandwidth', 'speedTest', 'disableUDP',
                'udpIdleTimeout', 'sniff', 'quic', 'resolver', 'acl', 'aclRules', 'useTlsFiles',
            ];
            for (const k of hy2Keys) {
                if (data[k] !== undefined) nodeData[k] = data[k];
            }

            // Xray + remaining common fields, mirroring routes/nodes.js POST.
            if (nodeType === 'xray' && data.xray) nodeData.xray = data.xray;
            if (data.statsPort !== undefined) nodeData.statsPort = data.statsPort;
            if (data.paths !== undefined) nodeData.paths = data.paths;
            if (data.settings !== undefined) nodeData.settings = data.settings;
            if (data.rankingCoefficient !== undefined) nodeData.rankingCoefficient = data.rankingCoefficient;
            if (typeof data.comment === 'string') nodeData.comment = data.comment.trim().slice(0, 500);

            const node = new HyNode(nodeData);
            await node.save();
            await invalidateNodesCache();
            logger.info(`[MCP] Created ${nodeType} node ${data.name} (${nodeType === 'virtual' ? 'virtual' : data.ip})`);
            return { success: true, node };
        }

        case 'update': {
            if (!id) throw new Error('id is required for update');
            const allowed = [
                'name', 'domain', 'sni', 'port', 'portRange', 'statsPort', 'groups', 'ssh', 'paths',
                'settings', 'active', 'rankingCoefficient', 'country', 'comment', 'cascadeRole', 'type',
                'virtual',
                'hopInterval', 'acme', 'masquerade', 'bandwidth',
                'ignoreClientBandwidth', 'speedTest', 'disableUDP',
                'udpIdleTimeout', 'sniff', 'quic', 'resolver', 'acl', 'aclRules', 'useTlsFiles',
                'initScript',
            ];
            const updates = {};
            for (const k of allowed) {
                if (data[k] === undefined) continue;
                if (k === 'ssh') {
                    updates[k] = cryptoService.encryptSshCredentials(data[k]);
                } else if (k === 'comment') {
                    updates[k] = typeof data[k] === 'string' ? data[k].trim().slice(0, 500) : '';
                } else {
                    updates[k] = data[k];
                }
            }

            // Xray: partial update via dot-paths so unsent secrets (realityPrivateKey,
            // realityPublicKey, manualKey) are preserved instead of wiped by a full $set.
            if (data.xray && typeof data.xray === 'object') {
                for (const [k, v] of Object.entries(data.xray)) {
                    updates[`xray.${k}`] = v;
                }
            }

            // findByIdAndUpdate skips pre('validate') hooks, so re-implement
            // type-aware invariants here. Mirror the behaviour of routes/nodes.js PUT.
            const existing = await HyNode.findById(id).select('type ip virtual name flag').lean();
            if (!existing) return { error: `Node '${id}' not found`, code: 404 };

            // Renames only — pre-existing duplicates stay editable (see panel route).
            if (updates.name !== undefined
                && String(updates.name).trim() !== String(existing.name || '').trim()) {
                const labelConflict = await HyNode.findLabelConflict(updates.name, existing.flag, id);
                if (labelConflict) {
                    return { error: 'A node with this name and flag already exists — subscription tags must be unique', code: 409 };
                }
            }

            const nextType = updates.type || existing.type;
            const nextVirtual = updates.virtual !== undefined ? updates.virtual : existing.virtual;
            const nextIp = existing.ip;

            if (nextType === 'virtual') {
                const v = nextVirtual || {};
                if (v.selectMode === 'group' && !v.sourceGroup) {
                    return { error: 'Virtual node (group): sourceGroup required', code: 400 };
                }
                if (v.selectMode !== 'group' && (!Array.isArray(v.sources) || v.sources.length === 0)) {
                    return { error: 'Virtual node (manual): at least one source required', code: 400 };
                }
                updates.ip = null;
            } else if (!nextIp) {
                return { error: `Node type ${nextType} requires ip`, code: 400 };
            }

            const node = await HyNode.findByIdAndUpdate(id, { $set: updates }, { new: true })
                .populate('groups', 'name color');
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            await invalidateNodesCache();

            // Auto-push config to the node if any config-affecting field changed.
            // Virtual nodes have no remote service to push to — schedulePush will
            // simply emit a no-op via the existing type guards in syncService.
            getSyncService().schedulePush(node._id, updates);

            logger.info(`[MCP] Updated node ${node.name}`);
            return { success: true, node };
        }

        case 'delete': {
            if (!id) throw new Error('id is required for delete');
            const node = await HyNode.findByIdAndDelete(id);
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            await HyUser.updateMany({ nodes: node._id }, { $pull: { nodes: node._id } });
            await invalidateNodesCache();
            logger.info(`[MCP] Deleted node ${node.name}`);
            return { success: true, message: `Node '${node.name}' deleted` };
        }

        case 'sync': {
            if (!id) throw new Error('id is required for sync');
            const probe = await HyNode.findById(id).select('type').lean();
            if (!probe) return { error: `Node '${id}' not found`, code: 404 };
            if (probe.type === 'virtual') {
                return { error: 'Virtual nodes have no remote service to sync', code: 400 };
            }
            const node = await HyNode.findByIdAndUpdate(id, { $set: { status: 'syncing' } }, { new: true });
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            getSyncService().updateNodeConfig(node).catch(err => {
                logger.error(`[MCP] Sync error for ${node.name}: ${err.message}`);
            });
            emit('progress', { message: `Sync started for node '${node.name}'` });
            logger.info(`[MCP] Started sync for node ${node.name}`);
            return { success: true, message: `Sync started for '${node.name}'` };
        }

        case 'setup': {
            if (!id) throw new Error('id is required for setup');
            const node = await HyNode.findById(id);
            if (!node) return { error: `Node '${id}' not found`, code: 404 };

            if (node.type === 'virtual') {
                return { error: 'Virtual nodes have no remote server to set up', code: 400 };
            }

            if (!node.ssh?.password && !node.ssh?.privateKey) {
                return { error: 'SSH credentials not configured', code: 400 };
            }

            const opts = setupOptions || { installHysteria: true, setupPortHopping: true, restartService: true };
            const nodeSetup = require('../../services/nodeSetup');

            emit('progress', { step: 1, total: 3, message: `Connecting to ${node.name} via SSH...` });

            let result;
            if (node.type === 'xray') {
                result = await nodeSetup.setupXrayNode(node, { restartService: opts.restartService });
            } else {
                result = await nodeSetup.setupNode(node, opts);
            }

            if (result.success) {
                const updateFields = { status: 'online', lastSync: new Date(), lastError: '', healthFailures: 0 };
                if (node.type !== 'xray') updateFields.useTlsFiles = result.useTlsFiles;
                await HyNode.findByIdAndUpdate(id, { $set: updateFields });
                await invalidateNodesCache();
                logger.info(`[MCP] Setup completed for ${node.name}`);
                return { success: true, logs: result.logs };
            } else {
                await HyNode.findByIdAndUpdate(id, { $set: { status: 'error', lastError: result.error } });
                return { success: false, error: result.error, logs: result.logs };
            }
        }

        case 'reset_status': {
            if (!id) throw new Error('id is required for reset_status');
            const node = await HyNode.findByIdAndUpdate(
                id,
                { $set: { status: 'online', lastError: '', healthFailures: 0 } },
                { new: true }
            );
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            logger.info(`[MCP] Status reset for node ${node.name}`);
            return { success: true, message: `Status reset for '${node.name}'` };
        }

        case 'update_config': {
            if (!id) throw new Error('id is required for update_config');
            const node = await HyNode.findById(id);
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            if (node.type === 'virtual') {
                return { error: 'Virtual nodes have no remote service to push config to', code: 400 };
            }
            emit('progress', { message: `Updating config on ${node.name}...` });
            const success = await getSyncService().updateNodeConfig(node);
            if (success) return { success: true, message: 'Config updated' };
            return { success: false, error: 'Failed to update config' };
        }

        case 'setup_port_hopping': {
            if (!id) throw new Error('id is required for setup_port_hopping');
            const node = await HyNode.findById(id);
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            if (node.type === 'virtual') {
                return { error: 'Virtual nodes have no remote server', code: 400 };
            }
            emit('progress', { message: `Configuring port hopping on ${node.name}...` });
            const success = await getSyncService().setupPortHopping(node);
            if (success) return { success: true, message: 'Port hopping configured' };
            return { success: false, error: 'Failed to configure port hopping' };
        }

        case 'generate_xray_keys': {
            if (!id) throw new Error('id is required for generate_xray_keys');
            const node = await HyNode.findById(id);
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            if (node.type !== 'xray') return { error: 'Node is not an Xray node', code: 400 };

            emit('progress', { message: `Generating x25519 Reality keys for ${node.name}...` });

            // Generate locally — no dependency on xray being installed on the node.
            const keys = cryptoService.generateX25519KeysLocal();

            await HyNode.findByIdAndUpdate(id, {
                $set: {
                    'xray.realityPrivateKey': keys.privateKey,
                    'xray.realityPublicKey': keys.publicKey,
                },
            });
            await invalidateNodesCache();
            logger.info(`[MCP] x25519 keys generated for ${node.name}`);
            return { success: true, publicKey: keys.publicKey };
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

async function scanSni(args, emit) {
    const parsed = scanSniSchema.parse(args);
    const sniScanner = require('../../services/sniScanner');

    if (!sniScanner.isValidIpv4(parsed.ip)) {
        return { error: 'Invalid IPv4 address', code: 400 };
    }

    const controller = new AbortController();
    const results = await sniScanner.scanRange({
        ip: parsed.ip,
        port: parsed.port,
        threads: parsed.threads,
        timeout: parsed.timeout,
        signal: controller.signal,
        onResult: (r) => emit('log', { type: 'result', ...r }),
        onProgress: (done, total) => emit('progress', { done, total }),
    });

    return { success: true, ip: parsed.ip, port: parsed.port, count: results.length, results };
}

async function executeSsh(args, emit) {
    const parsed = executeSshSchema.parse(args);
    const { nodeId, command, timeout } = parsed;

    const node = await HyNode.findById(nodeId);
    if (!node) return { error: `Node '${nodeId}' not found`, code: 404 };
    if (node.type === 'virtual') {
        return { error: 'Virtual nodes have no SSH host', code: 400 };
    }

    emit('progress', { message: `Connecting to ${node.name} (${node.ip})...` });

    return new Promise((resolve) => {
        const conn = new Client();
        const sshCfg = buildSshConfig(node);
        let output = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            conn.end();
            resolve({ success: false, error: 'Command timed out', output });
        }, timeout);

        conn.on('ready', () => {
            emit('progress', { message: `Executing: ${command}` });
            conn.exec(command, (err, stream) => {
                if (err) {
                    clearTimeout(timer);
                    conn.end();
                    resolve({ success: false, error: err.message });
                    return;
                }

                stream.on('data', (chunk) => {
                    const text = chunk.toString('utf8');
                    output += text;
                    emit('log', { type: 'stdout', text });
                });

                stream.stderr.on('data', (chunk) => {
                    const text = chunk.toString('utf8');
                    output += text;
                    emit('log', { type: 'stderr', text });
                });

                stream.on('close', (code) => {
                    clearTimeout(timer);
                    conn.end();
                    if (!timedOut) {
                        resolve({ success: code === 0, exitCode: code, output });
                    }
                });
            });
        });

        conn.on('error', (err) => {
            clearTimeout(timer);
            resolve({ success: false, error: `SSH connection error: ${err.message}` });
        });

        conn.connect(sshCfg);
    });
}

async function sshSession(args, emit) {
    const parsed = sshSessionSchema.parse(args);
    const { action, nodeId, sessionId, data } = parsed;

    switch (action) {
        case 'start': {
            if (!nodeId) throw new Error('nodeId is required for start');
            const node = await HyNode.findById(nodeId);
            if (!node) return { error: `Node '${nodeId}' not found`, code: 404 };
            if (node.type === 'virtual') {
                return { error: 'Virtual nodes have no SSH host', code: 400 };
            }

            const sid = require('crypto').randomUUID();
            emit('progress', { message: `Connecting to ${node.name} (${node.ip})...` });

            return new Promise((resolve, reject) => {
                const conn = new Client();
                const sshCfg = buildSshConfig(node);

                conn.on('ready', () => {
                    conn.shell({ term: 'xterm-256color', cols: 200, rows: 50 }, (err, stream) => {
                        if (err) { conn.end(); return reject(err); }

                        const buf = [];
                        sshSessions.set(sid, { conn, stream, buffer: buf, node: node.name });

                        stream.on('data', (chunk) => {
                            emit('log', { type: 'stdout', sessionId: sid, text: chunk.toString('utf8') });
                        });
                        stream.stderr.on('data', (chunk) => {
                            emit('log', { type: 'stderr', sessionId: sid, text: chunk.toString('utf8') });
                        });
                        stream.on('close', () => {
                            sshSessions.delete(sid);
                            emit('log', { type: 'info', sessionId: sid, text: 'Session closed' });
                        });

                        resolve({ success: true, sessionId: sid, message: `SSH session started on ${node.name}` });
                    });
                });

                conn.on('error', (err) => {
                    reject(new Error(`SSH error: ${err.message}`));
                });

                conn.connect(sshCfg);
            });
        }

        case 'input': {
            if (!sessionId) throw new Error('sessionId is required for input');
            const session = sshSessions.get(sessionId);
            if (!session) return { error: `Session '${sessionId}' not found or expired`, code: 404 };
            session.stream.write(data || '');
            return { success: true };
        }

        case 'close': {
            if (!sessionId) throw new Error('sessionId is required for close');
            const session = sshSessions.get(sessionId);
            if (session) {
                session.stream.end();
                session.conn.end();
                sshSessions.delete(sessionId);
            }
            return { success: true, message: 'Session closed' };
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

module.exports = {
    queryNodes,
    manageNode,
    executeSsh,
    sshSession,
    scanSni,
    schemas: {
        queryNodes: queryNodesSchema,
        manageNode: manageNodeSchema,
        executeSsh: executeSshSchema,
        sshSession: sshSessionSchema,
        scanSni: scanSniSchema,
    },
};
