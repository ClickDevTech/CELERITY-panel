/**
 * Pure topology model for the network map.
 *
 * Input is the GET /api/cascade/topology payload ({ nodes: [{data, position}], edges: [{data}] }).
 * Everything here is DOM-free and i18n-free so it can be unit-tested in Node;
 * views and UI translate the returned codes themselves.
 */
'use strict';

const INTERNET_ID = 'internet';

/** Upper bound for enumerated root-to-leaf paths; protects weak clients from path explosion. */
const MAX_CHAINS = 400;

/** Worst-first ordering used to pick the status that represents a group of links. */
const STATUS_SEVERITY = { error: 5, offline: 4, pending: 3, syncing: 2, deployed: 1, online: 0 };

const SHORT_NAME_NOISE = /^(exit|cloud|cdn|node|server|vps)$/i;

function roleOf(node) {
    if (!node) return 'standalone';
    if (node.type === 'cdn') return 'cdn';
    if (node.type === 'internet' || node.id === INTERNET_ID) return 'internet';
    return node.cascadeRole || 'standalone';
}

function isExitNode(node) {
    const role = roleOf(node);
    return role === 'bridge' || role === 'standalone';
}

function severity(status) {
    return STATUS_SEVERITY[status] ?? 3;
}

function worstStatus(statuses) {
    let worst = 'online';
    for (const s of statuses) {
        if (severity(s) > severity(worst)) worst = s;
    }
    return worst;
}

/**
 * Build lookup tables. Cascade links, CDN edges and Internet edges are kept apart
 * because views treat them differently.
 */
function buildIndex(topology) {
    const nodes = new Map();
    const links = new Map();
    const cdnEdges = new Map();
    const out = new Map();
    const inc = new Map();
    const cdnByOrigin = new Map();
    const originByCdn = new Map();
    let internet = null;

    for (const raw of (topology && topology.nodes) || []) {
        const data = raw && raw.data;
        if (!data || typeof data.id !== 'string') continue;
        if (data.id === INTERNET_ID) {
            internet = { ...data };
            continue;
        }
        nodes.set(data.id, { ...data, position: raw.position || null });
        out.set(data.id, []);
        inc.set(data.id, []);
    }

    for (const raw of (topology && topology.edges) || []) {
        const data = raw && raw.data;
        if (!data || typeof data.id !== 'string') continue;
        if (data.isInternetEdge) continue;
        if (!nodes.has(data.source) || !nodes.has(data.target)) continue;
        if (data.isCdnEdge) {
            cdnEdges.set(data.id, { ...data });
            if (!cdnByOrigin.has(data.target)) cdnByOrigin.set(data.target, []);
            cdnByOrigin.get(data.target).push(data.source);
            originByCdn.set(data.source, data.target);
            continue;
        }
        const link = { ...data };
        links.set(link.id, link);
        out.get(link.source).push(link);
        inc.get(link.target).push(link);
    }

    for (const list of out.values()) list.sort(compareLinks);

    return {
        nodes, links, cdnEdges, out, in: inc, cdnByOrigin, originByCdn, internet,
        _chains: null, _chainsByNode: null, _chainsByLink: null,
    };
}

function compareLinks(a, b) {
    return String(a.label || '').localeCompare(String(b.label || '')) || (a.id < b.id ? -1 : 1);
}

function nodeOf(index, id) {
    return index.nodes.get(id) || (id === INTERNET_ID ? index.internet : null) || null;
}

function edgeOf(index, id) {
    return index.links.get(id) || index.cdnEdges.get(id) || null;
}

function outLinks(index, id) {
    return index.out.get(id) || [];
}

function inLinks(index, id) {
    return index.in.get(id) || [];
}

function cdnFor(index, originId) {
    return (index.cdnByOrigin.get(originId) || []).map(id => index.nodes.get(id)).filter(Boolean);
}

function isCascadeNode(index, id) {
    return outLinks(index, id).length > 0 || inLinks(index, id).length > 0;
}

/** Nodes that start a cascade: no incoming links, at least one outgoing. */
function roots(index) {
    const res = [];
    for (const node of index.nodes.values()) {
        if (node.type === 'cdn') continue;
        if (inLinks(index, node.id).length === 0 && outLinks(index, node.id).length > 0) res.push(node);
    }
    return res.sort(compareNodes);
}

