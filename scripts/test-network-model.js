const assert = require('assert');

const model = require('../public/js/network/src/core/model.js');

const id = n => String(n).padStart(24, '0');
const P = id(1);
const R = id(2);
const B1 = id(3);
const B2 = id(4);
const S = id(5);
const CDN = id(6);
const X = id(7);
const Y = id(8);

function node(nodeId, extra = {}) {
    return { data: { id: nodeId, label: `node ${nodeId.slice(-1)}`, status: 'online', type: 'xray', cascadeRole: 'standalone', ...extra } };
}

function link(n, source, target, extra = {}) {
    return { data: { id: `link-${id(100 + n)}`, source, target, label: `l${n}`, status: 'online', latencyMs: 10, ...extra } };
}

const topology = {
    nodes: [
        node(P, { cascadeRole: 'portal', onlineUsers: 7, flag: '🇩🇪' }),
        node(R, { cascadeRole: 'relay', country: 'fi' }),
        node(B1, { cascadeRole: 'bridge', label: 'Exit Amsterdam' }),
        node(B2, { cascadeRole: 'bridge', status: 'offline', lastError: 'ssh timeout' }),
        node(S, { onlineUsers: 2 }),
        node(CDN, { type: 'cdn', cascadeRole: 'standalone' }),
        node(X, { cascadeRole: 'relay' }),
        node(Y, { cascadeRole: 'relay' }),
        { data: { id: 'internet', type: 'internet', cascadeRole: 'internet', status: 'online' } },
    ],
    edges: [
        link(1, P, R),
        link(2, R, B1, { latencyMs: 20 }),
        link(3, R, B2, { status: 'error', lastError: 'handshake failed', latencyMs: null }),
        link(4, X, Y, { status: 'pending', latencyMs: null }),
        link(5, Y, X, { status: 'pending', latencyMs: null }),
        { data: { id: `cdn-${CDN}-${P}`, source: CDN, target: P, isCdnEdge: true, status: 'online' } },
        { data: { id: `internet-${B1}`, source: B1, target: 'internet', isInternetEdge: true } },
        { data: { id: 'link-dangling', source: P, target: id(99) } },
    ],
};

const index = model.buildIndex(topology);

// Index: internet and dangling edges are excluded, CDN edges kept apart.
assert.strictEqual(index.nodes.size, 8);
assert.ok(index.internet);
assert.strictEqual(index.links.size, 5);
assert.strictEqual(index.cdnEdges.size, 1);
assert.strictEqual(index.originByCdn.get(CDN), P);
assert.deepStrictEqual(model.cdnFor(index, P).map(n => n.id), [CDN]);
assert.ok(!index.links.has('link-dangling'));

// Roles.
assert.strictEqual(model.roleOf(model.nodeOf(index, CDN)), 'cdn');
assert.strictEqual(model.roleOf(model.nodeOf(index, 'internet')), 'internet');
assert.ok(model.isExitNode(model.nodeOf(index, B1)));
assert.ok(!model.isExitNode(model.nodeOf(index, P)));

// Roots and standalone nodes (CDN fronts are neither).
assert.deepStrictEqual(model.roots(index).map(n => n.id), [P]);
assert.deepStrictEqual(model.soloNodes(index).map(n => n.id), [S]);

// Chains: two paths from the portal plus the cycle X <-> Y, every link covered.
const chains = model.chains(index);
const fromPortal = chains.filter(c => c.nodes[0] === P);
assert.strictEqual(fromPortal.length, 2);
assert.deepStrictEqual(fromPortal.map(c => c.nodes[c.nodes.length - 1]).sort(), [B1, B2].sort());
const covered = new Set(chains.flatMap(c => c.links));
for (const l of index.links.keys()) assert.ok(covered.has(l), `link ${l} must be in a chain`);
for (const c of chains) assert.strictEqual(new Set(c.nodes).size, c.nodes.length, 'chains must not repeat nodes');

