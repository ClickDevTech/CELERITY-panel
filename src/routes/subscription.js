/**
 * Subscription API (Hysteria 2 + VLESS)
 * 
 * Single route /api/files/:token:
 * - Browser → HTML page
 * - App → subscription in the appropriate format
 * 
 * With Redis caching for high performance
 */

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const HyUser = require('../models/hyUserModel');
const HyNode = require('../models/hyNodeModel');
const cache = require('../services/cacheService');
const logger = require('../utils/logger');
const appConfig = require('../../config');
const { getNodesByGroups, getSettings, parseDurationSeconds, normalizeHopInterval } = require('../utils/helpers');
const { escapeHtml, formatPageNoteHtml } = require('../utils/textSanitize');
const { formatTraffic } = require('../utils/formatTraffic');
const { getDateLocale, normalizeLanguage } = require('../middleware/i18n');
const uaStats = require('../services/uaStatsService');
const { extractHwidHeaders } = require('../utils/hwidHeaders');
const hwidDeviceService = require('../services/hwidDeviceService');
const webhookService = require('../services/webhookService');
const { isServerlessNode } = require('../utils/nodeTypes');
const { isValidXhttpRange, isAllZeroRange } = require('../utils/xhttpOptions');
const { distributeFingerprints, pickFingerprint } = require('../utils/fingerprints');

// ==================== HELPERS ====================

function detectFormat(userAgent) {
    const ua = (userAgent || '').toLowerCase();
    // Shadowrocket expects base64-encoded URI list
    if (/shadowrocket/.test(ua)) return 'shadowrocket';
    // HAPP / Incy (Xray-core based) — plain URI list, upgraded to xray-json when
    // a virtual node is present (see generateSubscriptionData).
    if (/happ/.test(ua)) return 'uri';
    if (/incy/.test(ua)) return 'uri';
    // sing-box based clients — checked BEFORE clash because Hiddify UA contains "ClashMeta"
    // Example: "HiddifyNext/4.0.5 (android) like ClashMeta v2ray sing-box"
    if (/hiddify|hiddifynext|sing-?box|nekobox|nekoray|neko|sfi|sfa|sfm|sft|karing/.test(ua)) return 'singbox';
    if (/clash|stash|surge|loon/.test(ua)) return 'clash';
    return 'uri';
}

// HAPP and Incy: Xray-core clients sharing our xray-json profile array and the
// ://routing/onadd/{base64} routing deep-link (only the URL scheme differs).
function isHappUa(userAgent) {
    return /happ/i.test(userAgent || '');
}
function isIncyUa(userAgent) {
    return /incy/i.test(userAgent || '');
}
function isXrayProfileClient(userAgent) {
    return isHappUa(userAgent) || isIncyUa(userAgent);
}

function isBrowser(req) {
    const accept = req.headers.accept || '';
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    return accept.includes('text/html') && /mozilla|chrome|safari|edge|opera/.test(ua);
}

async function getUserByToken(token) {
    const user = await HyUser.findOne({ subscriptionToken: token })
        .populate('nodes', 'active name type status onlineUsers maxOnlineUsers rankingCoefficient domain sni ip port portRange hopInterval portConfigs obfs flag xray cascadeRole groups virtual cdn')
        .populate('groups', '_id name subscriptionTitle maxDevices');
    
    return user;
}

/**
 * Get subscription title for a user.
 * Takes subscriptionTitle from the first group, or the group name.
 */
function getSubscriptionTitle(user) {
    if (!user.groups || user.groups.length === 0) {
        return 'Hysteria';
    }
    
    // Take the first group
    const group = user.groups[0];
    return group.subscriptionTitle || group.name || 'Hysteria';
}

/**
 * Encode title in base64 (Marzban-compatible format)
 */
function encodeTitle(text) {
    return `base64:${Buffer.from(text).toString('base64')}`;
}

/**
 * Build a Content-Disposition value for a subscription filename (RFC 6266).
 *
 * Node rejects any header value containing bytes outside ISO-8859-1, so a
 * username written in Cyrillic (probe users are named after the probe) would
 * throw and turn the whole subscription into a 500. The ASCII form keeps old
 * clients working, `filename*` carries the original name for the rest.
 */
/**
 * Keep a header value only when it is safe to send as-is. Stripping characters
 * from a URL would produce a broken link, so a value with anything outside
 * printable ASCII is dropped and the header is omitted.
 */
function asciiHeaderValue(value) {
    const raw = String(value || '').trim();
    return /^[\x20-\x7e]*$/.test(raw) ? raw : '';
}

function buildContentDisposition(name) {
    const raw = String(name || '').trim() || 'subscription';
    const ascii = raw.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || 'subscription';
    const encoded = encodeURIComponent(raw).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Get active nodes (with caching)
 */
async function getActiveNodesWithCache() {
    const cached = await cache.getActiveNodes();
    if (cached) return cached;

    // Include type, xray, obfs, and cascadeRole fields needed for URI generation and filtering
    const nodes = await HyNode.find({ active: true })
        .select('name type flag ip domain sni port portRange hopInterval portConfigs obfs active status onlineUsers maxOnlineUsers rankingCoefficient groups xray cascadeRole virtual cdn')
        .lean();
    await cache.setActiveNodes(nodes);
    return nodes;
}

async function getActiveNodes(user) {
    let nodes = [];
    let settings;
    let allNodesForResolution = null;
    
    // Check if user has linked nodes
    if (user.nodes && user.nodes.length > 0) {
        // User has linked nodes - only need settings
        nodes = user.nodes.filter(n => n && n.active);
        const needsCdnOrigins = nodes.some(n => n.type === 'cdn');
        [settings, allNodesForResolution] = await Promise.all([
            getSettings(),
            needsCdnOrigins ? getActiveNodesWithCache() : Promise.resolve(null),
        ]);
        logger.debug(`[Sub] User ${user.userId}: ${nodes.length} linked active nodes`);
    } else {
        // No linked nodes - fetch nodes and settings in parallel for better performance
        const [allNodes, loadedSettings] = await Promise.all([
            getActiveNodesWithCache(),
            getSettings()
        ]);
        settings = loadedSettings;
        allNodesForResolution = allNodes;
        
        // Filter by user groups
        const userGroupIds = (user.groups || []).map(g => g._id?.toString() || g.toString());
        nodes = allNodes.filter(n => {
            const nodeGroupIds = (n.groups || []).map(g => g._id?.toString() || g.toString());
            return nodeGroupIds.some(gId => userGroupIds.includes(gId));
        });
        
        logger.debug(`[Sub] User ${user.userId}: ${nodes.length} nodes by groups`);
    }
    
    const lb = settings.loadBalancing || {};

    // Diagnostic probes must see the fleet as it is, not as it should be shown
    // to customers: hiding an offline node from a probe would switch external
    // monitoring off exactly when the node needs checking.
    const isProbe = user.isProbe === true;

    // Exclude exit (bridge) and relay nodes — users connect to entry (portal) or standalone nodes only.
    // Traffic is routed through the cascade automatically.
    {
        const beforeCascadeFilter = nodes.length;
        nodes = nodes.filter(n => n.cascadeRole !== 'bridge' && n.cascadeRole !== 'relay');
        if (nodes.length < beforeCascadeFilter) {
            logger.debug(`[Sub] Filtered out ${beforeCascadeFilter - nodes.length} bridge/relay nodes from subscription`);
        }
    }

    // Serverless nodes have no local capacity counters.
    if (lb.hideOverloaded && !isProbe) {
        const beforeFilter = nodes.length;
        nodes = nodes.filter(n => {
            if (isServerlessNode(n)) return true;
            if (!n.maxOnlineUsers || n.maxOnlineUsers === 0) return true;
            return n.onlineUsers < n.maxOnlineUsers;
        });
        if (nodes.length < beforeFilter) {
            logger.debug(`[Sub] Filtered out ${beforeFilter - nodes.length} overloaded nodes`);
        }
    }

    // Filter offline/error nodes flagged by the health checker.
    // Serverless nodes are never pinged (default status='offline') so they bypass.
    if (lb.hideOffline !== false && !isProbe) {
        const beforeFilter = nodes.length;
        nodes = nodes.filter(n => isServerlessNode(n) || (n.status !== 'offline' && n.status !== 'error'));
        if (nodes.length < beforeFilter) {
            logger.debug(`[Sub] Filtered out ${beforeFilter - nodes.length} offline/error nodes`);
        }
    }
    
    // Log node statuses (debug level to reduce overhead)
    if (nodes.length > 0) {
        const statuses = nodes.map(n => `${n.name}:${n.status}(${n.onlineUsers}/${n.maxOnlineUsers || '∞'})`).join(', ');
        logger.debug(`[Sub] Nodes for ${user.userId}: ${statuses}`);
    } else {
        logger.warn(`[Sub] NO NODES for user ${user.userId}! Check: active=true, groups match`);
    }
    
    // Sort nodes: virtual ("Auto") entries always come first regardless of LB
    // settings. Real nodes follow — by load percentage when LB is enabled,
    // otherwise by rankingCoefficient.
    const virtualCmp = (a, b) => (a.type === 'virtual' ? 0 : 1) - (b.type === 'virtual' ? 0 : 1);
    if (lb.enabled) {
        nodes.sort((a, b) => {
            const v = virtualCmp(a, b);
            if (v !== 0) return v;
            const loadA = a.maxOnlineUsers ? a.onlineUsers / a.maxOnlineUsers : 0;
            const loadB = b.maxOnlineUsers ? b.onlineUsers / b.maxOnlineUsers : 0;
            if (loadA !== loadB) return loadA - loadB;
            if (a.onlineUsers !== b.onlineUsers) return a.onlineUsers - b.onlineUsers;
            return (a.rankingCoefficient || 1) - (b.rankingCoefficient || 1);
        });
        logger.debug(`[Sub] Load balancing applied`);
    } else {
        nodes.sort((a, b) => {
            const v = virtualCmp(a, b);
            if (v !== 0) return v;
            return (a.rankingCoefficient || 1) - (b.rankingCoefficient || 1);
        });
    }

    resolveCdnOrigins(nodes, allNodesForResolution || nodes, lb.hideOffline !== false && !isProbe);
    resolveVirtualSources(nodes, user);

    return nodes;
}

/**
 * A CDN node is a facade over one inbound of its origin: the edges terminate TLS
 * but the traffic still lands on the origin server. So the front is only worth
 * publishing while the origin is reachable — otherwise the subscription fills up
 * with entries that dial a dead backend. `dropOfflineOrigin` mirrors the
 * hideOffline policy already applied to real nodes.
 */
function resolveCdnOrigins(nodes, allNodes, dropOfflineOrigin) {
    const originsById = new Map(
        (allNodes || [])
            .filter(node => node?.type === 'xray' && node.active !== false)
            .map(node => [String(node._id), node])
    );

    for (let index = nodes.length - 1; index >= 0; index--) {
        const node = nodes[index];
        if (node.type !== 'cdn') continue;
        const origin = originsById.get(String(node.cdn?.originNode?._id || node.cdn?.originNode || ''));
        if (!origin) {
            logger.debug(`[Sub] CDN node "${node.name}" dropped: origin is missing or inactive`);
            nodes.splice(index, 1);
            continue;
        }
        if (dropOfflineOrigin && (origin.status === 'offline' || origin.status === 'error')) {
            logger.debug(`[Sub] CDN node "${node.name}" dropped: origin is ${origin.status}`);
            nodes.splice(index, 1);
            continue;
        }
        node._resolvedOrigin = origin;
    }
}

/**
 * Mutates each virtual node in `nodes` by attaching a runtime `_resolvedSources`
 * array of real (non-virtual) sibling nodes that already passed all filters.
 * Virtual nodes with empty resolved set are removed from the array (no point
 * emitting an empty balancer).
 */
function resolveVirtualSources(nodes, user) {
    const realById = new Map();
    for (const n of nodes) {
        if (n.type !== 'virtual') realById.set(String(n._id), n);
    }
    const userGroupIds = new Set((user.groups || []).map(g => String(g._id || g)));

    for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (node.type !== 'virtual') continue;

        const cfg = node.virtual || {};
        let resolved = [];

        if (cfg.selectMode === 'group' && cfg.sourceGroup) {
            const groupId = String(cfg.sourceGroup);
            for (const real of realById.values()) {
                const realGroupIds = (real.groups || []).map(g => String(g._id || g));
                if (realGroupIds.includes(groupId)) resolved.push(real);
            }
        } else {
            const ids = (cfg.sources || []).map(s => String(s._id || s));
            for (const id of ids) {
                const real = realById.get(id);
                if (real) resolved.push(real);
            }
        }

        // Final guard: source must remain visible to this user via group overlap.
        // Real nodes already passed group filter above, but manual lists may include
        // nodes the user shouldn't see if administrator changed groups since.
        // Probes are bound to nodes explicitly and belong to no group, so the
        // overlap check would drop every balancer from their subscription.
        if (user.isProbe !== true) {
            resolved = resolved.filter(real => {
                const ids = (real.groups || []).map(g => String(g._id || g));
                return ids.some(id => userGroupIds.has(id));
            });
        }

        if (resolved.length === 0) {
            logger.debug(`[Sub] Virtual node "${node.name}" dropped: no resolved sources`);
            nodes.splice(i, 1);
            continue;
        }
        node._resolvedSources = resolved;
    }
}

function validateUser(user) {
    if (!user) return { valid: false, error: 'Not found' };
    // Expiry is checked before enabled: the scheduler auto-disables expired
    // users, so an expired account would otherwise report "Inactive".
    if (user.expireAt && new Date(user.expireAt) < new Date()) return { valid: false, error: 'Expired' };
    if (!user.enabled) return { valid: false, error: 'Inactive' };
    if (user.trafficLimit > 0) {
        const used = (user.traffic?.tx || 0) + (user.traffic?.rx || 0);
        if (used >= user.trafficLimit) return { valid: false, error: 'Traffic exceeded' };
    }
    return { valid: true };
}

function getNodeConfigs(node) {
    if (node.type !== 'hysteria') return [];
    const configs = [];
    const host = node.domain || node.ip;
    // SNI logic:
    // - If domain is set (ACME): SNI MUST be domain (server's sniGuard will reject other values)
    // - If no domain (self-signed): can use custom SNI for domain fronting
    const sni = node.domain ? node.domain : (node.sni || '');
    // hasCert: true if domain is set (ACME = valid cert)
    const hasCert = !!node.domain;
    const hopInterval = node.hopInterval || '';
    
    const obfs = node.obfs?.type || '';
    const obfsPassword = node.obfs?.password || '';

    if (node.portConfigs && node.portConfigs.length > 0) {
        node.portConfigs.filter(c => c.enabled).forEach(cfg => {
            configs.push({
                name: cfg.name || `Port ${cfg.port}`,
                host,
                port: cfg.port,
                portRange: cfg.portRange || '',
                hopInterval,
                sni,
                hasCert,
                obfs,
                obfsPassword,
            });
        });
    } else {
        configs.push({ name: 'TLS', host, port: node.port || 443, portRange: '', hopInterval, sni, hasCert, obfs, obfsPassword });
        // Port 80 removed (used for ACME)
        if (node.portRange) {
            configs.push({ name: 'Hopping', host, port: node.port || 443, portRange: node.portRange, hopInterval, sni, hasCert, obfs, obfsPassword });
        }
    }
    
    return configs;
}


// ==================== URI GENERATION ====================

function generateURI(user, node, config, dedupeLabel = _passthroughLabel) {
    // Auth contains userId for server-side identification
    const auth = `${user.userId}:${user.password}`;
    const params = [];
    
    // SNI for TLS handshake (can be custom domain for masquerading)
    if (config.sni) params.push(`sni=${config.sni}`);
    params.push('alpn=h3');
    // insecure=1 only if no valid certificate (self-signed without domain)
    params.push(`insecure=${config.hasCert ? '0' : '1'}`);
    if (config.portRange) {
        params.push(`mport=${config.portRange}`);
        const hopSec = parseDurationSeconds(normalizeHopInterval(config.hopInterval));
        if (hopSec > 0) params.push(`mportHopInt=${hopSec}`);
    }
    if (config.obfs && config.obfsPassword) {
        params.push(`obfs=${config.obfs}`);
        params.push(`obfs-password=${encodeURIComponent(config.obfsPassword)}`);
    }
    
    const name = dedupeLabel(`${node.flag || ''} ${node.name} ${config.name}`.trim());
    const uri = `hysteria2://${auth}@${config.host}:${config.port}?${params.join('&')}#${encodeURIComponent(name)}`;
    return uri;
}

/**
 * Build the list of inbound descriptors to advertise in the subscription.
 * The first entry is the main inbound (port = node.port, name = node label),
 * followed by every entry of `node.xray.extraInbounds` that has a port. Each
 * descriptor carries enough state to build a single VLESS URI / Clash proxy
 * / sing-box outbound / v2ray vnext.
 *
 * @param {Object} node - Node document with xray sub-object
 * @returns {Array<Object>} Inbound descriptors with `{port, nameSuffix, ...inboundFields}`
 */