/** Non-CDN nodes outside any cascade. */
function soloNodes(index) {
    const res = [];
    for (const node of index.nodes.values()) {
        if (node.type === 'cdn') continue;
        if (!isCascadeNode(index, node.id)) res.push(node);
    }
    return res.sort(compareNodes);
}

function compareNodes(a, b) {
    return String(a.label || '').localeCompare(String(b.label || '')) || (a.id < b.id ? -1 : 1);
}

/**
 * All root-to-leaf paths through cascade links: [{ nodes: [ids], links: [edgeIds] }].
 * Links that are only reachable through a cycle get their source treated as an extra root,
 * so every link appears in at least one chain.
 */
function chains(index) {
    if (index._chains) return index._chains;
    const res = [];
    const covered = new Set();

    function walk(nodeId, pathNodes, pathLinks) {
        if (res.length >= MAX_CHAINS) return;
        const next = outLinks(index, nodeId).filter(l => !pathNodes.includes(l.target));
        if (!next.length) {
            res.push({ nodes: pathNodes.slice(), links: pathLinks.slice() });
            pathLinks.forEach(id => covered.add(id));
            return;
        }
        for (const l of next) {
            walk(l.target, pathNodes.concat(l.target), pathLinks.concat(l.id));
        }
    }

    for (const r of roots(index)) walk(r.id, [r.id], []);
    for (const link of index.links.values()) {
        if (res.length >= MAX_CHAINS) break;
        if (!covered.has(link.id)) walk(link.source, [link.source], []);
    }

    index._chains = res;
    index._chainsByNode = new Map();
    index._chainsByLink = new Map();
    res.forEach((c, i) => {
        c.nodes.forEach(id => pushTo(index._chainsByNode, id, i));
        c.links.forEach(id => pushTo(index._chainsByLink, id, i));
    });
    return res;
}

function pushTo(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
}

function chainsThrough(index, kind, id) {
    const all = chains(index);
    const map = kind === 'node' ? index._chainsByNode : index._chainsByLink;
    return (map.get(id) || []).map(i => all[i]);
}

/** Status and summed latency of a chain. */
function chainSummary(index, chain) {
    const links = chain.links.map(id => index.links.get(id)).filter(Boolean);
    const status = worstStatus(links.map(l => l.status));
    let latency = 0;
    let measured = links.length > 0;
    for (const l of links) {
        if (typeof l.latencyMs === 'number') latency += l.latencyMs;
        else measured = false;
    }
    return { status, latencyMs: measured ? latency : null };
}

/**
 * Nodes and links that share a chain with the given element (plus attached CDN fronts).
 * Used for hover/selection highlighting.
 */
function related(index, kind, id) {
    const nodes = new Set();
    const links = new Set();
    if (kind === 'node') {
        nodes.add(id);
        const origin = index.originByCdn.get(id);
        if (origin) return related(index, 'node', origin);
    } else {
        const edge = edgeOf(index, id);
        if (!edge) return { nodes, links };
        links.add(edge.id);
        nodes.add(edge.source);
        nodes.add(edge.target);
        if (edge.isCdnEdge) {
            const rel = related(index, 'node', edge.target);
            rel.nodes.forEach(n => nodes.add(n));
            rel.links.forEach(l => links.add(l));
            links.add(edge.id);
            nodes.add(edge.source);
            return { nodes, links };
        }
    }
    for (const c of chainsThrough(index, kind, id)) {
        c.nodes.forEach(n => nodes.add(n));
        c.links.forEach(l => links.add(l));
    }
    for (const nid of Array.from(nodes)) {
        for (const cdnId of index.cdnByOrigin.get(nid) || []) {
            nodes.add(cdnId);
            for (const e of index.cdnEdges.values()) {
                if (e.source === cdnId && e.target === nid) links.add(e.id);
            }
        }
    }
    return { nodes, links };
}

/**
 * Problems sorted errors first. Codes: nodeError, nodeOffline, linkError, linkOffline, linkPending.
 * CDN fronts mirror their origin status, so they are not reported separately.
 */
