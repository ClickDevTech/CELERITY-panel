const net = require('net');
const mongoose = require('mongoose');
const { validateXhttpInbound } = require('./xhttpOptions');

const CDN_EDGES_MAX = 32;
const CDN_SECURITY_VALUES = ['tls', 'none'];
const CDN_ALPN_VALUES = ['h3', 'h2', 'http/1.1', 'http/1.0'];
const CDN_FINGERPRINT_VALUES = [
    'chrome', 'firefox', 'safari', 'ios', 'android',
    'edge', '360', 'qq', 'random', 'randomized',
];
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function isValidAddress(value) {
    const address = String(value || '').trim();
    return net.isIP(address) !== 0 || HOSTNAME_RE.test(address);
}

function isValidHostname(value) {
    return HOSTNAME_RE.test(String(value || '').trim());
}

function normalizeStringList(value) {
    const values = Array.isArray(value) ? value : String(value || '').split(',');
    return [...new Set(values.map(item => String(item).trim()).filter(Boolean))];
}

function mergeCdnConfig(existing, patch) {
    if (patch === undefined) return existing;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
    return { ...(existing || {}), ...patch };
}

function normalizeCdnConfig(raw = {}) {
    const edges = Array.isArray(raw.edges) ? raw.edges : [];
    if (edges.length > CDN_EDGES_MAX) {
        return { error: `CDN node supports at most ${CDN_EDGES_MAX} edge addresses` };
    }

    const normalizedEdges = [];
    const seenIds = new Set();
    for (let index = 0; index < edges.length; index++) {
        const edge = edges[index] || {};
        const id = String(edge.id || '').trim() || `edge-${index + 1}`;
        const address = String(edge.address || '').trim();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
            return { error: `CDN edge #${index + 1}: invalid id` };
        }
        if (seenIds.has(id)) return { error: `CDN edge #${index + 1}: duplicate id` };
        if (!isValidAddress(address)) {
            return { error: `CDN edge #${index + 1}: address must be an IP or hostname` };
        }
        seenIds.add(id);
        normalizedEdges.push({
            id,
            label: String(edge.label || '').replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 64),
            address,
            enabled: edge.enabled !== false,
        });
    }

    const rawPort = raw.port;
    let port = 443;
    if (rawPort !== undefined && rawPort !== null && String(rawPort).trim() !== '') {
        const portText = String(rawPort).trim();
        if (!/^\d+$/.test(portText)) {
            return { error: 'CDN client port must be an integer between 1 and 65535' };
        }
        port = Number(portText);
    }
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        return { error: 'CDN client port must be between 1 and 65535' };
    }

    const domain = String(raw.domain || '').trim();
    if (domain && !HOSTNAME_RE.test(domain)) return { error: 'CDN public domain must be valid' };
    // Without a domain the node publishes only its enabled edges, so a config
    // whose every edge is switched off would silently vanish from subscriptions.
    if (!domain && !normalizedEdges.some(edge => edge.enabled)) {
        return { error: 'CDN public domain or at least one enabled edge address is required' };
    }

    if (raw.security && raw.security !== 'tls') {
        return { error: 'CDN client security must be TLS' };
    }
    if (raw.allowInsecure === true) {
        return { error: 'CDN client TLS cannot skip certificate verification' };
    }
    const security = 'tls';
    const sni = String(raw.sni || domain).trim();
    const host = String(raw.host || domain || sni).trim();
    if (!HOSTNAME_RE.test(sni)) {
        return { error: 'CDN SNI is required and must be a valid hostname' };
    }
    if (host && !isValidAddress(host)) return { error: 'CDN Host must be a valid hostname or IP' };

    const path = String(raw.path || '').trim();
    if (path && (!path.startsWith('/') || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(path))) {
        return { error: 'CDN client path contains unsupported characters' };
    }

    const alpn = normalizeStringList(raw.alpn);
    if (alpn.some(value => !CDN_ALPN_VALUES.includes(value))) {
        return { error: `CDN ALPN must contain only: ${CDN_ALPN_VALUES.join(', ')}` };
    }

    const fingerprint = CDN_FINGERPRINT_VALUES.includes(raw.fingerprint)
        ? raw.fingerprint
        : 'chrome';
    const xhttpMode = ['', 'auto', 'packet-up', 'stream-up', 'stream-one'].includes(raw.xhttpMode)
        ? raw.xhttpMode
        : '';
    const originNode = String(raw.originNode?._id || raw.originNode || '').trim();
    if (!mongoose.isValidObjectId(originNode)) return { error: 'CDN origin node is required' };

    return {
        value: {
            originNode,
            originInboundId: String(raw.originInboundId || '').trim().slice(0, 64),
            edges: normalizedEdges,
            domain,
            port,
            security,
            sni,
            host,
            path,
            alpn,
            fingerprint,
            allowInsecure: false,
            xhttpMode,
        },
    };
}

/**
 * Check a CDN config against an already loaded origin node. Pure, so the same
 * rules run both when the CDN node is saved and when the origin is edited.
 *
 * @param {Object} cdn - normalized CDN config
 * @param {Object} origin - origin node (plain object with `type` and `xray`)
 * @returns {{error: string}|{origin: Object, inbound: Object}}
 */