function getXrayPublishedInbounds(node) {
    if (node.type === 'cdn') {
        const origin = node._resolvedOrigin;
        if (!origin || origin.type !== 'xray') return [];
        const originInbounds = getXrayPublishedInbounds(origin);
        const selectedId = String(node.cdn?.originInboundId || '');
        const source = selectedId
            ? originInbounds.find(inbound => String(inbound.extraId || '') === selectedId)
            : originInbounds.find(inbound => !inbound.extraId);
        if (!source) return [];

        const enabledEdges = (Array.isArray(node.cdn?.edges) ? node.cdn.edges : [])
            .filter(edge => edge?.enabled !== false && edge?.address);
        // Falling back to the public domain keeps the node reachable when every
        // edge is disabled (or none was ever pinned) instead of silently
        // dropping it from the subscription.
        const onDomain = enabledEdges.length === 0;
        const edges = onDomain
            ? [{ id: 'domain', label: '', address: node.cdn?.domain }]
            : enabledEdges;
        const fingerprints = distributeFingerprints(
            node.cdn?.fingerprint || source.fingerprint,
            node.cdn?.fingerprintPool,
            edges.length
        );
        return edges
            .filter(edge => edge.address)
            .map((edge, index) => ({
                ...source,
                address: edge.address,
                port: node.cdn?.port || 443,
                // Never fall back to the raw edge address: it would surface the
                // pinned CDN IP as a server name in the client UI.
                nameSuffix: onDomain ? '' : (String(edge.label || '').trim() || `Edge ${index + 1}`),
                uniqueName: false,
                extraId: source.extraId,
                edgeId: edge.id,
                security: 'tls',
                fingerprint: fingerprints[index],
                alpn: node.cdn?.alpn || [],
                wsPath: node.cdn?.path || source.wsPath,
                wsHost: node.cdn?.host || source.wsHost,
                grpcAuthority: node.cdn?.host || '',
                xhttpPath: node.cdn?.path || source.xhttpPath,
                xhttpHost: node.cdn?.host || source.xhttpHost,
                xhttpMode: node.cdn?.xhttpMode || source.xhttpMode,
            }));
    }
    if (node.type !== 'xray') return [];
    const xray = node.xray || {};
    const main = {
        address: node.domain || node.ip,
        port: node.port || 443,
        nameSuffix: '',
        // Stable identity of this inbound. Unused by client config builders,
        // consumed by the diagnostic probe manifest to key its results.
        extraId: null,
        inboundTag: xray.inboundTag || 'vless-in',
        transport: xray.transport,
        security: xray.security,
        flow: xray.flow,
        fingerprint: pickFingerprint(xray.fingerprint, xray.fingerprintPool),
        alpn: xray.alpn,
        realityPublicKey: xray.realityPublicKey,
        realitySni: xray.realitySni,
        realityShortIds: xray.realityShortIds,
        realitySpiderX: xray.realitySpiderX,
        wsPath: xray.wsPath,
        wsHost: xray.wsHost,
        grpcServiceName: xray.grpcServiceName,
        xhttpPath: xray.xhttpPath,
        xhttpHost: xray.xhttpHost,
        xhttpMode: xray.xhttpMode,
        xhttpXPaddingBytes: xray.xhttpXPaddingBytes,
        xhttpScMaxEachPostBytes: xray.xhttpScMaxEachPostBytes,
        xhttpNoGrpcHeader: xray.xhttpNoGrpcHeader,
        xhttpXmuxMaxConcurrency: xray.xhttpXmuxMaxConcurrency,
        xhttpXmuxHMaxRequestTimes: xray.xhttpXmuxHMaxRequestTimes,
        xhttpXmuxHMaxReusableSecs: xray.xhttpXmuxHMaxReusableSecs,
        xhttpUplinkHTTPMethod: xray.xhttpUplinkHTTPMethod,
        xhttpUplinkDataPlacement: xray.xhttpUplinkDataPlacement,
        xhttpUplinkDataKey: xray.xhttpUplinkDataKey,
        xhttpUplinkChunkSize: xray.xhttpUplinkChunkSize,
        xhttpScMinPostsIntervalMs: xray.xhttpScMinPostsIntervalMs,
        xhttpServerMaxHeaderBytes: xray.xhttpServerMaxHeaderBytes,
        xhttpXPaddingObfsMode: xray.xhttpXPaddingObfsMode,
        xhttpXPaddingKey: xray.xhttpXPaddingKey,
        xhttpXPaddingHeader: xray.xhttpXPaddingHeader,
        xhttpXPaddingPlacement: xray.xhttpXPaddingPlacement,
        xhttpXPaddingMethod: xray.xhttpXPaddingMethod,
        xhttpSessionPlacement: xray.xhttpSessionPlacement,
        xhttpSessionKey: xray.xhttpSessionKey,
        xhttpSessionIDTable: xray.xhttpSessionIDTable,
        xhttpSessionIDLength: xray.xhttpSessionIDLength,
        xhttpSeqPlacement: xray.xhttpSeqPlacement,
        xhttpSeqKey: xray.xhttpSeqKey,
    };

    const extras = (Array.isArray(xray.extraInbounds) ? xray.extraInbounds : [])
        .filter(i => i && i.port)
        .map(i => ({
            address: node.domain || node.ip,
            port: i.port,
            // Use a stable, human-readable suffix to disambiguate names inside
            // the client UI (clients keep server names unique). Prefer the
            // explicit label, fall back to "<transport>:<port>".
            nameSuffix: i.label && String(i.label).trim()
                ? String(i.label).trim()
                : `${i.transport || 'tcp'}:${i.port}`,
            // When uniqueName is set the label fully replaces the node name
            // in the published server name (issue #74).
            uniqueName: !!i.uniqueName,
            extraId: i.id,
            inboundTag: i.inboundTag,
            transport: i.transport,
            security: i.security,
            flow: i.flow,
            fingerprint: pickFingerprint(i.fingerprint, i.fingerprintPool),
            alpn: i.alpn,
            realityPublicKey: i.realityPublicKey,
            realitySni: i.realitySni,
            realityShortIds: i.realityShortIds,
            realitySpiderX: i.realitySpiderX,
            wsPath: i.wsPath,
            wsHost: i.wsHost,
            grpcServiceName: i.grpcServiceName,
            xhttpPath: i.xhttpPath,
            xhttpHost: i.xhttpHost,
            xhttpMode: i.xhttpMode,
            xhttpXPaddingBytes: i.xhttpXPaddingBytes,
            xhttpScMaxEachPostBytes: i.xhttpScMaxEachPostBytes,
            xhttpNoGrpcHeader: i.xhttpNoGrpcHeader,
            xhttpXmuxMaxConcurrency: i.xhttpXmuxMaxConcurrency,
            xhttpXmuxHMaxRequestTimes: i.xhttpXmuxHMaxRequestTimes,
            xhttpXmuxHMaxReusableSecs: i.xhttpXmuxHMaxReusableSecs,
            xhttpUplinkHTTPMethod: i.xhttpUplinkHTTPMethod,
            xhttpUplinkDataPlacement: i.xhttpUplinkDataPlacement,
            xhttpUplinkDataKey: i.xhttpUplinkDataKey,
            xhttpUplinkChunkSize: i.xhttpUplinkChunkSize,
            xhttpScMinPostsIntervalMs: i.xhttpScMinPostsIntervalMs,
            xhttpServerMaxHeaderBytes: i.xhttpServerMaxHeaderBytes,
            xhttpXPaddingObfsMode: i.xhttpXPaddingObfsMode,
            xhttpXPaddingKey: i.xhttpXPaddingKey,
            xhttpXPaddingHeader: i.xhttpXPaddingHeader,
            xhttpXPaddingPlacement: i.xhttpXPaddingPlacement,
            xhttpXPaddingMethod: i.xhttpXPaddingMethod,
            xhttpSessionPlacement: i.xhttpSessionPlacement,
            xhttpSessionKey: i.xhttpSessionKey,
            xhttpSessionIDTable: i.xhttpSessionIDTable,
            xhttpSessionIDLength: i.xhttpSessionIDLength,
            xhttpSeqPlacement: i.xhttpSeqPlacement,
            xhttpSeqKey: i.xhttpSeqKey,
        }));

    return [main, ...extras];
}

/**
 * Build a server display name for a single inbound. Main inbound uses the
 * node label as-is; extras append the suffix in parentheses unless the inbound
 * is marked as `uniqueName`, in which case the label replaces the node name.
 */
function _xrayInboundName(node, inbound) {
    const flag = node.flag || '';
    if (inbound.uniqueName && inbound.nameSuffix) {
        return `${flag} ${inbound.nameSuffix}`.trim();
    }
    const base = `${flag} ${node.name}`.trim();
    return inbound.nameSuffix ? `${base} (${inbound.nameSuffix})` : base;
}

/**
 * Server labels double as config tags in sing-box, Clash and v2ray-json, where a
 * repeated tag is a fatal parse error that costs the client the whole config.
 * Node names carry no uniqueness constraint in the DB (only `{ip, type}` does),
 * so every generator funnels its labels through one of these before emitting
 * them. Returns a function that passes the first occurrence through untouched
 * and suffixes later ones with a counter.
 */
function _createLabelDeduplicator() {
    const used = new Set();
    return function dedupeLabel(label) {
        const base = (label || '').trim() || 'node';
        if (!used.has(base)) {
            used.add(base);
            return base;
        }
        let n = 2;
        while (used.has(`${base} (${n})`)) n++;
        const unique = `${base} (${n})`;
        used.add(unique);
        return unique;
    };
}

/** No-op deduplicator, so callers may omit one without branching. */
const _passthroughLabel = label => label;

/**
 * Quote a value for the hand-rolled Clash YAML. Node names and paths are
 * operator-supplied, and a single `"` in one of them would otherwise truncate
 * the string and make the whole profile unparsable for the client.
 *
 * @param {string} value
 * @returns {string} double-quoted YAML scalar
 */
function _yamlString(value) {
    const escaped = String(value === undefined || value === null ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/[\r\n]+/g, ' ');
    return `"${escaped}"`;
}

/**
 * Validate an XHTTP range value ("100-1000", or a bare "500" meaning 500-500).
 * Anything else is dropped so a typo cannot make the client reject the config.
 */
function _xhttpRange(value) {
    const v = String(value || '').trim();
    return isValidXhttpRange(v) ? v : null;
}

// XHTTP framing knobs that must be identical on both ends, paired as
// [Xray camelCase, sing-box snake_case, mihomo kebab-case]. Every client format
// walks this one list, so a knob can never reach one core and silently miss
// another. `serverMaxHeaderBytes` is deliberately absent: it only sizes the
// inbound's own header buffer and means nothing to a client.
//
// The Xray spelling is the post-v26.6.22 one (session* → sessionID*, see
// XTLS/Xray-core#6258); mihomo kept the shorter names.
const XHTTP_CLIENT_TUNING_KEYS = [
    ['uplinkHTTPMethod', 'uplink_http_method', 'uplink-http-method'],
    ['uplinkDataPlacement', 'uplink_data_placement', 'uplink-data-placement'],
    ['uplinkDataKey', 'uplink_data_key', 'uplink-data-key'],
    ['uplinkChunkSize', 'uplink_chunk_size', 'uplink-chunk-size'],
    ['scMinPostsIntervalMs', 'sc_min_posts_interval_ms', 'sc-min-posts-interval-ms'],
    ['xPaddingObfsMode', 'x_padding_obfs_mode', 'x-padding-obfs-mode'],
    ['xPaddingKey', 'x_padding_key', 'x-padding-key'],
    ['xPaddingHeader', 'x_padding_header', 'x-padding-header'],
    ['xPaddingPlacement', 'x_padding_placement', 'x-padding-placement'],
    ['xPaddingMethod', 'x_padding_method', 'x-padding-method'],
    ['sessionIDPlacement', 'session_placement', 'session-placement'],
    ['sessionIDKey', 'session_key', 'session-key'],
    ['sessionIDTable', 'session_table', 'session-table'],
    ['sessionIDLength', 'session_length', 'session-length'],
    ['seqPlacement', 'seq_placement', 'seq-placement'],
    ['seqKey', 'seq_key', 'seq-key'],
];

/**
 * Add the pre-v26.6.22 spelling of the session keys to an Xray `extra` block.
 *
 * The rename carries no fallback in either direction, and the client core is
 * whatever the user installed, so both spellings ship: the older core reads
 * `session*` and ignores `sessionID*`, the newer one does the opposite.
 *
 * @param {Object} extra - Xray `extra` object, mutated in place
 * @returns {Object} the same object
 */
function _withXhttpSessionKeyCompat(extra) {
    if (extra.sessionIDPlacement) extra.sessionPlacement = extra.sessionIDPlacement;
    if (extra.sessionIDKey) extra.sessionKey = extra.sessionIDKey;
    return extra;
}

/**
 * Mihomo reads the whole framing block in `xhttp-opts` (kebab-case mirror of
 * Xray's `extra`), with one exception: `uplink-http-method: GET` parses but
 * never connects (MetaCubeX/mihomo#2832). An inbound that requires GET uploads
 * is therefore left out of the Clash profile instead of shipping a proxy that
 * looks healthy and times out on every request.
 *
 * @param {Object} inbound - published inbound descriptor
 * @returns {boolean}
 */
function _clashCanExpressInbound(inbound) {
    if ((inbound.transport || 'tcp') !== 'xhttp') return true;
    return _xhttpTuning(inbound).uplinkHTTPMethod !== 'GET';
}

/**
 * Collect the XHTTP tuning knobs of an inbound in a core-neutral shape.
 * Cores disagree on both casing and nesting, so each generator lays this out
 * itself: Xray puts camelCase keys under `xhttpSettings.extra`, sing-box forks
 * take snake_case keys directly on the transport object.
 *
 * @returns {{xPaddingBytes: string|null, scMaxEachPostBytes: string|null,
 *            noGrpcHeader: boolean, xmux: Object|null}}
 */
function _xhttpTuning(inbound) {
    const xmux = {};
    const maxConcurrency = _xhttpRange(inbound.xhttpXmuxMaxConcurrency);
    const hMaxRequestTimes = _xhttpRange(inbound.xhttpXmuxHMaxRequestTimes);
    const hMaxReusableSecs = _xhttpRange(inbound.xhttpXmuxHMaxReusableSecs);
    if (maxConcurrency) xmux.maxConcurrency = maxConcurrency;
    if (hMaxRequestTimes) xmux.hMaxRequestTimes = hMaxRequestTimes;
    if (hMaxReusableSecs) xmux.hMaxReusableSecs = hMaxReusableSecs;

    return {
        xPaddingBytes: _xhttpRange(inbound.xhttpXPaddingBytes),
        scMaxEachPostBytes: _xhttpRange(inbound.xhttpScMaxEachPostBytes),
        uplinkHTTPMethod: inbound.xhttpUplinkHTTPMethod || null,
        uplinkDataPlacement: inbound.xhttpUplinkDataPlacement || null,
        uplinkDataKey: inbound.xhttpUplinkDataKey || null,
        uplinkChunkSize: _xhttpRange(inbound.xhttpUplinkChunkSize),
        scMinPostsIntervalMs: _xhttpRange(inbound.xhttpScMinPostsIntervalMs),
        serverMaxHeaderBytes: Number(inbound.xhttpServerMaxHeaderBytes) || null,
        xPaddingObfsMode: !!inbound.xhttpXPaddingObfsMode,
        xPaddingKey: inbound.xhttpXPaddingKey || null,
        xPaddingHeader: inbound.xhttpXPaddingHeader || null,
        xPaddingPlacement: inbound.xhttpXPaddingPlacement || null,
        xPaddingMethod: inbound.xhttpXPaddingMethod || null,
        sessionIDPlacement: inbound.xhttpSessionPlacement || null,
        sessionIDKey: inbound.xhttpSessionKey || null,
        sessionIDTable: inbound.xhttpSessionIDTable || null,
        sessionIDLength: _xhttpRange(inbound.xhttpSessionIDLength),
        seqPlacement: inbound.xhttpSeqPlacement || null,
        seqKey: inbound.xhttpSeqKey || null,
        noGrpcHeader: !!inbound.xhttpNoGrpcHeader,
        xmux: Object.keys(xmux).length > 0 ? xmux : null,
    };
}

/**
 * Resolve TLS-related client knobs (server name, host header for transports
 * that masquerade as HTTP, allowInsecure flag) based on node.xray.tlsSource.
 *
 *   panel       → masquerade under PANEL_DOMAIN; panel's LE cert inlined.
 *   acme        → cert on node (acme.sh); SNI=node.domain (same as manual).
 *   manual      → operator-supplied node.domain; PEM inlined.
 *   self-signed → node.domain || node.sni; allowInsecure=true.
 *
 * Returns { sni, host, allowInsecure } where any value may be empty.
 *
 * @param {Object} node
 * @returns {{ sni: string, host: string, allowInsecure: boolean, source: string }}
 */
function _resolveXrayTlsClientHints(node) {
    if (node?.type === 'cdn') {
        const cdn = node.cdn || {};
        return {
            sni: cdn.sni || cdn.domain || '',
            host: cdn.host || cdn.domain || '',
            allowInsecure: false,
            source: 'cdn',
        };
    }
    const tlsSource = node?.xray?.tlsSource || 'panel';
    const fallbackSni = node?.domain || node?.sni || '';
    if (tlsSource === 'panel') {
        const panelDomain = (appConfig?.PANEL_DOMAIN || '').trim();
        if (panelDomain) {
            return { sni: panelDomain, host: panelDomain, allowInsecure: false, source: 'panel' };
        }
        // Operator forgot to set PANEL_DOMAIN — degrade gracefully to node fields.
        return { sni: fallbackSni, host: fallbackSni, allowInsecure: false, source: 'panel' };
    }
    if (tlsSource === 'manual' || tlsSource === 'acme') {
        const dom = (node?.domain || '').trim();
        return { sni: dom, host: dom, allowInsecure: false, source: tlsSource };
    }
    // self-signed
    return { sni: fallbackSni, host: fallbackSni, allowInsecure: true, source: 'self-signed' };
}

/**
 * Generate a VLESS URI for one inbound of an Xray node.
 * vless://{uuid}@{host}:{port}?type={transport}&security={security}&...#{name}
 */