function problems(index) {
    const res = [];
    for (const n of index.nodes.values()) {
        if (n.type === 'cdn') continue;
        if (n.status === 'error') res.push({ kind: 'node', id: n.id, sev: 'error', code: 'nodeError', detail: n.lastError || '' });
        else if (n.status === 'offline') res.push({ kind: 'node', id: n.id, sev: 'warn', code: 'nodeOffline', detail: n.lastError || '' });
    }
    for (const l of index.links.values()) {
        if (l.status === 'error') res.push({ kind: 'link', id: l.id, sev: 'error', code: 'linkError', detail: l.lastError || '' });
        else if (l.status === 'offline') res.push({ kind: 'link', id: l.id, sev: 'warn', code: 'linkOffline', detail: l.lastError || '' });
        else if (l.status === 'pending') res.push({ kind: 'link', id: l.id, sev: 'warn', code: 'linkPending', detail: '' });
    }
    return res.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === 'error' ? -1 : 1));
}

function stats(index) {
    let nodeCount = 0;
    let online = 0;
    let users = 0;
    for (const n of index.nodes.values()) {
        if (n.type === 'cdn') continue;
        nodeCount++;
        if (n.status === 'online') online++;
        users += Number(n.onlineUsers) || 0;
    }
    let linksOk = 0;
    const lat = [];
    for (const l of index.links.values()) {
        if (l.status === 'online') linksOk++;
        if (typeof l.latencyMs === 'number') lat.push(l.latencyMs);
    }
    const allChains = chains(index);
    const chainsOk = allChains.filter(c => chainSummary(index, c).status === 'online').length;
    return {
        nodes: nodeCount,
        online,
        users,
        links: index.links.size,
        linksOk,
        chains: allChains.length,
        chainsOk,
        avgLatency: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        problems: problems(index).length,
    };
}

/** Compact label for tight spots: drops provider noise words and keeps the last word. */
function shortName(node) {
    const label = String((node && (node.label || node.ip)) || '').trim();
    const words = label.split(/\s+/).filter(w => w && !SHORT_NAME_NOISE.test(w));
    const res = words.length ? words[words.length - 1] : label;
    return res.length > 18 ? `${res.slice(0, 17)}…` : res;
}

/**
 * ISO 3166-1 alpha-2 code from a flag emoji (pair of regional indicators),
 * falling back to a two-letter `country` field. Returns null when unknown.
 */
function countryFromFlag(flag, country) {
    const cps = Array.from(String(flag || '')).map(ch => ch.codePointAt(0));
    const ri = cps.filter(cp => cp >= 0x1F1E6 && cp <= 0x1F1FF);
    if (ri.length >= 2) {
        return String.fromCharCode(ri[0] - 0x1F1E6 + 65, ri[1] - 0x1F1E6 + 65);
    }
    const c = String(country || '').trim();
    if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
    return null;
}

/** Search match against name, IP, domain and country. */
function matchesQuery(node, query) {
    if (!query) return true;
    const q = String(query).toLowerCase();
    return [node.label, node.ip, node.domain, node.country]
        .some(v => typeof v === 'string' && v.toLowerCase().includes(q));
}

/**
 * Fingerprint of everything that affects layout (ids, endpoints, roles, labels).
 * Status/latency changes keep the same key, so views can patch instead of rebuild.
 */
function structureKey(index) {
    const parts = [];
    for (const n of index.nodes.values()) {
        parts.push(`n|${n.id}|${n.label}|${n.flag}|${n.type}|${n.cascadeRole}|${n.country}|${n.ip}`);
    }
    for (const l of index.links.values()) {
        parts.push(`l|${l.id}|${l.source}|${l.target}|${l.mode}|${l.label}`);
    }
    for (const e of index.cdnEdges.values()) parts.push(`c|${e.id}`);
    parts.sort();
    return parts.join('\n');
}

module.exports = {
    INTERNET_ID,
    MAX_CHAINS,
    roleOf,
    isExitNode,
    severity,
    worstStatus,
    buildIndex,
    nodeOf,
    edgeOf,
    outLinks,
    inLinks,
    cdnFor,
    isCascadeNode,
    roots,
    soloNodes,
    chains,
    chainsThrough,
    chainSummary,
    related,
    problems,
    stats,
    shortName,
    countryFromFlag,
    matchesQuery,
    structureKey,
};