// Chain summary picks the worst status and sums latency only when all are measured.
const okChain = fromPortal.find(c => c.nodes.includes(B1));
const badChain = fromPortal.find(c => c.nodes.includes(B2));
assert.deepStrictEqual(model.chainSummary(index, okChain), { status: 'online', latencyMs: 30 });
assert.deepStrictEqual(model.chainSummary(index, badChain), { status: 'error', latencyMs: null });

// Related: a link highlights its whole chain and the CDN front of the portal.
const relB1 = model.related(index, 'link', `link-${id(102)}`);
assert.ok(relB1.nodes.has(P) && relB1.nodes.has(R) && relB1.nodes.has(B1) && relB1.nodes.has(CDN));
assert.ok(!relB1.nodes.has(B2));
const relCdn = model.related(index, 'node', CDN);
assert.ok(relCdn.nodes.has(B1) && relCdn.nodes.has(B2));
assert.strictEqual(model.related(index, 'link', 'link-missing').nodes.size, 0);

// Problems are sorted errors first and carry server error details.
const problems = model.problems(index);
assert.strictEqual(problems[0].sev, 'error');
assert.strictEqual(problems[0].code, 'linkError');
assert.strictEqual(problems[0].detail, 'handshake failed');
assert.ok(problems.some(p => p.code === 'nodeOffline' && p.detail === 'ssh timeout'));
assert.strictEqual(problems.filter(p => p.code === 'linkPending').length, 2);

// Stats ignore CDN fronts.
const stats = model.stats(index);
assert.strictEqual(stats.nodes, 7);
assert.strictEqual(stats.online, 6);
assert.strictEqual(stats.users, 9);
assert.strictEqual(stats.links, 5);
assert.strictEqual(stats.linksOk, 2);
assert.strictEqual(stats.avgLatency, 15);
assert.strictEqual(stats.problems, 4);

// Country detection: flag first, then the two-letter country field.
assert.strictEqual(model.countryFromFlag('🇩🇪', ''), 'DE');
assert.strictEqual(model.countryFromFlag('', 'fi'), 'FI');
assert.strictEqual(model.countryFromFlag('🖥️', 'Finland'), null);
assert.strictEqual(model.countryFromFlag(null, null), null);

// Search and short names.
assert.ok(model.matchesQuery(model.nodeOf(index, B1), 'amster'));
assert.ok(!model.matchesQuery(model.nodeOf(index, B1), 'tokyo'));
assert.strictEqual(model.shortName({ label: 'Exit Amsterdam' }), 'Amsterdam');
assert.ok(model.shortName({ label: 'x'.repeat(40) }).length <= 18);

// Structure key ignores status changes but reacts to new links.
const key = model.structureKey(index);
const statusOnly = JSON.parse(JSON.stringify(topology));
statusOnly.edges[0].data.status = 'error';
assert.strictEqual(model.structureKey(model.buildIndex(statusOnly)), key);
const extraLink = JSON.parse(JSON.stringify(topology));
extraLink.edges.push(link(6, S, B1));
assert.notStrictEqual(model.structureKey(model.buildIndex(extraLink)), key);

// Path explosion is capped.
const wide = { nodes: [node(id(500), { cascadeRole: 'portal' })], edges: [] };
let prev = [id(500)];
let n = 0;
for (let layer = 0; layer < 6; layer++) {
    const next = [];
    for (let k = 0; k < 4; k++) {
        const nid = id(600 + layer * 10 + k);
        wide.nodes.push(node(nid, { cascadeRole: 'relay' }));
        next.push(nid);
        for (const p of prev) wide.edges.push(link(1000 + n++, p, nid));
    }
    prev = next;
}
assert.ok(model.chains(model.buildIndex(wide)).length <= model.MAX_CHAINS);

// Garbage input does not throw.
assert.strictEqual(model.buildIndex(null).nodes.size, 0);
assert.strictEqual(model.buildIndex({ nodes: [null, { data: { id: 5 } }], edges: [{}] }).nodes.size, 0);

console.log('network model tests passed');