function generateVlessURIForInbound(user, node, inbound, dedupeLabel = _passthroughLabel) {
    const uuid = user.xrayUuid;
    if (!uuid) return null;

    const host = inbound.address || node.domain || node.ip;
    const port = inbound.port || node.port || 443;
    const transport = inbound.transport || 'tcp';
    const security = inbound.security || 'reality';
    const fingerprint = inbound.fingerprint || 'chrome';

    const params = new URLSearchParams();
    // Modern Xray-core clients (HAPP, NekoBox, v2rayN, Streisand) expect
    // `type=xhttp`. The legacy `splithttp` keyword is rejected by some
    // clients and silently falls back to tcp, breaking the connection.
    params.set('type', transport);
    params.set('security', security);

    if (security === 'reality') {
        if (inbound.flow && transport === 'tcp') params.set('flow', inbound.flow);
        if (inbound.realityPublicKey) params.set('pbk', inbound.realityPublicKey);
        const sni = inbound.realitySni && inbound.realitySni[0] ? inbound.realitySni[0] : '';
        if (sni) params.set('sni', sni);
        // Prefer non-empty shortId if available
        const shortIds = inbound.realityShortIds || [''];
        const sid = shortIds.find(id => id && id.length > 0) || shortIds[0] || '';
        params.set('sid', sid);
        if (inbound.realitySpiderX) params.set('spx', inbound.realitySpiderX);
        params.set('fp', fingerprint);
    } else if (security === 'tls') {
        if (inbound.flow && transport === 'tcp') params.set('flow', inbound.flow);
        const tls = _resolveXrayTlsClientHints(node);
        if (tls.sni) params.set('sni', tls.sni);
        params.set('fp', fingerprint);
        if (inbound.alpn && inbound.alpn.length > 0) {
            params.set('alpn', inbound.alpn.join(','));
        }
        if (tls.allowInsecure) params.set('allowInsecure', '1');
    }

    if (transport === 'ws') {
        params.set('path', inbound.wsPath || '/');
        // For TLS inbounds without an explicit wsHost we mirror the SNI so the
        // server's masquerade matches the Host header (panel/manual scenarios).
        const wsHost = inbound.wsHost || (security === 'tls' ? _resolveXrayTlsClientHints(node).host : '');
        if (wsHost) params.set('host', wsHost);
    } else if (transport === 'grpc') {
        params.set('serviceName', inbound.grpcServiceName || 'grpc');
        params.set('mode', 'gun');
        if (inbound.grpcAuthority) params.set('authority', inbound.grpcAuthority);
    } else if (transport === 'xhttp') {
        params.set('path', inbound.xhttpPath || '/');
        // Same reasoning as ws — use the masquerade domain as a Host hint when
        // the operator did not set xhttpHost explicitly.
        const xhttpHost = inbound.xhttpHost || (security === 'tls' ? _resolveXrayTlsClientHints(node).host : '');
        if (xhttpHost) params.set('host', xhttpHost);
        if (inbound.xhttpMode && inbound.xhttpMode !== 'auto') params.set('mode', inbound.xhttpMode);
        // Framing has to match on both ends or the inbound answers 400, so every
        // knob is published twice, the way clients read it: flat snake_case for
        // the sing-box family, an `extra` JSON blob for the Xray family
        // (v2rayNG, HAPP). One-sided knobs (xmux, noGRPCHeader) stay out —
        // extra fields make some parsers reject the URI.
        const tuning = _xhttpTuning(inbound);
        const extra = {};
        if (tuning.xPaddingBytes) {
            params.set('x_padding_bytes', tuning.xPaddingBytes);
            extra.xPaddingBytes = tuning.xPaddingBytes;
        }
        if (tuning.scMaxEachPostBytes) {
            params.set('sc_max_each_post_bytes', tuning.scMaxEachPostBytes);
            extra.scMaxEachPostBytes = tuning.scMaxEachPostBytes;
        }
        for (const [camel, snake] of XHTTP_CLIENT_TUNING_KEYS) {
            const value = tuning[camel];
            if (value === null || value === false || value === '') continue;
            params.set(snake, String(value));
            extra[camel] = value;
        }
        _withXhttpSessionKeyCompat(extra);
        if (Object.keys(extra).length > 0) params.set('extra', JSON.stringify(extra));
    }

    const name = dedupeLabel(_xrayInboundName(node, inbound));
    const authorityHost = String(host).includes(':') ? `[${host}]` : host;
    return `vless://${uuid}@${authorityHost}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

/**
 * Generate VLESS URIs for every published inbound of an Xray node (main + extras).
 * Returns an array of strings (skip null results when uuid is missing).
 */
function generateVlessURIs(user, node, dedupeLabel = _passthroughLabel) {
    const uuid = user.xrayUuid;
    if (!uuid) return [];
    return getXrayPublishedInbounds(node)
        .map(inbound => generateVlessURIForInbound(user, node, inbound, dedupeLabel))
        .filter(Boolean);
}

/**
 * Backward-compatible single-URI helper: returns the URI for the main inbound
 * only. Existing callers that show one URI per node (preview pages, single-node
 * helpers) keep working unchanged. New callers should use generateVlessURIs.
 */
function generateVlessURI(user, node) {
    const uris = generateVlessURIs(user, node);
    return uris.length > 0 ? uris[0] : null;
}

// ==================== ROUTING RULE CONVERTERS ====================

/**
 * Convert routing rules array from DB to Xray routing rules array.
 * Rules of the same action and field type are grouped for efficiency.
 */
function buildXrayRules(rules) {
    if (!rules || rules.length === 0) return [];

    const xrayRules = [];
    // Group consecutive rules of the same action into domain/ip buckets
    // to produce minimal rule objects (one object per action+fieldType pair)
    const domainRulesByAction = { direct: [], block: [] };
    const ipRulesByAction     = { direct: [], block: [] };
    // We process in order and flush when action changes
    const domainTypes = new Set(['domain_suffix', 'domain_keyword', 'domain', 'geosite']);
    const ipTypes     = new Set(['geoip', 'ip_cidr']);

    for (const r of rules) {
        if (!r.enabled) continue;
        const action = r.action === 'block' ? 'block' : 'direct';

        if (domainTypes.has(r.type)) {
            let xrayVal;
            if      (r.type === 'domain_suffix')  xrayVal = `domain:${r.value.replace(/^\./, '')}`;
            else if (r.type === 'domain_keyword')  xrayVal = `keyword:${r.value}`;
            else if (r.type === 'domain')          xrayVal = `full:${r.value}`;
            else                                   xrayVal = `geosite:${r.value}`;
            domainRulesByAction[action].push(xrayVal);
        } else if (ipTypes.has(r.type)) {
            let xrayVal = r.type === 'geoip' ? `geoip:${r.value}` : r.value;
            ipRulesByAction[action].push(xrayVal);
        }
    }

    for (const action of ['direct', 'block']) {
        if (domainRulesByAction[action].length > 0) {
            xrayRules.push({ type: 'field', domain: domainRulesByAction[action], outboundTag: action });
        }
        if (ipRulesByAction[action].length > 0) {
            xrayRules.push({ type: 'field', ip: ipRulesByAction[action], outboundTag: action });
        }
    }
    return xrayRules;
}

/**
 * Normalize a DNS address into a scheme Xray-core supports.
 * Xray has no DoT (`tls://`) scheme, so map it to DoH; bare DoQ → local DoQ.
 */
function normalizeXrayDnsAddr(addr) {
    if (!addr) return null;
    const s = String(addr).trim();
    if (!s) return null;
    if (/^tls:\/\//i.test(s)) {
        // DoT is :853, DoH is :443 — drop an explicit DoT port on conversion.
        const host = s.slice(6).replace(/\/+$/, '').replace(/:853$/, '');
        return `https://${host}/dns-query`;
    }
    if (/^quic:\/\//i.test(s)) {
        return `quic+local://${s.slice(7).replace(/\/+$/, '')}`;
    }
    return s;
}

/**
 * Build Xray split-DNS servers array from routing rules + dns settings.
 * Domestic domains get routed to domestic DNS server.
 */
function buildXrayDns(rules, dns) {
    const domesticDns = normalizeXrayDnsAddr((dns && dns.domestic) || '77.88.8.8');
    const remoteDns   = normalizeXrayDnsAddr((dns && dns.remote)   || 'tls://1.1.1.1');

    const domesticDomains = [];
    for (const r of (rules || [])) {
        if (!r.enabled || r.action !== 'direct') continue;
        if (r.type === 'domain_suffix')  domesticDomains.push(`domain:${r.value.replace(/^\./, '')}`);
        else if (r.type === 'domain')    domesticDomains.push(`full:${r.value}`);
        else if (r.type === 'geosite')   domesticDomains.push(`geosite:${r.value}`);
    }

    const servers = [];
    if (domesticDomains.length > 0) {
        servers.push({ address: domesticDns, domains: domesticDomains });
    }
    servers.push(remoteDns);
    servers.push('8.8.8.8');
    return servers;
}

// sing-geosite publishes some regional lists only under a `category-` prefix,
// while the panel stores the short form because that is what Xray expects.
const SINGBOX_GEOSITE_ALIASES = {
    ru: 'category-ru',
    ads: 'category-ads-all',
};

// sing-geosite tag charset, verified against the published rule-set branch:
// lowercase alphanumerics plus `-`, and the attribute forms `name@cn` /
// `geolocation-!cn`. Longest published tag is 37 chars.
const SINGBOX_GEOSITE_TAG_RE = /^[a-z0-9][a-z0-9@!-]{0,47}$/;

// sing-geoip publishes ISO country codes only — no provider lists (unlike
// Xray's geoip.dat, which also carries telegram, google, cloudflare, ...).
const SINGBOX_GEOIP_TAG_RE = /^[a-z]{2}$/;

/**
 * Resolve a routing rule value to a published sing-box rule_set tag, or null
 * when no matching `.srs` exists. Dropping the condition is the safer outcome:
 * a rule_set URL that 404s makes sing-box discard the entire config, so one
 * unsupported value would cost the user every other rule too.
 *
 * Format check only — no network calls, subscription generation stays hot-path.
 * The charsets double as URL sanitising: neither pattern admits `/` or `.`, so
 * a rule value cannot escape the rule-set path.
 *
 * @param {string} type  'geosite' | 'geoip'
 * @param {string} rawValue
 * @returns {string|null}
 */
function _singboxRuleSetTag(type, rawValue) {
    const value = String(rawValue || '').trim().toLowerCase();
    if (!value) return null;
    if (type === 'geosite') {
        const mapped = SINGBOX_GEOSITE_ALIASES[value] || value;
        return SINGBOX_GEOSITE_TAG_RE.test(mapped) ? `geosite-${mapped}` : null;
    }
    if (type === 'geoip' && SINGBOX_GEOIP_TAG_RE.test(value)) {
        return `geoip-${value}`;
    }
    return null;
}

/**
 * Convert routing rules to sing-box 1.13+ route.rules entries.
 * geosite/geoip replaced with rule_set references (removed in sing-box 1.12).
 * Returns { rules: [], ruleSets: [] } so the caller can inject rule_set definitions.
 */
function buildSingboxRules(rules) {
    if (!rules || rules.length === 0) return { rules: [], ruleSets: [] };

    const buckets = {};
    const order   = [];
    const ruleSetTags = new Set();

    for (const r of rules) {
        if (!r.enabled) continue;
        const action = r.action === 'block' ? 'block' : 'direct';
        const key = `${action}:${r.type}`;

        if (!buckets[key]) {
            buckets[key] = { action, _type: r.type, values: [] };
            order.push(key);
        }
        buckets[key].values.push(r.value);
    }

    const resultRules = order.flatMap(k => {
        const b = buckets[k];
        const newRule = () => (b.action === 'block'
            ? { action: 'reject' }
            : { action: 'route', outbound: 'direct' });
        const rule = newRule();

        switch (b._type) {
            case 'domain_suffix':  rule.domain_suffix  = b.values; break;
            case 'domain_keyword': rule.domain_keyword = b.values; break;
            case 'domain':         rule.domain         = b.values; break;
            case 'geosite': {
                const tags = [];
                for (const v of b.values) {
                    const tag = _singboxRuleSetTag('geosite', v);
                    if (!tag) continue;
                    ruleSetTags.add(tag);
                    tags.push(tag);
                }
                if (tags.length === 0) return [];
                rule.rule_set = tags;
                break;
            }
            case 'geoip': {
                const tags = [];
                let hasPrivate = false;
                for (const v of b.values) {
                    if (String(v || '').trim().toLowerCase() === 'private') {
                        hasPrivate = true;
                        continue;
                    }
                    const tag = _singboxRuleSetTag('geoip', v);
                    if (!tag) continue;
                    ruleSetTags.add(tag);
                    tags.push(tag);
                }
                const out = [];
                if (tags.length > 0) {
                    rule.rule_set = tags;
                    out.push(rule);
                }
                if (hasPrivate) {
                    // `private` is a built-in flag, not a published list. It also
                    // needs a rule of its own: fields within one rule are ANDed,
                    // so pairing it with a country rule_set would match nothing.
                    const privateRule = newRule();
                    privateRule.ip_is_private = true;
                    out.push(privateRule);
                }
                return out;
            }
            case 'ip_cidr':        rule.ip_cidr        = b.values; break;
        }
        return [rule];
    });

    const ruleSets = [...ruleSetTags].map(tag => {
        const isGeoip = tag.startsWith('geoip-');
        const repo = isGeoip ? 'sing-geoip' : 'sing-geosite';
        return {
            tag,
            type: 'remote',
            format: 'binary',
            url: `https://raw.githubusercontent.com/SagerNet/${repo}/rule-set/${tag}.srs`,
        };
    });

    return { rules: resultRules, ruleSets };
}

/**
 * Build sing-box 1.13+ DNS servers+rules for split DNS.
 * Uses typed server format and rule_set instead of deprecated geosite.
 * Returns { servers, rules, final, ruleSets }.
 */
function buildSingboxDns(rules, dns) {
    const domesticAddr = (dns && dns.domestic) ? dns.domestic : '77.88.8.8';
    const remoteAddr   = (dns && dns.remote)   ? dns.remote   : 'tls://1.1.1.1';
    const ruleSetTags = new Set();

    const remoteServer = _parseSingboxDnsServer(remoteAddr, 'dns-remote', 'dns-local', 'proxy');
    const servers = [
        remoteServer,
        { type: 'udp', tag: 'dns-direct', server: domesticAddr, detour: 'direct' },
        { type: 'udp', tag: 'dns-local',  server: domesticAddr, detour: 'direct' },
    ];

    const dnsRules = [];

    const suffixes = [], geositeTags = [];
    for (const r of (rules || [])) {
        if (!r.enabled || r.action !== 'direct') continue;
        if (r.type === 'domain_suffix') suffixes.push(r.value);
        if (r.type === 'geosite') {
            const tag = _singboxRuleSetTag('geosite', r.value);
            if (!tag) continue;
            geositeTags.push(tag);
            ruleSetTags.add(tag);
        }
    }
    if (suffixes.length > 0) dnsRules.push({ domain_suffix: suffixes, server: 'dns-direct' });
    if (geositeTags.length > 0) dnsRules.push({ rule_set: geositeTags, server: 'dns-direct' });

    const ruleSets = [...ruleSetTags].map(tag => ({
        tag,
        type: 'remote',
        format: 'binary',
        url: `https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/${tag}.srs`,
    }));

    return { servers, rules: dnsRules, final: 'dns-remote', ruleSets };
}

/**
 * Parse a DNS address string into a sing-box 1.12+ typed server object.
 * `detour` is applied to encrypted servers only (DoT/DoH): without it sing-box
 * dials them from the physical interface, which DPI-heavy ISPs commonly drop,
 * leaving the tunnel up while name resolution silently fails.
 */
function _parseSingboxDnsServer(addr, tag, domainResolver, detour) {
    if (addr.startsWith('tls://')) {
        const server = { type: 'tls', tag, server: addr.slice(6) };
        if (domainResolver) server.domain_resolver = domainResolver;
        if (detour) server.detour = detour;
        return server;
    }
    if (addr.startsWith('https://')) {
        try {
            const url = new URL(addr);
            const server = { type: 'https', tag, server: url.hostname };
            if (domainResolver) server.domain_resolver = domainResolver;
            if (detour) server.detour = detour;
            return server;
        } catch { /* fall through */ }
    }
    const server = { type: 'udp', tag, server: addr };
    if (domainResolver) server.domain_resolver = domainResolver;
    return server;
}

/**
 * Convert routing rules to Clash Meta rules array strings.
 */
function buildClashRules(rules) {
    if (!rules || rules.length === 0) return [];

    const result = [];
    for (const r of rules) {
        if (!r.enabled) continue;
        const target = r.action === 'block' ? 'REJECT' : 'DIRECT';
        switch (r.type) {
            case 'domain_suffix':  result.push(`DOMAIN-SUFFIX,${r.value},${target}`); break;
            case 'domain_keyword': result.push(`DOMAIN-KEYWORD,${r.value},${target}`); break;
            case 'domain':         result.push(`DOMAIN,${r.value},${target}`); break;
            case 'geosite':        result.push(`GEOSITE,${r.value},${target}`); break;
            case 'geoip':          result.push(`GEOIP,${r.value},${target},no-resolve`); break;
            case 'ip_cidr':        result.push(`IP-CIDR,${r.value},${target},no-resolve`); break;
        }
    }
    return result;
}

/**
 * Build HAPP-native routing profile JSON from DB rules.
 * HAPP uses its own routing format (DirectSites/DirectIp/BlockSites/BlockIp)
 * delivered via happ://routing/onadd/{base64} link.
 * See: https://www.happ.su/main/dev-docs/routing
 */
function buildHappRoutingProfile(routing) {
    if (!routing || !routing.enabled || !routing.rules || routing.rules.length === 0) return null;

    const domesticDns = (routing.dns && routing.dns.domestic) || '77.88.8.8';
    const remoteDns   = (routing.dns && routing.dns.remote)   || 'tls://1.1.1.1';

    const profile = {
        Name: 'Auto',
        GlobalProxy: 'true',
        DomainStrategy: 'IPIfNonMatch',
        FakeDNS: 'false',
        DirectSites: [],
        DirectIp: [
            '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
            '169.254.0.0/16', '224.0.0.0/4', '255.255.255.255',
        ],
        ProxySites: [],
        ProxyIp: [],
        BlockSites: [],
        BlockIp: [],
    };

    // Parse remote DNS (tls://IP → DoT, https://url → DoH, plain IP → DoU)
    if (remoteDns.startsWith('tls://')) {
        profile.RemoteDNSType = 'DoT';
        profile.RemoteDNSIP = remoteDns.slice(6);
        profile.RemoteDNSDomain = '';
    } else if (remoteDns.startsWith('https://')) {
        profile.RemoteDNSType = 'DoH';
        profile.RemoteDNSDomain = remoteDns;
        profile.RemoteDNSIP = '1.1.1.1';
        try {
            const hostname = new URL(remoteDns).hostname;
            profile.DnsHosts = { [hostname]: profile.RemoteDNSIP };
        } catch {}
    } else {
        profile.RemoteDNSType = 'DoU';
        profile.RemoteDNSIP = remoteDns;
        profile.RemoteDNSDomain = '';
    }

    // Domestic DNS (plain IP → DoU)
    profile.DomesticDNSType = 'DoU';
    profile.DomesticDNSIP = domesticDns;
    profile.DomesticDNSDomain = '';

    for (const r of routing.rules) {
        if (!r.enabled) continue;

        // Domain-type rules → DirectSites / BlockSites
        let siteVal = null;
        if      (r.type === 'geosite')        siteVal = `geosite:${r.value}`;
        else if (r.type === 'domain_suffix')   siteVal = `domain:${r.value.replace(/^\./, '')}`;
        else if (r.type === 'domain')          siteVal = `full:${r.value}`;
        else if (r.type === 'domain_keyword')  siteVal = `keyword:${r.value}`;

        // IP-type rules → DirectIp / BlockIp
        let ipVal = null;
        if      (r.type === 'geoip')   ipVal = `geoip:${r.value}`;
        else if (r.type === 'ip_cidr') ipVal = r.value;

        if (r.action === 'direct') {
            if (siteVal) profile.DirectSites.push(siteVal);
            if (ipVal)   profile.DirectIp.push(ipVal);
        } else if (r.action === 'block') {
            if (siteVal) profile.BlockSites.push(siteVal);
            if (ipVal)   profile.BlockIp.push(ipVal);
        }
    }

    return profile;
}

/**
 * Build Clash DNS section for split DNS.
 */
function buildClashDns(rules, dns) {
    const domestic = (dns && dns.domestic) ? dns.domestic : '77.88.8.8';
    const remote   = (dns && dns.remote)   ? dns.remote   : 'tls://1.1.1.1';

    const policy = {};
    for (const r of (rules || [])) {
        if (!r.enabled || r.action !== 'direct') continue;
        if (r.type === 'domain_suffix') policy[`+${r.value}`]    = domestic;
        if (r.type === 'geosite')       policy[`geosite:${r.value}`] = domestic;
    }

    return {
        enable: true,
        ipv6: false,
        'default-nameserver': [domestic],
        nameserver: [remote],
        'nameserver-policy': Object.keys(policy).length > 0 ? policy : undefined,
    };
}

// ==================== FORMAT GENERATORS ====================

function generateURIList(user, nodes) {
    const uris = [];
    const dedupeLabel = _createLabelDeduplicator();
    nodes.forEach(node => {
        if (node.type === 'virtual') {
            // URI list cannot represent a balancer; clients that hit this format
            // will see only real nodes and fall back to manual selection.
            return;
        }
        if (node.type === 'xray' || node.type === 'cdn') {
            generateVlessURIs(user, node, dedupeLabel).forEach(uri => uris.push(uri));
        } else {
            getNodeConfigs(node).forEach(cfg => {
                uris.push(generateURI(user, node, cfg, dedupeLabel));
            });
        }
    });
    return uris.join('\n');
}

function _buildClashVlessProxyForInbound(user, node, inbound, dedupeLabel = _passthroughLabel) {
    if (!_clashCanExpressInbound(inbound)) {
        logger.debug(`[Sub] Clash: skipped "${node.name}" inbound — XHTTP framing is not expressible in xhttp-opts`);
        return { name: '', proxy: null };
    }
    const host = inbound.address || node.domain || node.ip;
    const transport = inbound.transport || 'tcp';
    const security = inbound.security || 'reality';
    const fingerprint = inbound.fingerprint || 'chrome';
    const name = dedupeLabel(_xrayInboundName(node, inbound));

    let proxy = `  - name: ${_yamlString(name)}
    type: vless
    server: ${host}
    port: ${inbound.port || node.port || 443}
    uuid: "${user.xrayUuid}"
    udp: true`;

    if (security === 'reality') {
        const sni = inbound.realitySni && inbound.realitySni[0] ? inbound.realitySni[0] : host;
        proxy += `
    network: ${transport}
    tls: true
    reality-opts:
      public-key: "${inbound.realityPublicKey || ''}"
      short-id: "${(inbound.realityShortIds || ['']).find(id => id && id.length > 0) || ''}"
    servername: ${sni}
    client-fingerprint: ${fingerprint}`;
        if (transport === 'tcp' && inbound.flow) proxy += `\n    flow: ${inbound.flow}`;
    } else if (security === 'tls') {
        const tls = _resolveXrayTlsClientHints(node);
        proxy += `
    network: ${transport}
    tls: true
    servername: ${tls.sni || host}
    client-fingerprint: ${fingerprint}`;
        if (tls.allowInsecure) proxy += `\n    skip-cert-verify: true`;
        if (inbound.alpn && inbound.alpn.length > 0) {
            proxy += `\n    alpn:\n${inbound.alpn.map(a => `      - ${a}`).join('\n')}`;
        }
        if (transport === 'tcp' && inbound.flow) proxy += `\n    flow: ${inbound.flow}`;
    } else {
        proxy += `\n    network: ${transport}`;
    }

    const tlsHints = security === 'tls' ? _resolveXrayTlsClientHints(node) : null;

    if (transport === 'ws') {
        proxy += `
    ws-opts:
      path: ${_yamlString(inbound.wsPath || '/')}`;
        const wsHost = inbound.wsHost || (tlsHints ? tlsHints.host : '');
        if (wsHost) proxy += `\n      headers:\n        Host: ${_yamlString(wsHost)}`;
    } else if (transport === 'grpc') {
        proxy += `
    grpc-opts:
      grpc-service-name: ${_yamlString(inbound.grpcServiceName || 'grpc')}`;
    } else if (transport === 'xhttp') {
        // Mihomo (Clash Meta) reads xhttp-opts only since 1.19.22, and only when
        // `network: xhttp` is set as well (emitted by the reality/tls branches
        // above). Older builds ignore the block and fail to dial.
        proxy += `
    xhttp-opts:
      path: ${_yamlString(inbound.xhttpPath || '/')}
      mode: ${_yamlString(inbound.xhttpMode || 'auto')}`;
        const xhttpHost = inbound.xhttpHost || (tlsHints ? tlsHints.host : '');
        if (xhttpHost) proxy += `\n      host: ${_yamlString(xhttpHost)}`;

        const tuning = _xhttpTuning(inbound);
        // "0-0" disables padding for Xray but keeps mihomo from ever completing
        // the handshake (MetaCubeX/mihomo#3068), so it is simply not published.
        if (tuning.xPaddingBytes && !isAllZeroRange(tuning.xPaddingBytes)) {
            proxy += `\n      x-padding-bytes: ${_yamlString(tuning.xPaddingBytes)}`;
        }
        if (tuning.scMaxEachPostBytes) {
            proxy += `\n      sc-max-each-post-bytes: ${_yamlString(tuning.scMaxEachPostBytes)}`;
        }
        for (const [camel, , kebab] of XHTTP_CLIENT_TUNING_KEYS) {
            const value = tuning[camel];
            if (value === null || value === false || value === '') continue;
            proxy += `\n      ${kebab}: ${typeof value === 'boolean' ? value : _yamlString(String(value))}`;
        }
        if (tuning.noGrpcHeader) proxy += `\n      no-grpc-header: true`;
        if (tuning.xmux) {
            // XMUX under its mihomo name; the knobs themselves match Xray's.
            proxy += `\n      reuse-settings:`;
            if (tuning.xmux.maxConcurrency) {
                proxy += `\n        max-concurrency: ${_yamlString(tuning.xmux.maxConcurrency)}`;
            }
            if (tuning.xmux.hMaxRequestTimes) {
                proxy += `\n        h-max-request-times: ${_yamlString(tuning.xmux.hMaxRequestTimes)}`;
            }
            if (tuning.xmux.hMaxReusableSecs) {
                proxy += `\n        h-max-reusable-secs: ${_yamlString(tuning.xmux.hMaxReusableSecs)}`;
            }
        }
    }

    return { name, proxy };
}

/**
 * Build Clash proxies for every published inbound of an Xray node.
 * Returns an array of `{name, proxy}` items.
 */
function _buildClashVlessProxies(user, node, dedupeLabel = _passthroughLabel) {
    return getXrayPublishedInbounds(node)
        .map(inbound => _buildClashVlessProxyForInbound(user, node, inbound, dedupeLabel));
}

function generateClashYAML(user, nodes, routing) {
    const auth = `${user.userId}:${user.password}`;
    const proxies = [];
    const proxyNames = [];
    // Maps a HyNode _id (string) -> first proxy name produced for it. Used so
    // virtual nodes can reference their source nodes' Clash proxies by name.
    const nameByNodeId = new Map();
    const virtualSpecs = [];
    const dedupeLabel = _createLabelDeduplicator();

    nodes.forEach(node => {
        if (node.type === 'virtual') {
            virtualSpecs.push(node);
            return;
        }
        const beforeIdx = proxyNames.length;
        if (node.type === 'xray' || node.type === 'cdn') {
            if (!user.xrayUuid) return;
            _buildClashVlessProxies(user, node, dedupeLabel).forEach(({ name, proxy }) => {
                if (!proxy) return;
                proxyNames.push(name);
                proxies.push(proxy);
            });
        } else {
            getNodeConfigs(node).forEach(cfg => {
                const name = dedupeLabel(`${node.flag || ''} ${node.name} ${cfg.name}`.trim());
                proxyNames.push(name);

                let proxy = `  - name: ${_yamlString(name)}
    type: hysteria2
    server: ${cfg.host}
    port: ${cfg.port}
    password: ${_yamlString(auth)}
    sni: ${cfg.sni || cfg.host}
    skip-cert-verify: ${!cfg.hasCert}
    alpn:
      - h3`;

                if (cfg.portRange) proxy += `\n    ports: ${cfg.portRange}`;
                const hopIntervalSec = parseDurationSeconds(normalizeHopInterval(cfg.hopInterval));
                if (hopIntervalSec > 0) proxy += `\n    hop-interval: ${hopIntervalSec}`;
                if (cfg.obfs && cfg.obfsPassword) {
                    proxy += `\n    obfs: ${cfg.obfs}\n    obfs-password: ${_yamlString(cfg.obfsPassword)}`;
                }
                proxies.push(proxy);
            });
        }
        if (proxyNames.length > beforeIdx) {
            nameByNodeId.set(String(node._id), proxyNames.slice(beforeIdx));
        }
    });

    // Virtual nodes become Clash proxy-groups (url-test approximates leastPing/leastLoad).
    const virtualGroups = [];
    virtualSpecs.forEach(vnode => {
        const sourceNames = [];
        for (const src of vnode._resolvedSources || []) {
            const names = nameByNodeId.get(String(src._id));
            if (names) sourceNames.push(...names);
        }
        if (sourceNames.length === 0) return;
        const groupName = dedupeLabel(`${vnode.flag || ''} ${vnode.name}`.trim());
        const vcfg = vnode.virtual || {};
        const obs = vcfg.observatory || {};
        const url = obs.destination || 'http://www.gstatic.com/generate_204';
        const intervalSec = parseDurationSeconds(obs.interval || '1m') || 60;
        const groupType = vcfg.strategy === 'random' ? 'load-balance' : 'url-test';
        // Mihomo takes tolerance on url-test only; load-balance has no such knob,
        // and idle_timeout / interrupt_exist_connections do not exist there at all.
        const toleranceLine = (groupType === 'url-test' && Number.isFinite(vcfg.tolerance))
            ? `\n    tolerance: ${vcfg.tolerance}`
            : '';
        virtualGroups.push(
            `  - name: ${_yamlString(groupName)}\n    type: ${groupType}\n    url: ${url}\n    interval: ${intervalSec}${toleranceLine}\n    proxies:\n${sourceNames.map(n => `      - ${_yamlString(n)}`).join('\n')}`
        );
        // Surface the balancer at the top of the user-facing select group too.
        proxyNames.unshift(groupName);
    });

    let yaml = `proxies:\n${proxies.join('\n')}\n\nproxy-groups:\n  - name: "Proxy"\n    type: select\n    proxies:\n${proxyNames.map(n => `      - ${_yamlString(n)}`).join('\n')}\n`;
    if (virtualGroups.length > 0) {
        yaml += virtualGroups.join('\n') + '\n';
    }

    if (routing && routing.enabled && routing.rules && routing.rules.length > 0) {
        const clashDns = buildClashDns(routing.rules, routing.dns);
        const dnsLines = ['dns:', '  enable: true', '  ipv6: false'];
        dnsLines.push(`  default-nameserver:\n    - ${clashDns['default-nameserver'][0]}`);
        dnsLines.push(`  nameserver:\n    - ${clashDns.nameserver[0]}`);
        const policy = clashDns['nameserver-policy'];
        if (policy && Object.keys(policy).length > 0) {
            dnsLines.push('  nameserver-policy:');
            for (const [k, v] of Object.entries(policy)) {
                dnsLines.push(`    "${k}": "${v}"`);
            }
        }
        yaml += '\n' + dnsLines.join('\n') + '\n';

        const clashRules = buildClashRules(routing.rules);
        if (clashRules.length > 0) {
            yaml += '\nrules:\n';
            yaml += clashRules.map(r => `  - ${r}`).join('\n') + '\n';
            yaml += '  - MATCH,Proxy\n';
        }
    }

    return yaml;
}

function _buildSingboxVlessOutboundForInbound(user, node, inbound) {
    const host = inbound.address || node.domain || node.ip;
    const transport = inbound.transport || 'tcp';
    const security = inbound.security || 'reality';
    const fingerprint = inbound.fingerprint || 'chrome';
    const tag = _xrayInboundName(node, inbound);

    const outbound = {
        type: 'vless',
        tag,
        server: host,
        server_port: inbound.port || node.port || 443,
        uuid: user.xrayUuid,
    };

    if (transport === 'tcp' && (security === 'reality' || security === 'tls')) {
        outbound.flow = inbound.flow || 'xtls-rprx-vision';
    }

    if (security === 'reality') {
        outbound.tls = {
            enabled: true,
            server_name: inbound.realitySni && inbound.realitySni[0] ? inbound.realitySni[0] : host,
            utls: { enabled: true, fingerprint },
            reality: {
                enabled: true,
                public_key: inbound.realityPublicKey || '',
                short_id: (inbound.realityShortIds || ['']).find(id => id && id.length > 0) || '',
            },
        };
    } else if (security === 'tls') {
        const tls = _resolveXrayTlsClientHints(node);
        outbound.tls = {
            enabled: true,
            server_name: tls.sni || host,
            insecure: tls.allowInsecure,
            utls: { enabled: true, fingerprint },
        };
        if (inbound.alpn && inbound.alpn.length > 0) {
            outbound.tls.alpn = inbound.alpn;
        }
    }

    const tlsHints = security === 'tls' ? _resolveXrayTlsClientHints(node) : null;

    if (transport === 'ws') {
        const wsHost = inbound.wsHost || (tlsHints ? tlsHints.host : '');
        outbound.transport = {
            type: 'ws',
            path: inbound.wsPath || '/',
            headers: wsHost ? { Host: wsHost } : {},
        };
    } else if (transport === 'grpc') {
        outbound.transport = {
            type: 'grpc',
            service_name: inbound.grpcServiceName || 'grpc',
        };
    } else if (transport === 'xhttp') {
        // XHTTP is not in upstream sing-box — a config carrying it is rejected
        // whole. Emitted for forks that implement the transport (sing-box-lx,
        // Hiddify), which take these knobs in snake_case on the transport itself
        // rather than in an Xray-style `extra` object.
        outbound.transport = {
            type: 'xhttp',
            path: inbound.xhttpPath || '/',
            mode: inbound.xhttpMode || 'auto',
        };
        const xhttpHost = inbound.xhttpHost || (tlsHints ? tlsHints.host : '');
        if (xhttpHost) {
            outbound.transport.host = xhttpHost;
        }
        const tuning = _xhttpTuning(inbound);
        if (tuning.xPaddingBytes) outbound.transport.x_padding_bytes = tuning.xPaddingBytes;
        if (tuning.scMaxEachPostBytes) outbound.transport.sc_max_each_post_bytes = tuning.scMaxEachPostBytes;
        for (const [camel, snake] of XHTTP_CLIENT_TUNING_KEYS) {
            const value = tuning[camel];
            if (value === null || value === false || value === '') continue;
            outbound.transport[snake] = value;
        }
        if (tuning.noGrpcHeader) outbound.transport.no_grpc_header = true;
        if (tuning.xmux) {
            const xmux = {};
            if (tuning.xmux.maxConcurrency) xmux.max_concurrency = tuning.xmux.maxConcurrency;
            if (tuning.xmux.hMaxRequestTimes) xmux.h_max_request_times = tuning.xmux.hMaxRequestTimes;
            if (tuning.xmux.hMaxReusableSecs) xmux.h_max_reusable_secs = tuning.xmux.hMaxReusableSecs;
            outbound.transport.xmux = xmux;
        }
    }

    return { tag, outbound };
}

/**
 * Build sing-box outbounds for every published inbound of an Xray node.
 */
function _buildSingboxVlessOutbounds(user, node) {
    return getXrayPublishedInbounds(node)
        .map(inbound => _buildSingboxVlessOutboundForInbound(user, node, inbound));
}

/**
 * Generate full Xray-compatible JSON config for HAPP and v2rayNG clients.
 * Includes VLESS and Hysteria2 outbounds (if Xray-core supports it), routing rules and split DNS.
 */
/**
 * Build V2Ray/Xray outbounds for a single non-virtual node.
 * Returns [{ tag, displayName, outbound }, ...] — one entry per published
 * inbound (xray) or per port-config (hysteria). Used by both v2ray-json and
 * xray-json.
 *
 * `tagOverride(idx, baseTag)` — optional, lets callers force tag values
 * (e.g. `proxy`, `proxy-2`) for balancers. `displayName` always carries the
 * human-readable label regardless of override.
 */
function _buildV2rayOutboundsForNode(user, node, tagOverride, dedupeLabel = _passthroughLabel) {
    if (node.type === 'virtual') return [];
    const auth = `${user.userId}:${user.password}`;
    const built = [];

    if (node.type === 'xray' || node.type === 'cdn') {
        if (!user.xrayUuid) return [];
        getXrayPublishedInbounds(node).forEach((inbound, idx) => {
            const host = inbound.address || node.domain || node.ip;
            const transport = inbound.transport || 'tcp';
            const security = inbound.security || 'reality';
            const displayName = dedupeLabel(_xrayInboundName(node, inbound));
            const tag = tagOverride ? tagOverride(built.length, displayName) : displayName;

            const streamSettings = { network: transport };

            if (security === 'reality') {
                const sni = inbound.realitySni && inbound.realitySni[0] ? inbound.realitySni[0] : '';
                const shortIds = inbound.realityShortIds || [''];
                const sid = shortIds.find(id => id && id.length > 0) || shortIds[0] || '';
                streamSettings.security = 'reality';
                streamSettings.realitySettings = {
                    fingerprint: inbound.fingerprint || 'chrome',
                    serverName: sni,
                    publicKey: inbound.realityPublicKey || '',
                    shortId: sid,
                    spiderX: inbound.realitySpiderX || '',
                };
            } else if (security === 'tls') {
                const tls = _resolveXrayTlsClientHints(node);
                streamSettings.security = 'tls';
                streamSettings.tlsSettings = {
                    serverName: tls.sni || host,
                    fingerprint: inbound.fingerprint || 'chrome',
                    allowInsecure: tls.allowInsecure,
                };
                if (inbound.alpn && inbound.alpn.length > 0) {
                    streamSettings.tlsSettings.alpn = inbound.alpn;
                }
            }

            const tlsHints = security === 'tls' ? _resolveXrayTlsClientHints(node) : null;

            if (transport === 'ws') {
                const wsHost = inbound.wsHost || (tlsHints ? tlsHints.host : '');
                streamSettings.wsSettings = { path: inbound.wsPath || '/', headers: wsHost ? { Host: wsHost } : {} };
            } else if (transport === 'grpc') {
                streamSettings.grpcSettings = {
                    serviceName: inbound.grpcServiceName || 'grpc',
                    multiMode: false,
                };
                if (inbound.grpcAuthority) streamSettings.grpcSettings.authority = inbound.grpcAuthority;
            } else if (transport === 'xhttp') {
                streamSettings.xhttpSettings = {
                    path: inbound.xhttpPath || '/',
                    host: inbound.xhttpHost || (tlsHints ? tlsHints.host : ''),
                    mode: inbound.xhttpMode || 'auto',
                };
                // Everything past host/path/mode lives in `extra` in Xray, with
                // camelCase keys (see XTLS/Xray-core discussion #4113).
                const tuning = _xhttpTuning(inbound);
                const extra = {};
                if (tuning.xPaddingBytes) extra.xPaddingBytes = tuning.xPaddingBytes;
                if (tuning.scMaxEachPostBytes) extra.scMaxEachPostBytes = tuning.scMaxEachPostBytes;
                for (const [camel] of XHTTP_CLIENT_TUNING_KEYS) {
                    const value = tuning[camel];
                    if (value === null || value === false || value === '') continue;
                    extra[camel] = value;
                }
                if (tuning.noGrpcHeader) extra.noGRPCHeader = true;
                if (tuning.xmux) extra.xmux = tuning.xmux;
                _withXhttpSessionKeyCompat(extra);
                if (Object.keys(extra).length > 0) {
                    streamSettings.xhttpSettings.extra = extra;
                }
            }

            const vnextUser = { id: user.xrayUuid, encryption: 'none' };
            if (transport === 'tcp' && (security === 'reality' || security === 'tls') && inbound.flow) {
                vnextUser.flow = inbound.flow;
            }

            built.push({
                tag,
                displayName,
                outbound: {
                    tag,
                    protocol: 'vless',
                    settings: { vnext: [{ address: host, port: inbound.port || node.port || 443, users: [vnextUser] }] },
                    streamSettings,
                },
            });
        });
        return built;
    }

    getNodeConfigs(node).forEach(cfg => {
        const displayName = dedupeLabel(`${node.flag || ''} ${node.name} ${cfg.name}`.trim());
        const tag = tagOverride ? tagOverride(built.length, displayName) : displayName;
        const hysteriaSettings = { version: 2, auth };
        // Legacy udphop/udpmasks for old cores + finalmask for modern Xray-core.
        const finalmask = {};
        if (cfg.portRange) {
            const hopSec = parseDurationSeconds(normalizeHopInterval(cfg.hopInterval));
            hysteriaSettings.udphop = { port: cfg.portRange };
            if (hopSec > 0) hysteriaSettings.udphop.interval = hopSec;
            const udpHop = { ports: cfg.portRange };
            if (hopSec >= 5) udpHop.interval = hopSec;
            finalmask.quicParams = { udpHop };
        }

        const streamSettings = {
            network: 'hysteria',
            hysteriaSettings,
            security: 'tls',
            tlsSettings: {
                serverName: cfg.sni || cfg.host,
                allowInsecure: !cfg.hasCert,
                alpn: ['h3'],
            },
        };

        if (cfg.obfs && cfg.obfsPassword) {
            streamSettings.udpmasks = [{ type: cfg.obfs, settings: { password: cfg.obfsPassword } }];
            const maskSettings = { password: cfg.obfsPassword };
            if (cfg.obfs === 'gecko') maskSettings.packetSize = '512-1200';
            finalmask.udp = [{ type: 'salamander', settings: maskSettings }];
        }

        if (Object.keys(finalmask).length > 0) streamSettings.finalmask = finalmask;

        built.push({
            tag,
            displayName,
            outbound: {
                tag,
                protocol: 'hysteria',
                settings: { version: 2, address: cfg.host, port: cfg.port },
                streamSettings,
            },
        });
    });
    return built;
}

function generateV2rayJSON(user, nodes, routing) {
    const outbounds = [];
    const allTags = [];
    // Tags here are the display names, and Xray rejects a config with a repeated
    // outbound tag outright.
    const dedupeLabel = _createLabelDeduplicator();

    // Virtual nodes are skipped here — the single-config v2ray-json shape can't
    // express multiple balancers cleanly. Use ?format=xray-json for HAPP.
    nodes.forEach(node => {
        if (node.type === 'virtual') return;
        _buildV2rayOutboundsForNode(user, node, null, dedupeLabel).forEach(({ tag, outbound }) => {
            outbounds.push(outbound);
            allTags.push(tag);
        });
    });

    outbounds.push({ tag: 'direct', protocol: 'freedom',   settings: {} });
    outbounds.push({ tag: 'block',  protocol: 'blackhole',  settings: { response: { type: 'http' } } });

    // Routing rules
    const routingRules = [
        { type: 'field', port: '53', outboundTag: 'direct' },
    ];

    if (routing && routing.enabled && routing.rules && routing.rules.length > 0) {
        routingRules.push(...buildXrayRules(routing.rules));
    }

    // Final rule: all remaining traffic through first proxy
    // (This is implicit in Xray when we set the routing config tag for balancer/urltest — use first tag as default)
    const dnsServers = (routing && routing.enabled && routing.rules)
        ? buildXrayDns(routing.rules, routing.dns)
        : ['1.1.1.1', '8.8.8.8'];

    return {
        log: { loglevel: 'warning' },
        dns: { servers: dnsServers },
        inbounds: [
            {
                tag: 'socks-in',
                port: 10808,
                protocol: 'socks',
                settings: { auth: 'noauth', udp: true },
                sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
            },
            {
                tag: 'http-in',
                port: 10809,
                protocol: 'http',
                settings: {},
                sniffing: { enabled: true, destOverride: ['http', 'tls'] },
            },
        ],
        outbounds,
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: routingRules,
        },
    };
}

