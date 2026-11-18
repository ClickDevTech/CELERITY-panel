'use strict';

/**
 * Allowlist for bulk config edits (Broadcast → Jobs and MCP `config_patch`).
 *
 * Only fields that take effect through a plain config push are listed: nothing
 * that needs firewall, certificate or port work on the node (ports, listen,
 * security, tlsSource, domain, sni, the front, portRange) and no secrets or
 * service fields. Every value is checked strictly: a bulk edit must fail on a
 * typo instead of silently storing a default on every node.
 *
 * Pure: the caller loads nodes, validates the final state and persists.
 */

const {
    FINGERPRINT_VALUES,
} = require('../utils/fingerprints');
const {
    XHTTP_DATA_PLACEMENT_VALUES,
    XHTTP_METHOD_VALUES,
    XHTTP_PADDING_METHOD_VALUES,
    XHTTP_PADDING_PLACEMENT_VALUES,
    XHTTP_PLACEMENT_VALUES,
    XHTTP_SESSION_TABLE_VALUES,
    isValidXhttpRange,
} = require('../utils/xhttpOptions');
const { isInboundFronted, isInboundFrontPublished } = require('../utils/xrayFront');

const ALPN_VALUES = ['h3', 'h2', 'http/1.1', 'http/1.0'];
const XHTTP_MODE_VALUES = ['auto', 'packet-up', 'stream-up', 'stream-one'];
const FLOW_VALUES = ['', 'xtls-rprx-vision'];
const TRANSPORT_VALUES = ['tcp', 'ws', 'grpc', 'xhttp'];
const SECURITY_VALUES = ['reality', 'tls', 'none'];
const SCOPES = ['main', 'main_extras', 'extras'];
const ACL_POSITIONS = ['start', 'end'];
const MAX_LIST_ITEMS = 100;

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const DEST_RE = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,45}\]):(\d{1,5})$/;
const PATH_RE = /^\/[\x21-\x7e]{0,255}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const SHORT_ID_RE = /^(?:[0-9a-f]{2}){0,8}$/;
const GRPC_SERVICE_RE = /^[A-Za-z0-9._\-/]{1,128}$/;
const PLAIN_TEXT_RE = /^[\x21-\x7e]*$/;
const HY_SCALAR_RE = /^[0-9A-Za-z. ]{0,32}$/;
// <action>(<target>): the target is an address, CIDR, geoip:/geosite:/suffix:
// matcher, `all`, plus optional protocol/port and hijack parts.
const ACL_RULE_RE = /^([A-Za-z0-9_-]{1,64})\(([A-Za-z0-9 .:/,*_@[\]-]{1,256})\)$/;
const ACL_BUILTIN_ACTIONS = {
    hysteria: ['direct', 'reject', 'default'],
    xray: ['direct', 'reject'],
};

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.expose = true;
    return error;
}

function asList(value, separator, keepEmpty = false) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(separator);
    const items = raw.map(item => String(item ?? '').trim());
    return keepEmpty ? items : items.filter(Boolean);
}

function oneOf(values, label) {
    return (value) => {
        const v = String(value ?? '').trim();
        if (!values.includes(v)) throw badRequest(`${label}: expected one of ${values.map(x => x || '""').join(', ')}`);
        return v;
    };
}

function matching(re, label, { allowEmpty = true, lower = false } = {}) {
    return (value) => {
        let v = String(value ?? '').trim();
        if (lower) v = v.toLowerCase();
        if (!v && allowEmpty) return '';
        if (!re.test(v)) throw badRequest(`${label}: invalid value "${v.slice(0, 80)}"`);
        return v;
    };
}

function bool(label) {
    return (value) => {
        if (value === true || value === 'true' || value === 'on' || value === '1' || value === 1) return true;
        if (value === false || value === 'false' || value === 'off' || value === '0' || value === 0) return false;
        throw badRequest(`${label}: expected true or false`);
    };
}