function checkCdnOriginCompat(cdn, origin) {
    if (!origin || origin.type !== 'xray') {
        return { error: 'CDN origin must reference an existing Xray node' };
    }
    // An inactive origin is dropped from every subscription, and the fronts in
    // front of it would silently disappear along with it.
    if (origin.active === false) {
        return { error: `CDN origin "${origin.name || 'node'}" is disabled — enable it first` };
    }

    let inbound = origin.xray || {};
    if (cdn.originInboundId) {
        inbound = (origin.xray?.extraInbounds || [])
            .find(item => String(item.id) === String(cdn.originInboundId));
        if (!inbound) return { error: 'Selected CDN origin inbound does not exist' };
    }

    const transport = inbound.transport || 'tcp';
    const security = inbound.security || 'reality';
    if (!['xhttp', 'ws', 'grpc'].includes(transport)) {
        return { error: 'CDN origin inbound must use XHTTP, WebSocket, or gRPC' };
    }
    if (security === 'reality') {
        return { error: 'Reality cannot be used behind a terminating CDN' };
    }
    if (transport === 'xhttp') {
        const modeError = validateCdnXhttpClient(cdn, inbound);
        if (modeError) return { error: modeError };
    } else if (cdn.xhttpMode) {
        return { error: 'CDN XHTTP mode applies to XHTTP origins only' };
    }
    if (cdn.path) {
        if (transport === 'xhttp') {
            const pathError = validateCdnClientPath(cdn.path, inbound.xhttpPath, inbound);
            if (pathError) return { error: pathError };
        } else if (transport === 'ws') {
            // Unlike XHTTP, a WebSocket inbound matches its path exactly.
            const serverPath = String(inbound.wsPath || '/');
            if (cdn.path !== serverPath) {
                return { error: `CDN client path must equal the origin WebSocket path "${serverPath}"` };
            }
        } else {
            return { error: 'CDN client path applies to XHTTP and WebSocket origins only' };
        }
    }

    return { origin, inbound };
}

/**
 * The CDN may override only the client-visible XHTTP mode. The origin still
 * owns the upload method and placement, so a front that publishes stream-up
 * in front of a GET/header inbound is saved as a config no client can use.
 */
function validateCdnXhttpClient(cdn, inbound) {
    const error = validateXhttpInbound({
        transport: 'xhttp',
        xhttpMode: cdn.xhttpMode || inbound.xhttpMode,
        xhttpUplinkHTTPMethod: inbound.xhttpUplinkHTTPMethod,
        xhttpUplinkDataPlacement: inbound.xhttpUplinkDataPlacement,
        xhttpUplinkDataKey: inbound.xhttpUplinkDataKey,
    }, 'CDN client');
    return error || null;
}

function originIdOf(nodeOrCdn) {
    if (!nodeOrCdn) return '';
    const raw = nodeOrCdn.cdn ? nodeOrCdn.cdn.originNode : nodeOrCdn.originNode;
    return String(raw?._id || raw || '');
}

function groupKey(groups) {
    return [...new Set((groups || []).map(group => String(group._id || group)))].sort().join('\0');
}

/**
 * Whether a CDN create/update/delete changes who must exist on the origin
 * Xray. Cosmetic front edits (domain, edges, SNI) do not.
 */
function cdnOriginSyncNeeded(previous, next) {
    const prevCdn = previous?.type === 'cdn';
    const nextCdn = next?.type === 'cdn';
    if (!prevCdn && !nextCdn) return false;
    if (prevCdn !== nextCdn) return true;
    if (originIdOf(previous) !== originIdOf(next)) return true;
    if ((previous.active !== false) !== (next.active !== false)) return true;
    return groupKey(previous.groups) !== groupKey(next.groups);
}