/**
 * Pick a HAPP-friendly remark for a node — flag prefix + name, trimmed.
 */
function _xrayProfileRemark(node) {
    return `${node.flag || ''} ${node.name || ''}`.trim() || node.name || 'profile';
}

/**
 * Build a minimal Xray profile (one or many proxy outbounds + direct/block,
 * SOCKS/HTTP inbounds, basic routing).
 *
 * `proxyOutbounds`  — pre-built outbound objects (already tagged).
 * `routing`         — optional routing rules to merge.
 * `extras`          — { balancers, observatory, burstObservatory, balancerRule }
 *                     used by virtual profiles to add a balancer + observatory.
 */
function _buildXrayProfile(remark, proxyOutbounds, routing, extras = {}) {
    const dnsServers = (routing && routing.enabled && routing.rules)
        ? buildXrayDns(routing.rules, routing.dns)
        : ['1.1.1.1', '8.8.8.8'];

    const outbounds = [
        ...proxyOutbounds,
        { tag: 'direct', protocol: 'freedom', settings: {} },
        { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } },
    ];

    const rules = [{ type: 'field', port: '53', outboundTag: 'direct' }];
    if (routing && routing.enabled && routing.rules && routing.rules.length > 0) {
        rules.push(...buildXrayRules(routing.rules));
    }
    if (extras.balancerRule) rules.push(extras.balancerRule);

    const profile = {
        remarks: remark,
        log: { loglevel: 'warning' },
        dns: { servers: dnsServers },
        inbounds: [
            {
                tag: 'socks-in',
                port: 10808,
                listen: '127.0.0.1',
                protocol: 'socks',
                settings: { auth: 'noauth', udp: true },
                sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
            },
            {
                tag: 'http-in',
                port: 10809,
                listen: '127.0.0.1',
                protocol: 'http',
                settings: {},
                sniffing: { enabled: true, destOverride: ['http', 'tls'] },
            },
        ],
        outbounds,
        routing: { domainStrategy: 'IPIfNonMatch', domainMatcher: 'hybrid', rules },
    };
    if (extras.balancers) profile.routing.balancers = extras.balancers;
    if (extras.observatory) profile.observatory = extras.observatory;
    if (extras.burstObservatory) profile.burstObservatory = extras.burstObservatory;
    return profile;
}