function integer(label, min, max) {
    return (value) => {
        const n = Number(String(value ?? '').trim());
        if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${label}: expected an integer ${min}..${max}`);
        return n;
    };
}

function xhttpRange(label) {
    return (value) => {
        const v = String(value ?? '').trim();
        if (v && !isValidXhttpRange(v)) throw badRequest(`${label}: expected a number or an ascending range like 100-1000`);
        return v;
    };
}

function realityDest(value) {
    const v = String(value ?? '').trim();
    const match = v.match(DEST_RE);
    const port = match ? Number(match[1]) : 0;
    if (!match || port < 1 || port > 65535) throw badRequest(`realityDest: expected host:port, got "${v.slice(0, 80)}"`);
    return v;
}

function urlValue(value) {
    const v = String(value ?? '').trim();
    let parsed = null;
    try {
        parsed = new URL(v);
    } catch {
        parsed = null;
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || v.length > 2048 || !PLAIN_TEXT_RE.test(v)) {
        throw badRequest('masquerade.proxy.url: expected an http(s) URL');
    }
    return v;
}

function aclRule(value) {
    const v = String(value ?? '').trim();
    if (!ACL_RULE_RE.test(v)) {
        throw badRequest(`aclRules: "${v.slice(0, 80)}" is not a rule like reject(geoip:cn)`);
    }
    return v;
}

// Applicability per inbound: returns null when the field applies.
const security = inbound => inbound.security || 'reality';
const transport = inbound => inbound.transport || 'tcp';
const needSecurity = (...values) => inbound => (values.includes(security(inbound))
    ? null
    : `security is ${security(inbound)}`);
const needTransport = value => inbound => (transport(inbound) === value
    ? null
    : `transport is ${transport(inbound)}`);

function inboundField(key, kind, normalize, applies = null, extra = {}) {
    return { key, kind, normalize, applies, nodeTypes: ['xray'], level: 'inbound', ...extra };
}

function xhttpField(key, kind, normalize) {
    return inboundField(key, kind, normalize, needTransport('xhttp'));
}

const FIELDS = {
    'xray.alpn': inboundField('alpn', 'list', oneOf(ALPN_VALUES, 'alpn'), needSecurity('tls'), { maxItems: ALPN_VALUES.length }),
    'xray.fingerprint': inboundField('fingerprint', 'string', oneOf(FINGERPRINT_VALUES, 'fingerprint'), needSecurity('tls', 'reality')),
    'xray.fingerprintPool': inboundField('fingerprintPool', 'list', oneOf(FINGERPRINT_VALUES, 'fingerprintPool'), needSecurity('tls', 'reality'), { maxItems: FINGERPRINT_VALUES.length }),
    'xray.flow': inboundField('flow', 'string', oneOf(FLOW_VALUES, 'flow'), null, {
        // Vision runs over raw TCP with TLS or Reality only.
        appliesValue: (inbound, value) => (value && (transport(inbound) !== 'tcp' || security(inbound) === 'none')
            ? `${transport(inbound)}/${security(inbound)} does not support Vision`
            : null),
    }),
    'xray.realityDest': inboundField('realityDest', 'string', realityDest, needSecurity('reality')),
    'xray.realitySni': inboundField('realitySni', 'list', matching(HOSTNAME_RE, 'realitySni', { allowEmpty: false, lower: true }), needSecurity('reality'), { maxItems: 32, nonEmpty: true }),
    'xray.realityShortIds': inboundField('realityShortIds', 'list', matching(SHORT_ID_RE, 'realityShortIds', { lower: true }), needSecurity('reality'), { maxItems: 16, keepEmpty: true }),
    'xray.realitySpiderX': inboundField('realitySpiderX', 'string', matching(PATH_RE, 'realitySpiderX'), needSecurity('reality')),
    'xray.wsPath': inboundField('wsPath', 'string', matching(PATH_RE, 'wsPath', { allowEmpty: false }), needTransport('ws')),
    'xray.wsHost': inboundField('wsHost', 'string', matching(HOSTNAME_RE, 'wsHost', { lower: true }), needTransport('ws')),
    'xray.grpcServiceName': inboundField('grpcServiceName', 'string', matching(GRPC_SERVICE_RE, 'grpcServiceName', { allowEmpty: false }), needTransport('grpc')),
    'xray.xhttpPath': xhttpField('xhttpPath', 'string', matching(PATH_RE, 'xhttpPath', { allowEmpty: false })),
    'xray.xhttpHost': xhttpField('xhttpHost', 'string', matching(HOSTNAME_RE, 'xhttpHost', { lower: true })),
    'xray.xhttpMode': xhttpField('xhttpMode', 'string', oneOf(XHTTP_MODE_VALUES, 'xhttpMode')),
    'xray.xhttpXPaddingBytes': xhttpField('xhttpXPaddingBytes', 'string', xhttpRange('xhttpXPaddingBytes')),
    'xray.xhttpScMaxEachPostBytes': xhttpField('xhttpScMaxEachPostBytes', 'string', xhttpRange('xhttpScMaxEachPostBytes')),
    'xray.xhttpScMinPostsIntervalMs': xhttpField('xhttpScMinPostsIntervalMs', 'string', xhttpRange('xhttpScMinPostsIntervalMs')),
    'xray.xhttpXmuxMaxConcurrency': xhttpField('xhttpXmuxMaxConcurrency', 'string', xhttpRange('xhttpXmuxMaxConcurrency')),
    'xray.xhttpXmuxHMaxRequestTimes': xhttpField('xhttpXmuxHMaxRequestTimes', 'string', xhttpRange('xhttpXmuxHMaxRequestTimes')),
    'xray.xhttpXmuxHMaxReusableSecs': xhttpField('xhttpXmuxHMaxReusableSecs', 'string', xhttpRange('xhttpXmuxHMaxReusableSecs')),
    'xray.xhttpUplinkChunkSize': xhttpField('xhttpUplinkChunkSize', 'string', xhttpRange('xhttpUplinkChunkSize')),
    'xray.xhttpSessionIDLength': xhttpField('xhttpSessionIDLength', 'string', xhttpRange('xhttpSessionIDLength')),
    'xray.xhttpUplinkHTTPMethod': xhttpField('xhttpUplinkHTTPMethod', 'string', oneOf(XHTTP_METHOD_VALUES, 'xhttpUplinkHTTPMethod')),
    'xray.xhttpUplinkDataPlacement': xhttpField('xhttpUplinkDataPlacement', 'string', oneOf(XHTTP_DATA_PLACEMENT_VALUES, 'xhttpUplinkDataPlacement')),
    'xray.xhttpXPaddingPlacement': xhttpField('xhttpXPaddingPlacement', 'string', oneOf(XHTTP_PADDING_PLACEMENT_VALUES, 'xhttpXPaddingPlacement')),
    'xray.xhttpXPaddingMethod': xhttpField('xhttpXPaddingMethod', 'string', oneOf(XHTTP_PADDING_METHOD_VALUES, 'xhttpXPaddingMethod')),
    'xray.xhttpSessionPlacement': xhttpField('xhttpSessionPlacement', 'string', oneOf(XHTTP_PLACEMENT_VALUES, 'xhttpSessionPlacement')),
    'xray.xhttpSeqPlacement': xhttpField('xhttpSeqPlacement', 'string', oneOf(XHTTP_PLACEMENT_VALUES, 'xhttpSeqPlacement')),
    'xray.xhttpSessionIDTable': xhttpField('xhttpSessionIDTable', 'string', oneOf(XHTTP_SESSION_TABLE_VALUES, 'xhttpSessionIDTable')),
    'xray.xhttpUplinkDataKey': xhttpField('xhttpUplinkDataKey', 'string', matching(TOKEN_RE, 'xhttpUplinkDataKey')),
    'xray.xhttpXPaddingKey': xhttpField('xhttpXPaddingKey', 'string', matching(TOKEN_RE, 'xhttpXPaddingKey')),
    'xray.xhttpXPaddingHeader': xhttpField('xhttpXPaddingHeader', 'string', matching(HEADER_RE, 'xhttpXPaddingHeader')),
    'xray.xhttpSessionKey': xhttpField('xhttpSessionKey', 'string', matching(TOKEN_RE, 'xhttpSessionKey')),
    'xray.xhttpSeqKey': xhttpField('xhttpSeqKey', 'string', matching(TOKEN_RE, 'xhttpSeqKey')),
    'xray.xhttpNoGrpcHeader': xhttpField('xhttpNoGrpcHeader', 'bool', bool('xhttpNoGrpcHeader')),
    'xray.xhttpXPaddingObfsMode': xhttpField('xhttpXPaddingObfsMode', 'bool', bool('xhttpXPaddingObfsMode')),
    'xray.xhttpServerMaxHeaderBytes': xhttpField('xhttpServerMaxHeaderBytes', 'int', integer('xhttpServerMaxHeaderBytes', 0, 1048576)),
    'xray.fallbackDest': inboundField('fallbackDest', 'string', matching(/^[\x21-\x7e]{1,253}$/, 'fallbackDest'), needTransport('tcp')),
    'xray.connIdle': { key: 'connIdle', kind: 'int', normalize: integer('connIdle', 10, 86400), nodeTypes: ['xray'], level: 'main' },

    aclRules: {
        key: 'aclRules', kind: 'list', normalize: aclRule, nodeTypes: ['xray', 'hysteria'], level: 'node',
        separator: '\n', maxItems: MAX_LIST_ITEMS, positional: true,
    },

    'bandwidth.up': { key: 'bandwidth.up', kind: 'string', normalize: matching(HY_SCALAR_RE, 'bandwidth.up'), nodeTypes: ['hysteria'], level: 'node' },
    'bandwidth.down': { key: 'bandwidth.down', kind: 'string', normalize: matching(HY_SCALAR_RE, 'bandwidth.down'), nodeTypes: ['hysteria'], level: 'node' },
    ignoreClientBandwidth: { key: 'ignoreClientBandwidth', kind: 'bool', normalize: bool('ignoreClientBandwidth'), nodeTypes: ['hysteria'], level: 'node' },
    hopInterval: { key: 'hopInterval', kind: 'string', normalize: matching(/^[0-9a-z]{0,16}$/, 'hopInterval'), nodeTypes: ['hysteria'], level: 'node' },
    udpIdleTimeout: { key: 'udpIdleTimeout', kind: 'string', normalize: matching(/^[0-9a-z]{0,16}$/, 'udpIdleTimeout'), nodeTypes: ['hysteria'], level: 'node' },
    disableUDP: { key: 'disableUDP', kind: 'bool', normalize: bool('disableUDP'), nodeTypes: ['hysteria'], level: 'node' },
    'masquerade.proxy.url': {
        key: 'masquerade.proxy.url', kind: 'string', normalize: urlValue, nodeTypes: ['hysteria'], level: 'node',
        appliesNode: node => (node.masquerade?.type === 'string' ? 'masquerade type is string' : null),
    },
};

function listFields() {
    return Object.entries(FIELDS).map(([path, def]) => ({
        path,
        kind: def.kind,
        level: def.level,
        nodeTypes: def.nodeTypes.slice(),
        ops: def.kind === 'list' ? ['set', 'add', 'remove'] : ['set'],
        positional: !!def.positional,
    }));
}

function getField(path) {
    return Object.prototype.hasOwnProperty.call(FIELDS, path) ? FIELDS[path] : null;
}

function normalizeValue(def, op, raw) {
    if (def.kind !== 'list') {
        if (raw === undefined || raw === null || Array.isArray(raw) || typeof raw === 'object') {
            throw badRequest('value must be a single value for this field');
        }
        return def.normalize(raw);
    }
    const items = asList(raw, def.separator || ',', !!def.keepEmpty && op === 'set');
    if (items.length > (def.maxItems || MAX_LIST_ITEMS)) {
        throw badRequest(`value: at most ${def.maxItems || MAX_LIST_ITEMS} items`);
    }
    if (op !== 'set' && items.length === 0) throw badRequest('value: list at least one item');
    const normalized = [...new Set(items.map(item => def.normalize(item)))];
    if (op === 'set' && def.nonEmpty && normalized.length === 0) throw badRequest('value: the list cannot be empty');
    return normalized;
}

function normalizeInboundFilter(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('inboundFilter must be an object');
    const filter = {};
    if (raw.transport) filter.transport = oneOf(TRANSPORT_VALUES, 'inboundFilter.transport')(raw.transport);
    if (raw.security) filter.security = oneOf(SECURITY_VALUES, 'inboundFilter.security')(raw.security);
    return Object.keys(filter).length > 0 ? filter : null;
}

/**
 * Parse and normalize the patch parameters. Throws a 400 error on anything
 * outside the allowlist.
 * @param {Object} params - { path, op, value, scope, inboundFilter, position }
 * @returns {{ path, op, value, scope, inboundFilter, position, def }}
 */
function parsePatch(params = {}) {
    const path = String(params.path || '').trim();
    const def = getField(path);
    if (!def) throw badRequest('This field cannot be changed in bulk');
    const op = String(params.op || 'set').trim();
    if (op !== 'set' && !(def.kind === 'list' && (op === 'add' || op === 'remove'))) {
        throw badRequest(`Operation "${op}" is not supported for ${path}`);
    }
    const value = normalizeValue(def, op, params.value);
    const scope = def.level === 'inbound'
        ? oneOf(SCOPES, 'scope')(params.scope || 'main_extras')
        : null;
    const inboundFilter = def.level === 'inbound' ? normalizeInboundFilter(params.inboundFilter) : null;
    const position = def.positional && op === 'add'
        ? oneOf(ACL_POSITIONS, 'position')(params.position || 'start')
        : null;
    return { path, op, value, scope, inboundFilter, position, def };
}

// Parameters safe to show back to the operator and to log.
function publicPatch(patch) {
    const out = { path: patch.path, op: patch.op, value: patch.value };
    if (patch.scope) out.scope = patch.scope;
    if (patch.inboundFilter) out.inboundFilter = patch.inboundFilter;
    if (patch.position) out.position = patch.position;
    return out;
}

function sameValue(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function readPath(target, dotted) {
    return dotted.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), target);
}

function nextValue(patch, current) {
    const { op, value, def } = patch;
    if (op === 'set') {
        if (def.key === 'realityShortIds' && value.length === 0) return [''];
        return value;
    }
    const list = Array.isArray(current) ? current.map(String) : [];
    if (op === 'add') {
        const missing = value.filter(item => !list.includes(item));
        if (missing.length === 0) return list;
        return patch.position === 'start' ? [...missing, ...list] : [...list, ...missing];
    }
    const kept = list.filter(item => !value.includes(item));
    if (def.key === 'realityShortIds' && kept.length === 0) return [''];
    return kept;
}

function matchesFilter(inbound, filter) {
    if (!filter) return true;
    if (filter.transport && transport(inbound) !== filter.transport) return false;
    if (filter.security && security(inbound) !== filter.security) return false;
    return true;
}

// Outbound names an ACL rule may route to on this node.
function aclTargets(node) {
    const outbounds = (node.outbounds || []).filter(ob => ob && ob.name && ob.type !== 'block');
    const names = new Set([...(ACL_BUILTIN_ACTIONS[node.type] || []), ...outbounds.map(ob => String(ob.name))]);
    if (node.type === 'xray' && outbounds.length > 0) names.add('proxy');
    return names;
}

function aclNodeReason(node, patch) {
    if (node.type === 'hysteria') {
        if (node.acl?.enabled === false) return 'ACL is disabled on this node';
        if ((node.acl?.type || 'inline') === 'file') return 'ACL is loaded from a file on this node';
    }
    if (patch.op === 'remove') return null;
    const targets = aclTargets(node);
    for (const rule of patch.value) {
        const action = rule.match(ACL_RULE_RE)[1];
        if (!targets.has(action)) return `Outbound "${action}" does not exist on this node`;
    }
    return null;
}

/**
 * Work out what the patch changes on one node. Never mutates `node`.
 * @param {Object} node - plain node (type, xray, outbounds, acl, Hysteria fields)
 * @param {Object} patch - result of parsePatch
 * @returns {{ changes: Array, reason: string|null, notes: string[] }}
 *   changes[]: { target: 'main'|'node'|<extra id>, label, key, dbPath, before, after }
 */
function planNodePatch(node, patch) {
    const { def } = patch;
    if (!def.nodeTypes.includes(node.type)) {
        return { changes: [], reason: `Not available for ${node.type || 'this'} nodes`, notes: [] };
    }

    if (def.level === 'node') {
        const reason = def.key === 'aclRules' ? aclNodeReason(node, patch) : def.appliesNode?.(node) || null;
        if (reason) return { changes: [], reason, notes: [] };
        const before = readPath(node, def.key);
        const after = nextValue(patch, before);
        const changes = sameValue(before, after) ? [] : [{ target: 'node', label: '', key: def.key, dbPath: def.key, before: before ?? null, after }];
        return { changes, reason: changes.length ? null : 'Already up to date', notes: [] };
    }

    const xray = node.xray || {};
    const candidates = [];
    if (def.level === 'main' || patch.scope !== 'extras') {
        candidates.push({ target: 'main', label: 'main', inbound: xray, dbPath: `xray.${def.key}` });
    }
    if (def.level === 'inbound' && patch.scope !== 'main') {
        (xray.extraInbounds || []).forEach((inbound, index) => {
            if (!inbound || !inbound.id) return;
            candidates.push({
                target: String(inbound.id),
                label: String(inbound.label || inbound.id),
                inbound,
                dbPath: `xray.extraInbounds.${index}.${def.key}`,
            });
        });
    }

    const changes = [];
    const notes = [];
    for (const candidate of candidates) {
        const { inbound } = candidate;
        if (def.level === 'inbound' && !matchesFilter(inbound, patch.inboundFilter)) continue;
        const extraId = candidate.target === 'main' ? null : candidate.target;
        // The front owns the routes and the TLS of these inbounds.
        if (def.level === 'inbound' && (isInboundFronted(xray, extraId) || isInboundFrontPublished(xray, extraId))) {
            notes.push(`${candidate.label}: served by the reverse proxy front`);
            continue;
        }
        const skip = def.applies?.(inbound) || def.appliesValue?.(inbound, patch.value) || null;
        if (skip) {
            notes.push(`${candidate.label}: ${skip}`);
            continue;
        }
        const before = inbound[def.key];
        const after = nextValue(patch, before);
        if (def.nonEmpty && Array.isArray(after) && after.length === 0) {
            notes.push(`${candidate.label}: ${def.key} cannot become empty`);
            continue;
        }
        if (sameValue(before, after)) continue;
        changes.push({ target: candidate.target, label: candidate.label, key: def.key, dbPath: candidate.dbPath, before: before ?? null, after });
    }
    let reason = null;
    if (changes.length === 0) reason = notes.length ? notes.join('; ') : 'Already up to date';
    return { changes, reason, notes };
}

/**
 * Apply planned changes to a plain node copy (for validation of the final state).
 * @returns {Object} new plain node
 */
function applyChanges(node, changes) {
    const next = JSON.parse(JSON.stringify(node));
    for (const change of changes) {
        const parts = change.dbPath.split('.');
        let cur = next;
        for (const part of parts.slice(0, -1)) {
            if (cur[part] === undefined || cur[part] === null) cur[part] = {};
            cur = cur[part];
        }
        cur[parts[parts.length - 1]] = change.after;
    }
    return next;
}

module.exports = {
    FIELDS,
    ALPN_VALUES,
    SCOPES,
    listFields,
    getField,
    parsePatch,
    publicPatch,
    planNodePatch,
    applyChanges,
};