function cdnOriginIdsForSync(...nodes) {
    const ids = [];
    const seen = new Set();
    for (const node of nodes) {
        if (!node || (node.type && node.type !== 'cdn')) continue;
        const id = originIdOf(node);
        if (!id || seen.has(id) || !mongoose.isValidObjectId(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

/**
 * What the XHTTP inbound accepts depends on where the session and sequence
 * markers live (transport/internet/splithttp, hub.go + config.go):
 *
 *   - Placement `path` (the default for both): the client appends the markers
 *     to its own path, and the server reads them back as the path segments that
 *     follow its configured prefix — `subpath[0]` is the session ID. A client
 *     path longer than the origin one therefore feeds "events.php" to every
 *     session instead of a real ID, so the two paths must be equal.
 *   - Any other placement: the path carries nothing, the server only checks its
 *     prefix, and the front is free to publish a longer, CDN-friendlier path.
 *
 * @param {string} clientPath - CDN client path, already known to start with "/"
 * @param {string} serverPath - origin inbound xhttpPath
 * @param {Object} [inbound] - origin inbound, for the session/seq placements
 * @returns {string|null} error message, or null when the pair is valid
 */
function validateCdnClientPath(clientPath, serverPath, inbound = {}) {
    const base = String(serverPath || '/');
    const sessionPlacement = inbound.xhttpSessionPlacement || 'path';
    const seqPlacement = inbound.xhttpSeqPlacement || 'path';
    const markersInPath = sessionPlacement === 'path' || seqPlacement === 'path';
    const stripSlash = value => (value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value);

    if (markersInPath) {
        if (stripSlash(clientPath) !== stripSlash(base)) {
            return `CDN client path must equal the origin path "${base}" — Xray reads the next path segment as the session ID. Move the session and sequence markers to a query, header, or cookie to publish a different path.`;
        }
        return null;
    }

    const prefix = base.endsWith('/') ? base : `${base}/`;
    if (stripSlash(clientPath) !== stripSlash(base) && !clientPath.startsWith(prefix)) {
        return `CDN client path must start with the origin path "${base}"`;
    }
    return null;
}

/**
 * @param {Object} cdn - normalized CDN config
 * @param {Object} HyNode - node model
 * @param {Object} [options]
 * @param {string} [options.selfId] - id of the node being saved, so an Xray node
 *   converted into a CDN cannot end up fronting itself
 */
async function validateCdnOrigin(cdn, HyNode, { selfId } = {}) {
    if (selfId && String(selfId) === String(cdn.originNode)) {
        return { error: 'CDN origin cannot be the CDN node itself' };
    }
    const origin = await HyNode.findById(cdn.originNode)
        .select('type xray name active')
        .lean();
    return checkCdnOriginCompat(cdn, origin);
}

/**
 * Guard an edit of a node that CDN fronts point at. Deleting such a node is
 * already refused; switching its type, transport or security would break the
 * fronts just as thoroughly, only silently — the subscription keeps emitting
 * entries built from an inbound that no longer exists in that shape.
 *
 * @param {string} originId - node being edited
 * @param {Object} nextOrigin - resulting node state (`type` and `xray`)
 * @param {Object} HyNode - node model
 * @returns {Promise<string|null>} error message, or null when the edit is safe
 */
async function checkCdnDependents(originId, nextOrigin, HyNode) {
    const dependents = await HyNode.find({ type: 'cdn', 'cdn.originNode': originId })
        .select('name cdn')
        .lean();
    for (const dependent of dependents) {
        const result = checkCdnOriginCompat(dependent.cdn || {}, nextOrigin);
        if (result.error) {
            return `CDN node "${dependent.name}" depends on this node: ${result.error}`;
        }
    }
    return null;
}

// The CDN form checks the client path against the origin inbound without a
// round-trip, so the candidate query must carry path and marker placements
// for both the main inbound and every extra.
const CDN_ORIGIN_CANDIDATE_SELECT = [
    '_id name flag type active',
    'xray.transport xray.security xray.wsPath xray.xhttpPath',
    'xray.xhttpSessionPlacement xray.xhttpSeqPlacement',
    'xray.extraInbounds.id xray.extraInbounds.label',
    'xray.extraInbounds.transport xray.extraInbounds.security',
    'xray.extraInbounds.wsPath xray.extraInbounds.xhttpPath',
    'xray.extraInbounds.xhttpSessionPlacement xray.extraInbounds.xhttpSeqPlacement',
].join(' ');

/**
 * Users who reach an origin only through a CDN front must still exist on that
 * origin's Xray. The origin is typically left out of user groups so it stays
 * out of subscriptions; without this lookup the subscription UUID is rejected.
 *
 * @param {string|ObjectId} originId
 * @param {Object} HyNode
 * @param {Object} HyUser
 * @returns {Promise<Array>}
 */
async function collectCdnDependentUsers(originId, HyNode, HyUser) {
    const fronts = await HyNode.find({
        type: 'cdn',
        'cdn.originNode': originId,
        active: { $ne: false },
    }).select('_id groups').lean();
    if (!fronts.length) return [];

    const frontIds = fronts.map(front => front._id);
    const groupIds = [...new Set(fronts.flatMap(front =>
        (front.groups || []).map(group => group._id || group)
    ))];
    const noExplicitNodes = {
        $or: [
            { nodes: { $size: 0 } },
            { nodes: { $exists: false } },
        ],
    };

    const byNodes = await HyUser.find({ nodes: { $in: frontIds }, enabled: true }).lean();
    const byGroups = groupIds.length > 0
        ? await HyUser.find({ groups: { $in: groupIds }, enabled: true, ...noExplicitNodes }).lean()
        : [];
    return [...byNodes, ...byGroups];
}

module.exports = {
    CDN_EDGES_MAX,
    CDN_ALPN_VALUES,
    CDN_FINGERPRINT_VALUES,
    CDN_ORIGIN_CANDIDATE_SELECT,
    isValidAddress,
    isValidHostname,
    mergeCdnConfig,
    normalizeCdnConfig,
    checkCdnOriginCompat,
    validateCdnClientPath,
    validateCdnOrigin,
    checkCdnDependents,
    collectCdnDependentUsers,
    cdnOriginSyncNeeded,
    cdnOriginIdsForSync,
};