/**
 * Generate a Remnawave-style array of Xray profiles. Each real node becomes a
 * single-outbound profile; each virtual node becomes a multi-outbound profile
 * with a balancer + observatory configured per its strategy.
 *
 * Consumed by HAPP and any client that ingests Xray JSON profile arrays.
 */
function generateXrayJSON(user, nodes, routing) {
    const profiles = [];
    // Profile remarks are what the client lists as servers; duplicates would make
    // two entries indistinguishable. Outbound tags inside a profile stay local
    // (`proxy`, `proxy-2`, ...) and need no deduplication.
    const dedupeLabel = _createLabelDeduplicator();

    nodes.forEach(node => {
        if (node.type === 'virtual') {
            const sources = node._resolvedSources || [];
            if (sources.length === 0) return;

            const outbounds = [];
            const balancerSelector = ['proxy'];
            // Re-tag every outbound once it lands in the balancer pool. We can't
            // do this inside _buildV2rayOutboundsForNode's callback because a
            // single source node may yield multiple outbounds (xray with
            // multi-inbound) — the callback would see the same outbounds.length
            // for all of them and produce duplicate tags ("existing tag found:
            // proxy-N" XrayCore error). Xray's selector / subjectSelector both
            // do prefix matching, so "proxy", "proxy-2", "proxy-3" all match
            // selector ["proxy"], and fallbackTag="proxy" still resolves
            // unambiguously to the first outbound.
            sources.forEach((src) => {
                _buildV2rayOutboundsForNode(user, src).forEach(({ outbound }) => {
                    const ord = outbounds.length + 1;
                    const tag = ord === 1 ? 'proxy' : `proxy-${ord}`;
                    outbound.tag = tag;
                    outbounds.push(outbound);
                });
            });
            if (outbounds.length === 0) return;

            const cfg = node.virtual || {};
            const strategy = cfg.strategy || 'leastLoad';
            const obs = cfg.observatory || {};
            const balancer = {
                tag: 'balancer',
                selector: balancerSelector,
                strategy: { type: strategy },
            };
            if (cfg.fallbackToFirst !== false) balancer.fallbackTag = 'proxy';

            const extras = {
                balancers: [balancer],
                balancerRule: { type: 'field', network: 'tcp,udp', balancerTag: 'balancer' },
            };

            if (strategy === 'leastPing') {
                extras.observatory = {
                    subjectSelector: balancerSelector,
                    probeURL: obs.destination || 'http://www.gstatic.com/generate_204',
                    probeInterval: obs.interval || '1m',
                    enableConcurrency: true,
                };
            } else if (strategy === 'leastLoad') {
                const pingConfig = {
                    destination: obs.destination || 'http://www.gstatic.com/generate_204',
                    interval: obs.interval || '1m',
                    timeout: obs.timeout || '5s',
                    sampling: obs.sampling || 3,
                };
                if (obs.connectivity) pingConfig.connectivity = obs.connectivity;
                extras.burstObservatory = { subjectSelector: balancerSelector, pingConfig };
            }

            profiles.push(_buildXrayProfile(dedupeLabel(_xrayProfileRemark(node)), outbounds, routing, extras));
            return;
        }

        // Real node — one profile per published inbound (xray) or port-config (hysteria).
        // We keep one outbound per profile so HAPP shows them as distinct servers.
        _buildV2rayOutboundsForNode(user, node, () => 'proxy', dedupeLabel).forEach(({ outbound, displayName }) => {
            profiles.push(_buildXrayProfile(displayName, [outbound], routing, {
                balancerRule: { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' },
            }));
        });
    });

    return profiles;
}

function generateSingboxJSON(user, nodes, routing) {
    const auth = `${user.userId}:${user.password}`;
    const proxyOutbounds = [];
    const tags = [];
    // Per-node tag list — used by virtual nodes to reference their sources.
    const tagsByNodeId = new Map();
    const virtualSpecs = [];
    const dedupeLabel = _createLabelDeduplicator();

    nodes.forEach(node => {
        if (node.type === 'virtual') {
            virtualSpecs.push(node);
            return;
        }
        const beforeIdx = tags.length;
        if (node.type === 'xray' || node.type === 'cdn') {
            if (!user.xrayUuid) return;
            _buildSingboxVlessOutbounds(user, node).forEach(({ tag, outbound }) => {
                if (!outbound) return;
                const uniqueTag = dedupeLabel(tag);
                outbound.tag = uniqueTag;
                tags.push(uniqueTag);
                proxyOutbounds.push(outbound);
            });
        } else {
            getNodeConfigs(node).forEach(cfg => {
                const tag = dedupeLabel(`${node.flag || ''} ${node.name} ${cfg.name}`.trim());
                tags.push(tag);

                const outbound = {
                    type: 'hysteria2',
                    tag,
                    server: cfg.host,
                    password: auth,
                    tls: {
                        enabled: true,
                        server_name: cfg.sni || cfg.host,
                        insecure: !cfg.hasCert,
                        alpn: ['h3'],
                    },
                };

                if (cfg.portRange) {
                    outbound.server_ports = [cfg.portRange.replace('-', ':')];
                } else {
                    outbound.server_port = cfg.port;
                }

                const hopInterval = normalizeHopInterval(cfg.hopInterval);
                if (hopInterval) {
                    outbound.hop_interval = hopInterval;
                }

                if (cfg.obfs && cfg.obfsPassword) {
                    outbound.obfs = { type: cfg.obfs, password: cfg.obfsPassword };
                }

                proxyOutbounds.push(outbound);
            });
        }
        if (tags.length > beforeIdx) {
            tagsByNodeId.set(String(node._id), tags.slice(beforeIdx));
        }
    });

    // Virtual nodes → urltest outbounds. sing-box has no native leastLoad,
    // urltest is the closest equivalent (latency-based selection).
    const virtualOutbounds = [];
    const virtualTags = [];
    virtualSpecs.forEach(vnode => {
        const sourceTags = [];
        for (const src of vnode._resolvedSources || []) {
            const ts = tagsByNodeId.get(String(src._id));
            if (ts) sourceTags.push(...ts);
        }
        if (sourceTags.length === 0) return;
        const tag = dedupeLabel(`${vnode.flag || ''} ${vnode.name}`.trim());
        const vcfg = vnode.virtual || {};
        const obs = vcfg.observatory || {};
        const urltest = {
            type: 'urltest',
            tag,
            outbounds: sourceTags,
            url: obs.destination || 'https://www.gstatic.com/generate_204',
            interval: obs.interval || '1m',
            tolerance: Number.isFinite(vcfg.tolerance) ? vcfg.tolerance : 50,
            interrupt_exist_connections: vcfg.interruptExistConnections !== false,
        };
        const idleTimeout = (vcfg.idleTimeout || '').trim();
        if (idleTimeout) urltest.idle_timeout = idleTimeout;
        virtualOutbounds.push(urltest);
        virtualTags.push(tag);
    });

    // `auto` needs at least one member; an empty urltest is rejected by the core.
    const autoOutbounds = tags.length > 0
        ? [{
            type: 'urltest',
            tag: 'auto',
            outbounds: tags,
            url: 'https://www.gstatic.com/generate_204',
            interval: '3m',
            tolerance: 50,
            interrupt_exist_connections: true,
        }]
        : [];

    // Selectable list deliberately excludes `direct`: it stays as an outbound for
    // routing rules, but offering it in the picker lets a user disable the VPN by
    // accident. `auto` is included so the group it already builds is reachable.
    const allSelectableTags = [
        ...virtualTags,
        ...autoOutbounds.map(o => o.tag),
        ...tags,
    ];
    const outbounds = [
        {
            type: 'selector',
            tag: 'proxy',
            outbounds: allSelectableTags.length > 0 ? allSelectableTags : ['direct'],
            default: virtualTags[0] || allSelectableTags[0] || 'direct',
            interrupt_exist_connections: true,
        },
        ...autoOutbounds,
        ...virtualOutbounds,
        ...proxyOutbounds,
        { type: 'direct', tag: 'direct' },
    ];

    const allRuleSets = [];
    const hasRouting = routing && routing.enabled && routing.rules && routing.rules.length > 0;

    // Build sing-box DNS section (split DNS when routing enabled)
    let dnsSection;
    if (hasRouting) {
        const dnsResult = buildSingboxDns(routing.rules, routing.dns);
        dnsSection = { servers: dnsResult.servers, rules: dnsResult.rules, final: dnsResult.final };
        allRuleSets.push(...dnsResult.ruleSets);
    } else {
        dnsSection = {
            servers: [
                { type: 'tls', tag: 'dns-remote', server: '8.8.8.8', domain_resolver: 'dns-local', detour: 'proxy' },
                { type: 'udp', tag: 'dns-local', server: '223.5.5.5', detour: 'direct' },
            ],
            rules: [],
            final: 'dns-remote',
        };
    }

    // Build route.rules using 1.13+ action format
    const routeRules = [
        { protocol: 'dns', action: 'hijack-dns' },
        { inbound: 'tun-in', action: 'sniff' },
        { ip_is_private: true, action: 'route', outbound: 'direct' },
    ];
    if (hasRouting) {
        const routeResult = buildSingboxRules(routing.rules);
        routeRules.push(...routeResult.rules);
        allRuleSets.push(...routeResult.ruleSets);
    }

    // Deduplicate rule_set definitions by tag
    const uniqueRuleSets = [...new Map(allRuleSets.map(rs => [rs.tag, rs])).values()];

    const config = {
        log: { level: 'warn', timestamp: true },
        dns: dnsSection,
        inbounds: [
            {
                type: 'tun',
                tag: 'tun-in',
                address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
                mtu: 9000,
                auto_route: true,
                strict_route: true,
                stack: 'system',
            },
        ],
        outbounds,
        route: {
            rules: routeRules,
            final: 'proxy',
            auto_detect_interface: true,
            // Resolver for outbound server addresses (sing-box 1.12+). Must be a
            // plain direct server: resolving a node hostname through the tunnel
            // cannot work before the tunnel itself is up.
            default_domain_resolver: hasRouting ? 'dns-direct' : 'dns-local',
        },
        // Persists the user's selector choice across core restarts. Unrelated to
        // rule_set — keep it unconditional.
        experimental: { cache_file: { enabled: true } },
    };

    if (uniqueRuleSets.length > 0) {
        config.route.rule_set = uniqueRuleSets;
    }

    return config;
}

// ==================== HTML PAGE ====================

const SUBSCRIPTION_PAGE_TEXTS = {
    ru: {
        pageTitle: 'Подключение',
        personalConfig: 'Ваша персональная конфигурация',
        qrTitle: 'QR-КОД',
        qrHint: 'Отсканируйте для импорта подписки в приложение',
        appsTitle: 'ПРИЛОЖЕНИЯ',
        copied: 'Скопировано',
        done: 'Готово',
        gb: 'ГБ',
        tb: 'ТБ',
        mb: 'МБ',
        used: 'Использовано',
        locations: 'Локаций',
        validUntil: 'Действует до',
        appLinkTitle: 'ССЫЛКА ДЛЯ ПРИЛОЖЕНИЙ',
        copy: 'Копировать',
        serverLocations: 'ЛОКАЦИИ',
        unlimited: 'Бессрочно',
    },
    en: {
        pageTitle: 'Connection',
        personalConfig: 'Your personal configuration',
        qrTitle: 'QR CODE',
        qrHint: 'Scan to import the subscription into your app',
        appsTitle: 'APPS',
        copied: 'Copied',
        done: 'Done',
        gb: 'GB',
        tb: 'TB',
        mb: 'MB',
        used: 'Used',
        locations: 'Locations',
        validUntil: 'Valid until',
        appLinkTitle: 'APP SUBSCRIPTION LINK',
        copy: 'Copy',
        serverLocations: 'LOCATIONS',
        unlimited: 'Unlimited',
    },
    'zh-CN': {
        pageTitle: '连接配置',
        personalConfig: '你的个人订阅配置',
        qrTitle: '二维码',
        qrHint: '扫码将订阅导入客户端',
        appsTitle: '应用',
        copied: '已复制',
        done: '完成',
        gb: 'GB',
        tb: 'TB',
        mb: 'MB',
        used: '已用',
        locations: '地区',
        validUntil: '有效期至',
        appLinkTitle: '客户端订阅链接',
        copy: '复制',
        serverLocations: '节点地区',
        unlimited: '长期有效',
    },
};

function getSubscriptionPageText(lang) {
    const normalized = normalizeLanguage(lang) || 'ru';
    return {
        ...SUBSCRIPTION_PAGE_TEXTS.ru,
        ...(normalized !== 'ru' ? SUBSCRIPTION_PAGE_TEXTS.en : {}),
        ...(SUBSCRIPTION_PAGE_TEXTS[normalized] || {}),
        lang: normalized,
        dateLocale: getDateLocale(normalized),
    };
}

async function generateHTML(user, nodes, token, baseUrl, settings, lang = 'ru', opts = {}) {
    const text = getSubscriptionPageText(lang);
    // Soft-block mode: replace the link/locations/QR sections with a notice
    // banner; everything else (header, stats, buttons, styles) is reused.
    const softBlock = opts.softBlock || null;
    // Collect all configs
    const allConfigs = [];
    nodes.forEach(node => {
        // Virtual nodes are an abstraction over real sibling nodes — they have
        // no concrete URI to copy/scan, so we omit them from the HTML landing
        // page entirely. They still appear (always pinned to the top) inside
        // the actual subscription payloads served to clients via ?format=…
        if (node.type === 'virtual') return;
        if (node.type === 'xray' || node.type === 'cdn') {
            // Render one card per published inbound (main + extras).
            const inbounds = getXrayPublishedInbounds(node);
            inbounds.forEach(inbound => {
                const uri = generateVlessURIForInbound(user, node, inbound);
                if (uri) {
                    let location;
                    if (inbound.uniqueName && inbound.nameSuffix) {
                        location = inbound.nameSuffix;
                    } else if (inbound.nameSuffix) {
                        location = `${node.name} (${inbound.nameSuffix})`;
                    } else {
                        location = node.name;
                    }
                    allConfigs.push({
                        location,
                        flag: node.flag || '🌐',
                        name: 'VLESS',
                        uri,
                    });
                }
            });
        } else {
            getNodeConfigs(node).forEach(cfg => {
                allConfigs.push({
                    location: node.name,
                    flag: node.flag || '🌐',
                    name: cfg.name,
                    uri: generateURI(user, node, cfg),
                });
            });
        }
    });
    
    const trafficUsedBytes = (user.traffic?.tx || 0) + (user.traffic?.rx || 0);
    const trafficLimitBytes = user.trafficLimit || 0;
    const trafficUnits = { GB: text.gb, TB: text.tb, MB: text.mb };
    const trafficUsedLabel = formatTraffic(trafficUsedBytes, { decimals: 1, units: trafficUnits });
    const trafficLimitLabel = trafficLimitBytes > 0
        ? formatTraffic(trafficLimitBytes, { decimals: 0, units: trafficUnits })
        : '';
    const expireDate = user.expireAt ? new Date(user.expireAt).toLocaleDateString(text.dateLocale) : text.unlimited;
    
    // Group by location preserving node sort order (Map keeps insertion order for all key types)
    const locations = new Map();
    allConfigs.forEach(cfg => {
        if (!locations.has(cfg.location)) {
            locations.set(cfg.location, {
                flag: cfg.flag,
                configs: [],
            });
        }
        locations.get(cfg.location).configs.push({ name: cfg.name, uri: cfg.uri });
    });

    // Customization from settings
    const sub = settings?.subscription || {};
    const logoUrl   = sub.logoUrl   || '';
    const pageTitle = escapeHtml((softBlock && softBlock.title) || sub.pageTitle || text.pageTitle);
    const pageNoteHtml = sub.pageNote
        ? formatPageNoteHtml(sub.pageNote)
        : escapeHtml(text.personalConfig);

    const logoHtml = logoUrl
        ? `<img src="${logoUrl}" class="brand-logo" onerror="this.style.display='none'">`
        : '<i class="ti ti-rocket brand-icon"></i>';

    // QR code for subscription link (cached). White modules on PURE black background:
    // CSS mix-blend-mode: screen makes pure-black pixels (#000000) fully transparent,
    // so the QR seamlessly blends into any surface. Cache key carries a style
    // version (`v3`) so legacy QRs with the old `#141414` background are regenerated.
    const QR_CACHE_KEY = `v3:${baseUrl}`;
    // Soft-block pages never render the QR section, so skip the work entirely.
    let qrDataUrl = softBlock ? null : await cache.getQR(QR_CACHE_KEY);
    if (!softBlock && !qrDataUrl) {
        try {
            qrDataUrl = await QRCode.toDataURL(baseUrl, {
                width: 240,
                margin: 1,
                color: { dark: '#ffffff', light: '#000000' },
            });
            await cache.setQR(QR_CACHE_KEY, qrDataUrl);
        } catch (e) {
            logger.warn(`[Sub] QR generation failed: ${e.message}`);
        }
    }

    const qrSectionHtml = qrDataUrl
        ? `<div class="section section-center qr-section">
            <h2><i class="ti ti-qrcode"></i> ${text.qrTitle}</h2>
            <img src="${qrDataUrl}" alt="QR" class="qr-image">
            <div class="qr-hint">${text.qrHint}</div>
           </div>`
        : '';

    function escAttr(s) {
        return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function resolveButtonUrl(rawUrl, subUrl) {
        if (!rawUrl) return null;
        const b64 = Buffer.from(subUrl).toString('base64');
        const resolved = rawUrl
            .replace(/\{url_encoded\}/g, encodeURIComponent(subUrl))
            .replace(/\{url_b64\}/g, b64)
            .replace(/\{url\}/g, subUrl);
        if (/^javascript:/i.test(resolved)) return null;
        return resolved;
    }

    const buttons = (sub.buttons || []).filter(b => b.label && b.url);
    const buttonsHtml = buttons.length > 0
        ? `<div class="section section-buttons">
            <h2><i class="ti ti-apps"></i> ${text.appsTitle}</h2>
            <div class="btn-grid">
                ${buttons.map(b => {
                    const href = resolveButtonUrl(b.url, baseUrl);
                    if (!href) return '';
                    const iconClass = (b.icon || '').trim().replace(/[^a-zA-Z0-9-]/g, '') || 'ti-external-link';
                    const safeLabel = escAttr(b.label);
                    return `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer" class="app-btn">
                        <i class="ti ${iconClass}"></i>
                        <span>${safeLabel}</span>
                    </a>`;
                }).filter(Boolean).join('')}
            </div>
           </div>`
        : '';

    // Soft-block notice: announce banner + one row per remark line (deduped
    // against the banner text). Replaces the link/locations/QR sections.
    const noticeRows = softBlock
        ? (softBlock.lines || []).filter(l => l && l !== softBlock.announce)
        : [];
    const noticeHtml = softBlock
        ? `<div class="section">
            <div style="text-align:center; padding:6px 4px 2px;">
                <div style="font-size:34px; color:var(--accent); margin-bottom:10px;"><i class="ti ti-alert-triangle"></i></div>
                <div style="font-size:16px; font-weight:600; line-height:1.5;">${escAttr(softBlock.announce || '')}</div>
            </div>
            ${noticeRows.length ? `<div style="margin-top:14px; display:flex; flex-direction:column; gap:8px;">
                ${noticeRows.map(l => `<div style="padding:12px 14px; background:var(--glass-bg); border:1px solid var(--glass-border); border-radius:var(--radius-sm); text-align:center; color:var(--text-muted);">${escAttr(l)}</div>`).join('')}
            </div>` : ''}
           </div>`
        : '';

    const locationsCount = softBlock ? (softBlock.lines || []).length : locations.size;

    return `<!DOCTYPE html>
<html lang="${text.lang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="theme-color" content="#0a0a0c">
    ${logoUrl ? `<link rel="icon" href="${logoUrl}">` : ''}
    <title>${pageTitle}</title>
    <style>
        :root {
            --bg-base: #0a0a0c;
            --text: #f4f4f5;
            --text-muted: #a1a1aa;
            --text-dim: #71717a;
            --accent: #6366f1;
            --accent-2: #7c3aed;
            --success: #22c55e;
            --glass-bg: rgba(24, 24, 27, 0.62);
            --glass-bg-strong: rgba(24, 24, 27, 0.78);
            --glass-border: rgba(255, 255, 255, 0.08);
            --glass-border-strong: rgba(255, 255, 255, 0.14);
            --glass-blur: saturate(180%) blur(22px);
            --glass-blur-sm: saturate(160%) blur(14px);
            --glass-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 8px 24px -12px rgba(0, 0, 0, 0.55);
            --glass-shadow-lg: 0 1px 0 rgba(255, 255, 255, 0.06) inset, 0 28px 64px -24px rgba(0, 0, 0, 0.7);
            --radius: 16px;
            --radius-sm: 10px;
            --radius-xs: 6px;
            --transition: 0.25s cubic-bezier(0.22, 1, 0.36, 1);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, sans-serif;
            background: var(--bg-base);
            background-image:
                radial-gradient(1200px 760px at 8% -12%, rgba(99, 102, 241, 0.32), transparent 60%),
                radial-gradient(1000px 680px at 112% 6%, rgba(168, 85, 247, 0.26), transparent 55%),
                radial-gradient(820px 580px at 50% 110%, rgba(34, 197, 94, 0.10), transparent 60%);
            background-attachment: fixed;
            color: var(--text);
            min-height: 100vh;
            padding: 22px 14px calc(34px + env(safe-area-inset-bottom));
            line-height: 1.5;
        }
        .container { max-width: 600px; margin: 0 auto; }

        /* === Animations === */
        @keyframes rise {
            from { opacity: 0; transform: translateY(12px); }
            to   { opacity: 1; transform: translateY(0); }
        }
        .container > * { animation: rise 0.5s var(--transition) both; }
        .container > *:nth-child(1) { animation-delay: 0ms; }
        .container > *:nth-child(2) { animation-delay: 60ms; }
        .container > *:nth-child(3) { animation-delay: 120ms; }
        .container > *:nth-child(4) { animation-delay: 180ms; }
        .container > *:nth-child(5) { animation-delay: 240ms; }
        .container > *:nth-child(6) { animation-delay: 300ms; }

        /* === Header === */
        .header {
            position: relative;
            text-align: center;
            padding: 38px 20px 32px;
            background: var(--glass-bg-strong);
            border: 1px solid var(--glass-border-strong);
            border-radius: var(--radius);
            margin-bottom: 14px;
            backdrop-filter: var(--glass-blur);
            -webkit-backdrop-filter: var(--glass-blur);
            box-shadow: var(--glass-shadow-lg);
            overflow: hidden;
        }
        .header::before {
            content: '';
            position: absolute;
            inset: 0;
            background:
                radial-gradient(560px 280px at 50% -30%, rgba(99, 102, 241, 0.45), transparent 70%),
                radial-gradient(360px 200px at 100% 100%, rgba(168, 85, 247, 0.22), transparent 70%);
            pointer-events: none;
        }
        .header h1 {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 14px;
            font-size: 26px;
            font-weight: 700;
            letter-spacing: -0.015em;
            margin-bottom: 6px;
        }
        .header p {
            position: relative;
            color: var(--text-muted);
            font-size: 13.5px;
        }
        .brand-logo {
            height: 44px;
            width: auto;
            border-radius: var(--radius-sm);
            object-fit: contain;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        }
        .brand-icon {
            font-size: 28px;
            color: #fff;
            background: linear-gradient(135deg, var(--accent), var(--accent-2));
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        /* === Stats === */
        .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
        .stat {
            position: relative;
            background: var(--glass-bg);
            border: 1px solid var(--glass-border);
            border-radius: var(--radius);
            padding: 14px 10px;
            text-align: center;
            backdrop-filter: var(--glass-blur-sm);
            -webkit-backdrop-filter: var(--glass-blur-sm);
            box-shadow: var(--glass-shadow);
            overflow: hidden;
            transition: transform var(--transition), border-color var(--transition);
        }
        .stat::before {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 40%);
            pointer-events: none;
        }
        .stat:hover { transform: translateY(-2px); border-color: var(--glass-border-strong); }
        .stat-value {
            font-size: 17px;
            font-weight: 700;
            background: linear-gradient(135deg, #a5b4fc, #c4b5fd);
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: -0.01em;
        }
        .stat-label {
            font-size: 10.5px;
            color: var(--text-muted);
            margin-top: 4px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }

        /* === Sections === */
        .section {
            background: var(--glass-bg);
            border: 1px solid var(--glass-border);
            border-radius: var(--radius);
            padding: 16px 18px;
            margin-bottom: 12px;
            backdrop-filter: var(--glass-blur);
            -webkit-backdrop-filter: var(--glass-blur);
            box-shadow: var(--glass-shadow);
        }
        .section h2 {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--text-muted);
            margin-bottom: 14px;
        }
        .section h2 i { font-size: 14px; color: var(--accent); }
        .section-center { text-align: center; }
        .section-center h2 { justify-content: center; }

        /* === Subscription URL === */
        .sub-box {
            display: flex;
            gap: 8px;
            align-items: stretch;
        }
        .sub-box input {
            flex: 1;
            min-width: 0;
            padding: 11px 14px;
            background: rgba(0, 0, 0, 0.32);
            border: 1px solid var(--glass-border);
            border-radius: var(--radius-sm);
            color: var(--text);
            font-size: 12.5px;
            font-family: 'SF Mono', ui-monospace, Menlo, monospace;
            transition: border-color var(--transition), background var(--transition);
        }
        .sub-box input:focus {
            outline: none;
            border-color: var(--accent);
            background: rgba(99, 102, 241, 0.08);
        }

        /* === Buttons === */
        .copy-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 9px 14px;
            background: linear-gradient(135deg, var(--accent), var(--accent-2));
            border: none;
            border-radius: var(--radius-sm);
            color: #fff;
            font-size: 12.5px;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
            white-space: nowrap;
            box-shadow: 0 4px 14px -2px rgba(99, 102, 241, 0.4);
            transition: transform 0.15s ease, box-shadow var(--transition), background var(--transition);
        }
        .copy-btn i { font-size: 14px; }
        .copy-btn:hover { box-shadow: 0 6px 20px -4px rgba(99, 102, 241, 0.55); }
        .copy-btn:active { transform: scale(0.96); }
        .copy-btn.success {
            background: linear-gradient(135deg, #22c55e, #16a34a);
            box-shadow: 0 4px 14px -2px rgba(34, 197, 94, 0.4);
        }

        /* Subtle copy button for inner config rows */
        .config .copy-btn {
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid var(--glass-border);
            color: var(--text);
            box-shadow: none;
            padding: 7px 12px;
        }
        .config .copy-btn:hover {
            background: rgba(99, 102, 241, 0.16);
            border-color: rgba(99, 102, 241, 0.4);
        }
        .config .copy-btn.success {
            background: linear-gradient(135deg, #22c55e, #16a34a);
            border-color: transparent;
            color: #fff;
        }

        /* === Locations === */
        .location {
            border: 1px solid var(--glass-border);
            border-radius: var(--radius-sm);
            margin-bottom: 8px;
            overflow: hidden;
            background: rgba(255, 255, 255, 0.025);
            transition: border-color var(--transition), background var(--transition);
        }
        .location:last-child { margin-bottom: 0; }
        .location:hover { border-color: var(--glass-border-strong); }
        .location.open {
            border-color: rgba(99, 102, 241, 0.35);
            background: rgba(99, 102, 241, 0.04);
        }
        .location-header {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 14px;
            cursor: pointer;
            user-select: none;
            -webkit-tap-highlight-color: transparent;
        }
        .location-flag { font-size: 22px; line-height: 1; flex-shrink: 0; }
        .location-name { flex: 1; font-weight: 500; font-size: 14.5px; }
        .location-count {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 22px;
            height: 22px;
            padding: 0 7px;
            font-size: 11px;
            font-weight: 600;
            color: var(--text-muted);
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid var(--glass-border);
            border-radius: 999px;
        }
        .location.open .location-count {
            color: #c4b5fd;
            background: rgba(99, 102, 241, 0.16);
            border-color: rgba(99, 102, 241, 0.3);
        }
        .location-arrow {
            color: var(--text-dim);
            display: inline-flex;
            transition: transform var(--transition), color var(--transition);
        }
        .location.open .location-arrow { transform: rotate(180deg); color: var(--accent); }
        /* Grid 0fr → 1fr trick: animates to actual content height, no jank */
        .location-configs {
            display: grid;
            grid-template-rows: 0fr;
            transition: grid-template-rows 0.32s var(--transition);
        }
        .location.open .location-configs { grid-template-rows: 1fr; }
        .location-configs-inner {
            min-height: 0;
            overflow: hidden;
            border-top: 1px solid transparent;
            transition: border-color 0.32s var(--transition);
        }
        .location.open .location-configs-inner {
            border-top-color: var(--glass-border);
        }
        .config {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            padding: 9px 14px;
        }
        .config-name {
            font-size: 13px;
            color: var(--text);
            font-family: 'SF Mono', ui-monospace, Menlo, monospace;
        }

        /* === QR — clean, no extra frame.
           mix-blend-mode: screen makes the dark QR background blend into the glass
           card seamlessly while keeping white modules crisp and high-contrast. === */
        .qr-image {
            display: block;
            width: 200px;
            height: 200px;
            margin: 4px auto 12px;
            mix-blend-mode: screen;
            transition: transform var(--transition);
        }
        .qr-image:hover { transform: scale(1.04); }
        .qr-hint { font-size: 12px; color: var(--text-muted); }

        /* === App buttons grid === */
        .btn-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
        .app-btn {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 14px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--glass-border);
            border-radius: var(--radius-sm);
            color: var(--text);
            text-decoration: none;
            font-size: 13.5px;
            font-weight: 500;
            transition: transform 0.15s ease, background var(--transition), border-color var(--transition);
        }
        .app-btn i {
            font-size: 18px;
            color: var(--accent);
            flex-shrink: 0;
        }
        .app-btn:hover {
            background: rgba(99, 102, 241, 0.08);
            border-color: rgba(99, 102, 241, 0.4);
        }
        .app-btn:active { transform: scale(0.98); }

        /* === Toast === */
        .toast {
            position: fixed;
            bottom: calc(20px + env(safe-area-inset-bottom));
            left: 50%;
            transform: translateX(-50%) translateY(120%);
            background: var(--glass-bg-strong);
            border: 1px solid rgba(34, 197, 94, 0.4);
            color: #4ade80;
            padding: 11px 18px;
            border-radius: 999px;
            font-size: 13.5px;
            font-weight: 600;
            transition: transform 0.35s var(--transition), opacity 0.35s var(--transition);
            display: flex;
            align-items: center;
            gap: 8px;
            backdrop-filter: var(--glass-blur);
            -webkit-backdrop-filter: var(--glass-blur);
            box-shadow: var(--glass-shadow-lg);
            opacity: 0;
            pointer-events: none;
            z-index: 9999;
        }
        .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
        .toast i { font-size: 16px; }

        @media (max-width: 380px) {
            .btn-grid { grid-template-columns: 1fr; }
            .stat-value { font-size: 15px; }
            .header h1 { font-size: 21px; }
        }

        @media (prefers-reduced-motion: reduce) {
            .container > * { animation: none; }
            .location-configs { transition: none; }
        }
    </style>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${logoHtml} <span>${pageTitle}</span></h1>
            ${softBlock ? '' : `<p>${pageNoteHtml}</p>`}
        </div>

        ${softBlock ? '' : `<div class="stats">
            <div class="stat">
                <div class="stat-value">${trafficUsedLabel}</div>
                <div class="stat-label">${text.used}${trafficLimitLabel ? ` / ${trafficLimitLabel}` : ''}</div>
            </div>
            <div class="stat">
                <div class="stat-value">${locationsCount}</div>
                <div class="stat-label">${text.locations}</div>
            </div>
            <div class="stat">
                <div class="stat-value">${expireDate}</div>
                <div class="stat-label">${text.validUntil}</div>
            </div>
        </div>`}

        ${softBlock ? noticeHtml : `<div class="section">
            <h2><i class="ti ti-link"></i> ${text.appLinkTitle}</h2>
            <div class="sub-box">
                <input type="text" value="${baseUrl}" readonly id="subUrl">
                <button class="copy-btn" onclick="copyText('${baseUrl}', this)"><i class="ti ti-copy"></i> ${text.copy}</button>
            </div>
        </div>

        <div class="section">
            <h2><i class="ti ti-world"></i> ${text.serverLocations}</h2>
            ${[...locations.entries()].map(([name, loc]) => `
            <div class="location">
                <div class="location-header" onclick="this.parentElement.classList.toggle('open')">
                    <span class="location-flag">${loc.flag}</span>
                    <span class="location-name">${name}</span>
                    <span class="location-count">${loc.configs.length}</span>
                    <span class="location-arrow"><i class="ti ti-chevron-down"></i></span>
                </div>
                <div class="location-configs">
                    <div class="location-configs-inner">
                        ${loc.configs.map(cfg => `
                        <div class="config">
                            <span class="config-name">${cfg.name}</span>
                            <button class="copy-btn" onclick="copyUri(this)"><i class="ti ti-copy"></i> ${text.copy}</button>
                        </div>
                        `).join('')}
                    </div>
                </div>
            </div>
            `).join('')}
        </div>

        ${qrSectionHtml}`}
        ${buttonsHtml}
    </div>

    <div class="toast" id="toast"><i class="ti ti-check"></i> ${text.copied}</div>

    <script>
        const uris = ${JSON.stringify(allConfigs.map(c => c.uri))};

        function copyText(text, btn) { doCopy(text, btn); }

        function copyUri(btn) {
            const allBtns = document.querySelectorAll('.location-configs .copy-btn');
            let idx = 0;
            for (let i = 0; i < allBtns.length; i++) {
                if (allBtns[i] === btn) { idx = i; break; }
            }
            doCopy(uris[idx], btn);
        }

        function doCopy(text, btn) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => success(btn)).catch(() => fallback(text, btn));
            } else {
                fallback(text, btn);
            }
        }

        function fallback(text, btn) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); success(btn); } catch(e) {}
            document.body.removeChild(ta);
        }

        function success(btn) {
            const orig = btn.innerHTML;
            btn.innerHTML = '<i class="ti ti-check"></i> ${text.done}';
            btn.classList.add('success');
            const toast = document.getElementById('toast');
            toast.classList.add('show');
            setTimeout(() => {
                btn.innerHTML = orig;
                btn.classList.remove('success');
                toast.classList.remove('show');
            }, 1600);
        }
    </script>
</body>
</html>`;
}

// ==================== HWID (subscription fetch) ====================

// Default remark texts when the admin has not configured them in settings.
// Kept short so they fit the 200-char limit even after sanitation.
const HWID_DEFAULT_REMARK_NOT_SUPPORTED = 'Update to HAPP — your client does not support HWID';
const HWID_DEFAULT_REMARK_MAX_DEVICES   = 'Device limit reached — remove unused devices in panel';

// Static base64 of "aes-256-gcm:x" used in the synthetic ss:// URI below.
// Pre-computed to avoid a Buffer.from() call on every blocked request.
const HWID_FAKE_SS_USERINFO_B64 = 'YWVzLTI1Ni1nY206eA==';

// Soft-block hard limits. Bound the loop and payload size for any caller.
// Per-line length is intentionally short: client UIs truncate long server
// names (HAPP, Hiddify, Clash). 32 chars fit comfortably on a phone screen.
const HWID_FAKE_MAX_LINES     = 12;
const HWID_FAKE_MAX_LINE_LEN  = 32;

/**
 * Split admin-entered remark text into individual lines, one per fake server.
 * Empty lines are dropped, each line is trimmed and length-capped, and the
 * result is deduplicated and truncated to HWID_FAKE_MAX_LINES.
 * @param {string} remark Multiline admin text.
 * @param {string} fallback Default line used when remark is empty.
 * @returns {string[]} Non-empty list of safe single-line strings.
 */
function parseRemarkLines(remark, fallback) {
    const raw = String(remark || '').replace(/\r\n?/g, '\n');
    const seen = new Set();
    const out = [];
    for (const part of raw.split('\n')) {
        const line = part.trim().slice(0, HWID_FAKE_MAX_LINE_LEN);
        if (!line || seen.has(line)) continue;
        seen.add(line);
        out.push(line);
        if (out.length >= HWID_FAKE_MAX_LINES) break;
    }
    if (out.length === 0) out.push(String(fallback || HWID_DEFAULT_REMARK_NOT_SUPPORTED).slice(0, HWID_FAKE_MAX_LINE_LEN));
    return out;
}

/**
 * Build a multi-server "subscription" body where each fake server carries one
 * line of the admin message as its name. Servers point at 127.0.0.0/8 with
 * different last octets so they appear as distinct entries in every client.
 * Names are deduplicated by parseRemarkLines, so YAML/JSON tag uniqueness
 * (required by Clash and sing-box) is preserved.
 * @param {string} format Detected subscription format.
 * @param {string[]} lines Non-empty list of safe single-line names.
 * @returns {string} Encoded body matching the requested format.
 */
function generateFakeSubscriptionContent(format, lines) {
    // Each fake server gets a unique loopback address so duplicate names are
    // impossible to produce server-key collisions in Clash even if the admin
    // somehow bypasses dedupe.
    const fakeServers = lines.map((name, i) => ({
        name,
        host: `127.0.0.${(i % 254) + 1}`,
    }));

    switch (format) {
        case 'shadowrocket': {
            const uris = fakeServers.map(s =>
                `ss://${HWID_FAKE_SS_USERINFO_B64}@${s.host}:1#${encodeURIComponent(s.name)}`
            );
            return Buffer.from(uris.join('\n'), 'utf8').toString('base64');
        }
        case 'clash':
        case 'yaml': {
            const proxies = fakeServers.map(s => {
                const yamlName = s.name.replace(/"/g, '\\"');
                return `  - { name: "${yamlName}", type: ss, server: ${s.host}, port: 1, cipher: aes-256-gcm, password: x }`;
            });
            const proxyNames = fakeServers.map(s => `"${s.name.replace(/"/g, '\\"')}"`).join(', ');
            return [
                'proxies:',
                ...proxies,
                'proxy-groups:',
                `  - { name: "PROXY", type: select, proxies: [${proxyNames}] }`,
                'rules:',
                '  - MATCH,PROXY',
            ].join('\n');
        }
        case 'singbox':
        case 'json':
            return JSON.stringify({
                outbounds: fakeServers.map(s => ({
                    type: 'shadowsocks',
                    tag: s.name,
                    server: s.host,
                    server_port: 1,
                    method: 'aes-256-gcm',
                    password: 'x',
                })),
                route: { final: fakeServers[0].name },
            }, null, 2);
        case 'v2ray-json':
            return JSON.stringify({
                outbounds: fakeServers.map(s => ({
                    tag: s.name,
                    protocol: 'shadowsocks',
                    settings: { servers: [{ address: s.host, port: 1, method: 'aes-256-gcm', password: 'x' }] },
                })),
            }, null, 2);
        case 'uri':
        case 'raw':
        default:
            return fakeServers
                .map(s => `ss://${HWID_FAKE_SS_USERINFO_B64}@${s.host}:1#${encodeURIComponent(s.name)}`)
                .join('\n');
    }
}

/**
 * Encode a HAPP `announce` header value. Multi-line and non-ASCII text MUST
 * be base64-encoded — raw \n is not allowed in HTTP headers and HAPP refuses
 * non-base64 non-ASCII payloads.
 * @param {string} text Already-trimmed announce text.
 * @returns {string} HAPP-compatible header value (raw or "base64:...").
 */
function encodeAnnounceHeader(text) {
    const isAsciiSingleLine = /^[\x20-\x7E]+$/.test(text);
    return isAsciiSingleLine
        ? text
        : `base64:${Buffer.from(text, 'utf8').toString('base64')}`;
}

/**
 * Send a soft-block response: a structurally valid subscription whose servers
 * carry the admin-configured remark text (one fake server per non-empty line).
 * The response is never cached (per-request decision) and reuses the regular
 * sender so all common headers (profile title, traffic, support-url, HAPP
 * routing, etc.) stay consistent with normal subscriptions.
 *
 * @param {string} remark Multiline admin text (or default fallback).
 * @param {string} fallback Default line used when remark is empty.
 * @param {string} [titleOverride] Optional Profile-Title override (empty = normal title).
 */
function sendFakeSubscription(res, user, format, userAgent, settings, remark, fallback, extraHeaders, titleOverride) {
    const lines = parseRemarkLines(remark, fallback);
    const data = {
        content: generateFakeSubscriptionContent(format, lines),
        profileTitle: (titleOverride || '').trim() || getSubscriptionTitle(user),
        username: user.username || user.userId,
        traffic: { tx: user.traffic?.tx || 0, rx: user.traffic?.rx || 0 },
        trafficLimit: user.trafficLimit || 0,
        expireAt: user.expireAt,
    };
    res.set('Cache-Control', 'no-store');
    sendCachedSubscription(res, data, format, userAgent, settings, extraHeaders);
}

// Default fake-location names per invalid reason, used only when the admin
// left the remark empty. validateUser() error string -> default text.
const SOFTBLOCK_DEFAULTS = {
    Expired: 'Subscription expired',
    Inactive: 'Subscription disabled',
    'Traffic exceeded': 'Traffic limit reached',
};
// validateUser() error string -> settings.subscription.softBlock key.
const SOFTBLOCK_REASON_KEY = {
    Expired: 'expired',
    Inactive: 'disabled',
    'Traffic exceeded': 'trafficExceeded',
};

/**
 * Decide what an invalid subscription receives. When soft-block is disabled,
 * keep the legacy plain-text 403. When enabled, browsers get a styled HTML
 * page with a banner; apps get a fake-location subscription (Happ also gets an
 * in-app popup via the `announce` header). Self-contained: loads settings and
 * detects format/browser itself so both subscription routes can reuse it.
 *
 * @param {object} validation Result of validateUser() ({ valid, error }).
 * @param {{ cacheToken?: string, baseUrl?: string }} [ctx] For the HTML page.
 */
async function rejectOrSoftBlock(req, res, user, validation, ctx = {}) {
    const settings = await getSettings();
    const sb = settings?.subscription?.softBlock;
    const key = SOFTBLOCK_REASON_KEY[validation.error];
    if (!sb?.enabled || !key) {
        return res.status(403).type('text/plain').send(`# ${validation.error}`);
    }

    const cfg = sb[key] || {};
    const fallback = SOFTBLOCK_DEFAULTS[validation.error];
    const lines = parseRemarkLines(cfg.remark, fallback);
    const announce = (cfg.announce || '').trim() || lines[0];
    const title = (cfg.title || '').trim();
    const userAgent = req.headers['user-agent'] || '';

    // Browser without ?format -> render the same styled HTML page with a banner.
    if (isBrowser(req) && !req.query.format) {
        const html = await generateHTML(user, [], ctx.cacheToken, ctx.baseUrl || '',
            settings, res.locals.lang, { softBlock: { announce, lines, title } });
        return res
            .type('text/html')
            .set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            .send(html);
    }

    const format = req.query.format || detectFormat(userAgent);
    const extraHeaders = {};
    if (/happ/i.test(userAgent) && announce) {
        extraHeaders['announce'] = encodeAnnounceHeader(announce);
    }
    return sendFakeSubscription(res, user, format, userAgent, settings,
        cfg.remark, fallback, extraHeaders, title);
}

/**
 * Enforce HWID device policy before returning subscription payload.
 *
 * Modes (configured in panel → HAPP integration → HWID):
 * - off:        no enforcement, no HWID tracking. Device counting still
 *               happens at Hysteria connection time by unique client IP.
 * - permissive: clients sending x-hwid are tracked and capped here. Clients
 *               without x-hwid receive the regular subscription; their
 *               devices are counted by unique IP at connection time only.
 * - strict:     same as permissive, but clients without x-hwid receive a
 *               soft-block subscription (one fake server with the admin
 *               remark) instead of real configs.
 *
 * In all modes, when a client sending x-hwid exceeds the limit, it gets the
 * same soft-block response with the limit-reached remark; HAPP also receives
 * an in-app popup via the `announce` header.
 *
 * @returns {Promise<{ extraHeaders: Record<string, string>, aborted: boolean }>}
 */
async function runHwidSubscriptionGate(req, res, user, settings, format) {
    const mode = hwidDeviceService.resolveMode(user, settings);
    const limit = hwidDeviceService.effectiveDeviceLimit(user);
    const extra = {};

    if (mode === 'off' || limit === 0) {
        return { extraHeaders: extra, aborted: false };
    }
    if (limit < 0) {
        return { extraHeaders: extra, aborted: false };
    }

    extra['x-hwid-active'] = 'true';
    extra['x-hwid-limit'] = 'true';

    const userAgent = req.headers['user-agent'] || '';
    const hwidCfg = settings?.subscription?.happ?.hwid || {};
    const isHapp = /happ/i.test(userAgent);

    const h = extractHwidHeaders(req);
    if (!h) {
        if (mode === 'strict') {
            const oh = { ...extra, 'x-hwid-not-supported': 'true' };
            // For HAPP, fall back to the remark text if no popup text is configured.
            // HAPP almost never hits this branch (it always sends x-hwid), but custom
            // builds without HWID support exist and benefit from a popup.
            if (isHapp) {
                const popup = (hwidCfg.notSupportedRemark || '').trim()
                    || HWID_DEFAULT_REMARK_NOT_SUPPORTED;
                oh['announce'] = encodeAnnounceHeader(popup);
            }
            sendFakeSubscription(res, user, format, userAgent, settings,
                hwidCfg.notSupportedRemark, HWID_DEFAULT_REMARK_NOT_SUPPORTED, oh);
            return { extraHeaders: {}, aborted: true };
        }
        extra['x-hwid-not-supported'] = 'true';
        return { extraHeaders: extra, aborted: false };
    }

    const enforce = !user.hwidEnforceFrom || new Date(user.hwidEnforceFrom) <= new Date();
    const result = await hwidDeviceService.checkAndUpsert({
        userId: user.userId,
        headers: h,
        limit,
        enforce,
    });

    if (result.exceeded) {
        const oh = { ...extra, 'x-hwid-max-devices-reached': 'true' };

        // HAPP popup fallback chain: dedicated announce → remark → default text.
        // Always set announce on HAPP so the popup is shown even if admin only
        // filled the remark field.
        if (isHapp) {
            const popup = (hwidCfg.maxDevicesAnnounce || '').trim()
                || (hwidCfg.maxDevicesRemark || '').trim()
                || HWID_DEFAULT_REMARK_MAX_DEVICES;
            oh['announce'] = encodeAnnounceHeader(popup);
        }

        webhookService.emitDeviceLimitReachedOnce(user.userId, { limit });
        sendFakeSubscription(res, user, format, userAgent, settings,
            hwidCfg.maxDevicesRemark, HWID_DEFAULT_REMARK_MAX_DEVICES, oh);
        return { extraHeaders: {}, aborted: true };
    }

    if (result.isNew) {
        webhookService.emit(webhookService.EVENTS.USER_DEVICE_ADDED, {
            userId: user.userId,
            hwid: h.hwid,
            platform: h.platform,
            deviceModel: h.deviceModel,
        });
    }

    return { extraHeaders: extra, aborted: false };
}

// ==================== SHARED PIPELINE ====================

/**
 * Render the subscription response for an already-loaded, already-validated
 * user. Exposed so the Marzban-compat route can reuse the entire HWID/cache/
 * format/HAPP pipeline without duplicating any of it.
 *
 * @param {Object} req     Express request
 * @param {Object} res     Express response
 * @param {Object} ctx
 * @param {Object} ctx.user        Mongoose-populated HyUser document
 * @param {string} ctx.cacheToken  Key under which the rendered output is cached
 *                                 in Redis. ALWAYS the user's Celerity
 *                                 subscriptionToken so legacy/native requests
 *                                 share a single cache entry.
 * @param {string} ctx.baseUrl     Absolute URL used to seed the HTML page (QR
 *                                 code, copy-to-clipboard input). Either the
 *                                 native /api/files URL or the legacy /sub URL
 *                                 the user actually visited.
 */
async function serveSubscription(req, res, ctx) {
    const { user, cacheToken, baseUrl } = ctx;
    const userAgent = req.headers['user-agent'] || 'unknown';

    let format = req.query.format;
    const browser = isBrowser(req);

    // Browser without ?format — render HTML and bypass cache (no shared state
    // with apps; humans always see fresh traffic/expiry data).
    if (browser && !format) {
        const settings = await getSettings();
        const nodes = await getActiveNodes(user);
        if (nodes.length === 0) {
            return res.status(503).type('text/plain').send('# No servers available');
        }
        const html = await generateHTML(user, nodes, cacheToken, baseUrl, settings, res.locals.lang);
        return res
            .type('text/html')
            .set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            .set('Pragma', 'no-cache')
            .set('Expires', '0')
            .send(html);
    }

    if (!format) {
        format = detectFormat(userAgent);
        logger.debug(`[Sub] UA: "${userAgent}" → format: ${format}`);
    }
    uaStats.track(cacheToken, userAgent);

    const settings = await getSettings();

    const { extraHeaders: hwidHeaders, aborted: hwidAborted } = await runHwidSubscriptionGate(req, res, user, settings, format);
    if (hwidAborted) return;

    // HAPP/Incy may upgrade a "uri" response to xray-json, so split the cache
    // keyspace from plain URI consumers on the same token. HAPP and Incy share
    // one namespace (identical body; routing scheme differs post-cache).
    const cacheFormat = (isXrayProfileClient(userAgent) && (format === 'uri' || format === 'raw'))
        ? `${format}+xprofile`
        : format;

    const cached = await cache.getSubscription(cacheToken, cacheFormat);
    if (cached) {
        logger.debug(`[Sub] Cache HIT: ${cacheToken}:${cacheFormat}`);
        return sendCachedSubscription(res, cached, format, userAgent, settings, hwidHeaders);
    }

    logger.debug(`[Sub] Cache MISS: token=${cacheToken.substring(0,8)}..., format=${cacheFormat}`);

    const nodes = await getActiveNodes(user);
    if (nodes.length === 0) {
        logger.error(`[Sub] NO SERVERS for user ${user.userId}! Check nodes in panel.`);
        return res.status(503).type('text/plain').send('# No servers available');
    }

    logger.debug(`[Sub] Serving ${nodes.length} nodes to user ${user.userId}`);

    const subscriptionData = generateSubscriptionData(user, nodes, format, userAgent, settings?.subscription?.happProviderId || '', settings?.routing);
    await cache.setSubscription(cacheToken, cacheFormat, subscriptionData);
    return sendCachedSubscription(res, subscriptionData, format, userAgent, settings, hwidHeaders);
}

/**
 * JSON info payload for an already-loaded HyUser.
 * Exposed for the same reason as serveSubscription.
 */
async function serveInfo(req, res, user) {
    const nodes = await getActiveNodes(user);
    res.json({
        enabled: user.enabled,
        groups: user.groups,
        traffic: { used: (user.traffic?.tx || 0) + (user.traffic?.rx || 0), limit: user.trafficLimit },
        expire: user.expireAt,
        servers: nodes.length,
    });
}

// ==================== MAIN ROUTE ====================

/**
 * GET /files/:token — native Celerity subscription endpoint.
 * Browser → HTML page; app → format-detected subscription content.
 */
router.get('/files/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const user = await getUserByToken(token);

        if (!user) {
            logger.warn(`[Sub] User not found for token: ${token}`);
            return res.status(404).type('text/plain').send('# User not found');
        }

        const baseUrl = `${req.protocol}://${req.get('host')}/api/files/${token}`;

        const validation = validateUser(user);
        if (!validation.valid) {
            logger.warn(`[Sub] User ${user.userId} invalid: ${validation.error}`);
            return await rejectOrSoftBlock(req, res, user, validation, { cacheToken: token, baseUrl });
        }

        return await serveSubscription(req, res, { user, cacheToken: token, baseUrl });
    } catch (error) {
        logger.error(`[Sub] Error: ${error.message}`);
        res.status(500).type('text/plain').send('# Error');
    }
});

/**
 * Generate subscription data for caching
 */
function generateSubscriptionData(user, nodes, format, userAgent, happProviderId = '', routing = null) {
    let content;
    let needsBase64 = false;
    // Effective format may differ from requested when we transparently upgrade
    // the response (e.g. HAPP UA + virtual node → xray-json instead of URI list).
    // sendCachedSubscription uses this to set Content-Type and skip URI-only
    // body mutations (HAPP routing prepend) that would corrupt JSON.
    let effectiveFormat = format;

    switch (format) {
        case 'shadowrocket':
            content = generateURIList(user, nodes);
            needsBase64 = true;
            break;
        case 'clash':
        case 'yaml':
            content = generateClashYAML(user, nodes, routing);
            break;
        case 'singbox':
        case 'json':
            content = JSON.stringify(generateSingboxJSON(user, nodes, routing), null, 2);
            break;
        case 'v2ray-json':
            content = JSON.stringify(generateV2rayJSON(user, nodes, routing), null, 2);
            break;
        case 'xray-json':
            content = JSON.stringify(generateXrayJSON(user, nodes, routing), null, 2);
            break;
        case 'uri':
        case 'raw':
        default: {
            // HAPP / Incy with a virtual node → xray-json profile array so their
            // Xray-core runs the balancer. Other URI consumers keep the list.
            const hasVirtual = isXrayProfileClient(userAgent) && nodes.some(n => n.type === 'virtual');
            if (hasVirtual) {
                content = JSON.stringify(generateXrayJSON(user, nodes, routing), null, 2);
                effectiveFormat = 'xray-json';
                break;
            }
            content = generateURIList(user, nodes);
            // HAPP reads #providerid from body as fallback (in case headers are stripped by a proxy)
            if (happProviderId) {
                content = `#providerid ${happProviderId}\n${content}`;
            }
            if (/quantumult/i.test(userAgent)) {
                needsBase64 = true;
            }
            break;
        }
    }
    
    if (needsBase64) {
        content = Buffer.from(content).toString('base64');
    }
    
    return {
        content,
        contentFormat: effectiveFormat,
        profileTitle: getSubscriptionTitle(user),
        username: user.username || user.userId,
        traffic: {
            tx: user.traffic?.tx || 0,
            rx: user.traffic?.rx || 0,
        },
        trafficLimit: user.trafficLimit || 0,
        expireAt: user.expireAt,
    };
}

/**
 * Send cached subscription response
 */
function sendCachedSubscription(res, data, format, userAgent, settings, hwidExtraHeaders = null) {
    // contentFormat reflects what's actually in `data.content` and may differ
    // from the requested `format` when we transparently upgrade the response
    // (HAPP UA + virtual node → xray-json). Falls back to `format` for legacy
    // cache entries written before this field existed.
    const effectiveFormat = data.contentFormat || format;
    let contentType = 'text/plain';

    switch (effectiveFormat) {
        case 'clash':
        case 'yaml':
            contentType = 'text/yaml';
            break;
        case 'singbox':
        case 'json':
        case 'v2ray-json':
        case 'xray-json':
            contentType = 'application/json';
            break;
    }
    
    const headers = {
        'Content-Type': `${contentType}; charset=utf-8`,
        'Content-Disposition': buildContentDisposition(data.username),
        'Profile-Title': encodeTitle(data.profileTitle),
        'Profile-Update-Interval': String(settings?.subscription?.updateInterval || 12),
        'Subscription-Userinfo': [
            `upload=${data.traffic.tx}`,
            `download=${data.traffic.rx}`,
            data.trafficLimit > 0 ? `total=${data.trafficLimit}` : null,
            `expire=${data.expireAt ? Math.floor(new Date(data.expireAt).getTime() / 1000) : 0}`,
        ].filter(Boolean).join('; '),
    };

    const sub = settings?.subscription;
    // Admin-supplied values land in raw headers, where a single non-ASCII byte
    // makes Node throw and takes the whole subscription down with it.
    const supportUrl = asciiHeaderValue(sub?.supportUrl);
    const webPageUrl = asciiHeaderValue(sub?.webPageUrl);
    const providerId = asciiHeaderValue(sub?.happProviderId);
    if (supportUrl) headers['support-url']          = supportUrl;
    if (webPageUrl) headers['profile-web-page-url'] = webPageUrl;
    if (providerId) headers['providerid']            = providerId;

    let content = data.content;

    // HAPP / Incy: routing profile via `routing` header + body. Same profile
    // format; HAPP uses its `happ://` scheme, Incy the scheme-relative form.
    // Body prepend only for a plain URI list (would corrupt xray-json).
    const isHappClient = isHappUa(userAgent);
    const isIncyClient = isIncyUa(userAgent);
    if (isHappClient || isIncyClient) {
        const isUriBody = (effectiveFormat === 'uri' || effectiveFormat === 'raw');
        const routingScheme = isHappClient ? 'happ' : '';
        if (settings?.routing?.enabled) {
            const profile = buildHappRoutingProfile(settings.routing);
            if (profile) {
                const b64 = Buffer.from(JSON.stringify(profile)).toString('base64');
                const routingLink = `${routingScheme}://routing/onadd/${b64}`;
                headers['routing'] = routingLink;
                if (isUriBody) {
                    content = `${routingLink}\n${content}`;
                }
            }
        } else if (isHappClient) {
            // Incy has no "routing off" directive — clear rules for HAPP only.
            headers['routing'] = 'happ://routing/off';
            if (isUriBody) {
                content = `happ://routing/off\n${content}`;
            }
        }

        const happ = settings?.subscription?.happ;
        if (isHappClient && happ) {
            if (happ.announce) {
                const hasNonAscii = /[^\x20-\x7E]/.test(happ.announce);
                headers['announce'] = hasNonAscii
                    ? 'base64:' + Buffer.from(happ.announce).toString('base64')
                    : happ.announce;
            }
            if (sub?.happProviderId) {
                if (happ.hideSettings)  headers['hide-settings']                  = '1';
                if (happ.notifyExpire)  headers['notification-subs-expire']       = '1';
                if (happ.alwaysHwid)    headers['subscription-always-hwid-enable'] = '1';
                if (happ.pingType) {
                    headers['ping-type'] = happ.pingType;
                    if ((happ.pingType === 'proxy' || happ.pingType === 'proxy-head') && happ.pingUrl) {
                        headers['check-url-via-proxy'] = happ.pingUrl;
                    }
                }
                if (happ.colorProfile)  headers['color-profile'] = happ.colorProfile;
            }
        }
    }

    if (hwidExtraHeaders && typeof hwidExtraHeaders === 'object') {
        for (const [k, v] of Object.entries(hwidExtraHeaders)) {
            if (v != null && v !== '') headers[k] = v;
        }
    }

    res.set(headers);
    res.send(content);
}

// ==================== INFO ====================

router.get('/info/:token', async (req, res) => {
    try {
        const user = await getUserByToken(req.params.token);
        if (!user) return res.status(404).json({ error: 'Not found' });
        return await serveInfo(req, res, user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
// Exposed for the Marzban-compat route. Attach AFTER `module.exports = router`
// so the router instance keeps working as an express handler, and the helpers
// are reachable as properties on the same exported value.
module.exports.serveSubscription = serveSubscription;
module.exports.serveInfo = serveInfo;
module.exports.validateUser = validateUser;
module.exports.rejectOrSoftBlock = rejectOrSoftBlock;
// Exposed for the diagnostic probe manifest. The probe matches subscription
// outbounds to nodes by tag, so the panel must predict those tags with the
// very same code that generates the subscription.
module.exports.getNodeConfigs = getNodeConfigs;
module.exports.getXrayPublishedInbounds = getXrayPublishedInbounds;
module.exports.xrayInboundName = _xrayInboundName;
// Exposed for tests: both encode assumptions about what upstream publishes
// (rule-set tags) and what a client needs to be told (XHTTP hints), and getting
// either wrong silently breaks configs rather than failing loudly.
module.exports.singboxRuleSetTag = _singboxRuleSetTag;
module.exports.vlessURIForInbound = generateVlessURIForInbound;
module.exports.singboxVlessOutboundForInbound = _buildSingboxVlessOutboundForInbound;
module.exports.clashVlessProxyForInbound = _buildClashVlessProxyForInbound;
module.exports.resolveCdnOrigins = resolveCdnOrigins;
