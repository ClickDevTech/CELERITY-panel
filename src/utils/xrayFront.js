'use strict';

// Shared rules for the Caddy front: eligibility, routes, loopback layout and
// validation. Pure, so the model, panel, REST, MCP and the provisioner agree.

// What the front advertises: both, like any ordinary web server.
const XRAY_FRONT_ALPN = ['h2', 'http/1.1'];

/**
 * ALPN a client must offer for a fronted inbound. The front advertises both
 * and Go picks the first server protocol the client also offers, so the client
 * list is what decides the HTTP version — and it is per transport: Xray's
 * WebSocket has no HTTP/2 upgrade, while gRPC exists only over HTTP/2.
 */
const XRAY_FRONT_CLIENT_ALPN = {
    ws: ['http/1.1'],
    grpc: ['h2'],
    xhttp: XRAY_FRONT_ALPN,
};

// Caddy terminates TLS, so a fronted inbound must speak plain HTTP.
const XRAY_FRONT_TRANSPORTS = ['ws', 'grpc', 'xhttp'];
// The front must present a certificate for the node domain. Reusing the panel
// certificate makes the decoy unreachable in browsers and breaks clients that
// do not support a dial address different from the TLS server name.
const XRAY_FRONT_TLS_SOURCES = ['acme', 'manual'];
const XRAY_FRONT_PORT_BASE = 8443;
const XRAY_FRONT_LOOPBACK = '127.0.0.1';
// inboundIds entry standing for the main inbound; extras carry their own id.
const MAIN_INBOUND_ID = 'main';

function isLoopbackAddress(value) {
    const address = String(value || '').trim().toLowerCase();
    return /^127\./.test(address)
        || address === '::1'
        || address === '0:0:0:0:0:0:0:1';
}

function isFrontableTransport(transport) {
    return XRAY_FRONT_TRANSPORTS.includes(String(transport || 'tcp'));
}

function frontClientAlpn(transport) {
    return XRAY_FRONT_CLIENT_ALPN[String(transport || '')] || XRAY_FRONT_ALPN;
}

function frontPublicHost(node = {}) {
    return String(node.domain || '').trim();
}

// Main inbound and extras as one list; `id` matches front.inboundIds entries.
function listXrayInbounds(xray = {}, nodePort = 443) {
    const main = {
        id: MAIN_INBOUND_ID,
        label: '',
        port: nodePort || 443,
        listen: xray.listen || '0.0.0.0',
        transport: xray.transport || 'tcp',
        security: xray.security || 'reality',
        wsPath: xray.wsPath,
        wsHost: xray.wsHost,
        xhttpPath: xray.xhttpPath,
        xhttpHost: xray.xhttpHost,
        grpcServiceName: xray.grpcServiceName,
    };
    const extras = (Array.isArray(xray.extraInbounds) ? xray.extraInbounds : [])
        .filter(inbound => inbound && inbound.id && String(inbound.id) !== MAIN_INBOUND_ID)
        .map(inbound => ({
            id: String(inbound.id),
            label: String(inbound.label || '').trim(),
            port: inbound.port,
            listen: inbound.listen || '0.0.0.0',
            transport: inbound.transport || 'tcp',
            security: inbound.security || 'reality',
            wsPath: inbound.wsPath,
            wsHost: inbound.wsHost,
            xhttpPath: inbound.xhttpPath,
            xhttpHost: inbound.xhttpHost,
            grpcServiceName: inbound.grpcServiceName,
        }));
    return [main, ...extras];
}

// `extraId` is null/empty for the main inbound, as the subscription passes it.
function isInboundFronted(xray = {}, extraId = null) {
    const front = xray.front;
    if (!front?.enabled) return false;
    const id = String(extraId || MAIN_INBOUND_ID);
    const ids = Array.isArray(front.inboundIds) ? front.inboundIds : [];
    return ids.some(entry => String(entry || '') === id);
}

// A configured front is not client-facing until its remote transaction has
// passed both smoke tests and the applied fingerprint has been persisted.
function isFrontActive(xray = {}) {
    const front = xray.front;
    return !!(front?.enabled
        && front.status === 'active'
        && String(front.appliedFingerprint || '').trim());
}

// During disable, the old remote front remains authoritative until Xray has
// reclaimed the public listeners and Caddy has stopped successfully.
function isInboundFrontPublished(xray = {}, extraId = null) {
    const front = xray.front;
    const remoteFrontStillActive = isFrontActive(xray)
        || (!front?.enabled
            && front?.status === 'pending'
            && String(front.appliedFingerprint || '').trim());
    if (!remoteFrontStillActive) return false;
    const id = String(extraId || MAIN_INBOUND_ID);
    const ids = Array.isArray(front.inboundIds) ? front.inboundIds : [];
    return ids.some(entry => String(entry || '') === id);
}

// Does any inbound terminate TLS on its own, front aside?
function hasOwnTlsInbound(xray = {}) {
    return xray.security === 'tls'
        || (Array.isArray(xray.extraInbounds)
            && xray.extraInbounds.some(inbound => inbound?.security === 'tls'));
}

function xrayNeedsTls(xray = {}) {
    return !!xray.front?.enabled || hasOwnTlsInbound(xray);
}

function frontBasePath(inbound) {
    const transport = inbound.transport;
    if (transport === 'ws') return String(inbound.wsPath || '/');
    if (transport === 'xhttp') return String(inbound.xhttpPath || '/');
    if (transport === 'grpc') {
        const service = String(inbound.grpcServiceName || 'grpc');
        return service.startsWith('/') ? service : `/${service}`;
    }
    return '';
}

function buildFrontRoutes(xray = {}, nodePort = 443) {
    const front = xray.front || {};
    if (!front.enabled) return [];
    const byId = new Map(listXrayInbounds(xray, nodePort).map(i => [i.id, i]));
    const routes = [];
    for (const rawId of (front.inboundIds || [])) {
        const inbound = byId.get(String(rawId || ''));
        if (!inbound || !isFrontableTransport(inbound.transport)) continue;
        const base = frontBasePath(inbound).replace(/\/+$/, '') || '/';
        routes.push({
            id: inbound.id,
            transport: inbound.transport,
            // XHTTP and gRPC append segments below the base path, but a bare hit
            // must reach the inbound too instead of the decoy site.
            paths: base === '/' ? ['/*'] : [base, `${base}/*`],
            upstream: `${XRAY_FRONT_LOOPBACK}:${inbound.port}`,
            upstreamHost: inbound.transport === 'ws'
                ? String(inbound.wsHost || '').trim()
                : (inbound.transport === 'xhttp' ? String(inbound.xhttpHost || '').trim() : ''),
            // WebSocket upgrades over HTTP/1.1; the rest are HTTP/2 cleartext.
            h2c: inbound.transport !== 'ws',
        });
    }
    return routes;
}

// Deterministic loopback ports for the fronted inbounds, skipping taken ones.
function assignFrontLoopbackPorts(xray = {}, node = {}) {
    const front = xray.front || {};
    const taken = new Set([
        front.publicPort || 443,
        xray.apiPort || 61000,
        xray.agentPort || 62080,
        80,
    ]);
    const fronted = new Set((front.inboundIds || []).map(id => String(id || '')));
    const inbounds = listXrayInbounds(xray, node.port);
    for (const inbound of inbounds) {
        if (!fronted.has(inbound.id)) taken.add(inbound.port);
    }

    const assigned = new Map();
    let candidate = XRAY_FRONT_PORT_BASE;
    for (const inbound of inbounds) {
        if (!fronted.has(inbound.id) || !isFrontableTransport(inbound.transport)) continue;
        // An inbound already parked on loopback keeps its port.
        if (isLoopbackAddress(inbound.listen) && !taken.has(inbound.port)) {
            taken.add(inbound.port);
            assigned.set(inbound.id, inbound.port);
            continue;
        }
        while (taken.has(candidate)) candidate++;
        taken.add(candidate);
        assigned.set(inbound.id, candidate);
    }
    return assigned;
}

function captureFrontInboundLayout(xray = {}, node = {}) {
    return {
        main: {
            port: node.port || 443,
            listen: xray.listen || '0.0.0.0',
            security: xray.security || 'reality',
        },
        extras: (xray.extraInbounds || []).map(inbound => ({
            id: String(inbound?.id || ''),
            port: inbound?.port,
            listen: inbound?.listen || '0.0.0.0',
            security: inbound?.security || 'reality',
        })).filter(inbound => inbound.id),
    };
}

// Park the fronted inbounds on loopback without TLS. Mutates in place.
function applyFrontInboundLayout(xray = {}, node = {}) {
    const ports = assignFrontLoopbackPorts(xray, node);
    if (ports.size === 0) return;
    if (ports.has(MAIN_INBOUND_ID)) {
        xray.listen = XRAY_FRONT_LOOPBACK;
        xray.security = 'none';
        // The public port now belongs to the front.
        node.port = ports.get(MAIN_INBOUND_ID);
    }
    for (const inbound of (xray.extraInbounds || [])) {
        const port = ports.get(String(inbound?.id || ''));
        if (!port) continue;
        inbound.listen = XRAY_FRONT_LOOPBACK;
        inbound.security = 'none';
        inbound.port = port;
    }
}

function restoreFrontInboundLayout(xray = {}, node = {}, snapshot = null) {
    const main = snapshot?.main;
    if (!Number.isInteger(main?.port) || !main?.listen || !main?.security) return false;
    node.port = main.port;
    xray.listen = main.listen;
    xray.security = main.security;

    const extras = new Map((snapshot.extras || []).map(inbound => [String(inbound.id || ''), inbound]));
    for (const inbound of (xray.extraInbounds || [])) {
        const saved = extras.get(String(inbound?.id || ''));
        if (!saved) continue;
        inbound.port = saved.port || inbound.port;
        inbound.listen = saved.listen || '0.0.0.0';
        inbound.security = saved.security || 'reality';
    }
    return true;
}

// Give a public TLS listener back, otherwise the node goes dark once the front
// stops answering on its behalf.
// Not an exact inverse of applyFrontInboundLayout: the pre-front port and
// security mode are not stored, so a released inbound comes back on its
// loopback port with security='tls' and the operator has to review both.
function releaseFrontInboundLayout(xray = {}, previousInboundIds = []) {
    const ids = new Set(previousInboundIds.map(id => String(id || '')));
    if (ids.size === 0) return;
    if (ids.has(MAIN_INBOUND_ID) && isLoopbackAddress(xray.listen)) {
        xray.listen = '0.0.0.0';
        if (xray.security === 'none') xray.security = 'tls';
    }
    for (const inbound of (xray.extraInbounds || [])) {
        if (!ids.has(String(inbound?.id || '')) || !isLoopbackAddress(inbound.listen)) continue;
        inbound.listen = '0.0.0.0';
        if (inbound.security === 'none') inbound.security = 'tls';
    }
}

function normalizeStringList(value) {
    if (Array.isArray(value)) {
        return value.map(v => String(v || '').trim()).filter(Boolean);
    }
    return String(value || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
}

// A bad port is kept so validateXrayFront can report it instead of a silent
// fallback hiding the mistake.
function normalizeXrayFront(raw = {}) {
    const omitted = raw.publicPort === undefined || raw.publicPort === '';
    const publicPort = parseInt(raw.publicPort, 10);

    return {
        enabled: raw.enabled === true || raw.enabled === 'true' || raw.enabled === 'on',
        publicPort: omitted ? 443 : publicPort,
        siteMode: raw.siteMode === 'custom' ? 'custom' : 'nginx',
        inboundIds: [...new Set(normalizeStringList(raw.inboundIds))],
    };
}

// Returns the first error, or null. `context` carries { sameVps, acmeEmail },
// which only the caller can resolve.
function validateXrayFront(xray = {}, node = {}, context = {}) {
    const front = xray.front;
    if (!front || !front.enabled) return null;

    // The panel's own Caddy already owns 443 there.
    if (context.sameVps) {
        return 'Reverse proxy front is not available on the same VPS as the panel: port 443 is already used by the panel.';
    }

    if (!String(node.domain || '').trim()) {
        return 'Reverse proxy front requires a domain — fill in the Domain field on the Main tab.';
    }

    const publicPort = front.publicPort;
    if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
        return 'Front public port must be a number in 1..65535.';
    }

    const tlsSource = xray.tlsSource || 'panel';
    if (!XRAY_FRONT_TLS_SOURCES.includes(tlsSource)) {
        return `Reverse proxy front supports tlsSource ${XRAY_FRONT_TLS_SOURCES.join(', ')} — '${tlsSource}' would fail client verification.`;
    }
    if (tlsSource === 'acme') {
        if (!String(context.acmeEmail || '').trim()) {
            return "Front TLS source 'acme' requires an ACME email (node field or the panel-wide ACME_EMAIL).";
        }
        // Caddy holds port 80 for the challenge, so acme.sh cannot run next to it.
        if (hasOwnTlsInbound(xray)) {
            return "With TLS source 'acme' the front owns port 80 for the certificate challenge, so no other inbound on this node can terminate TLS. Move those inbounds behind the front, or switch TLS source to 'manual'.";
        }
    }

    const ids = Array.isArray(front.inboundIds) ? front.inboundIds : [];
    if (ids.length === 0) {
        return 'Select at least one inbound to serve through the reverse proxy front.';
    }

    const inbounds = listXrayInbounds(xray, node.port);
    const byId = new Map(inbounds.map(i => [i.id, i]));
    const seenPaths = new Map();
    const seenPorts = new Set([publicPort, xray.apiPort || 61000, xray.agentPort || 62080]);

    // An inbound that stays public keeps binding its own port, so the front
    // cannot listen on the same one — Caddy and Xray would fight over it.
    const frontedIds = new Set(ids.map(id => String(id || '')));
    for (const inbound of inbounds) {
        if (frontedIds.has(inbound.id) || inbound.port !== publicPort) continue;
        const name = inbound.id === MAIN_INBOUND_ID
            ? 'the main inbound'
            : `inbound "${inbound.id}"`;
        return `Front public port ${publicPort} is already used by ${name}, which is not served through the front. Move that inbound behind the front or give it another port.`;
    }

    for (const rawId of ids) {
        const id = String(rawId || '');
        const inbound = byId.get(id);
        const name = id ? `inbound "${id}"` : 'the main inbound';
        if (!inbound) {
            return `Reverse proxy front references ${name}, which does not exist.`;
        }
        if (!isFrontableTransport(inbound.transport)) {
            return `Front cannot serve ${name}: transport '${inbound.transport}' needs raw TLS. Use WebSocket, gRPC or XHTTP.`;
        }
        if (!isLoopbackAddress(inbound.listen)) {
            return `Front requires ${name} to listen on 127.0.0.1, not ${inbound.listen}.`;
        }
        if (inbound.security !== 'none') {
            return `Front terminates TLS, so ${name} must use security 'none', not '${inbound.security}'.`;
        }
        if (seenPorts.has(inbound.port)) {
            return `Front loopback port ${inbound.port} of ${name} collides with another port on this node.`;
        }
        seenPorts.add(inbound.port);

        if (inbound.transport === 'grpc' && String(inbound.grpcServiceName || '').includes('|')) {
            return `Front cannot serve ${name}: multi-path gRPC service names are not supported.`;
        }

        const base = frontBasePath(inbound).replace(/\/+$/, '');
        if (!base) {
            return `Front requires ${name} to use a path other than '/', which is reserved for the decoy site.`;
        }
        if (!base.startsWith('/')) {
            return `Front requires the path of ${name} to start with '/'.`;
        }
        if (seenPaths.has(base)) {
            return `Front path '${base}' is used by more than one inbound.`;
        }
        seenPaths.set(base, id);
    }

    // A prefix of another route would swallow its requests in Caddy.
    const bases = [...seenPaths.keys()];
    for (const base of bases) {
        for (const other of bases) {
            if (base !== other && other.startsWith(`${base}/`)) {
                return `Front path '${base}' is a prefix of '${other}'; give the inbounds unrelated paths.`;
            }
        }
    }

    return null;
}

module.exports = {
    XRAY_FRONT_ALPN,
    MAIN_INBOUND_ID,
    isLoopbackAddress,
    isInboundFronted,
    isFrontActive,
    isInboundFrontPublished,
    hasOwnTlsInbound,
    xrayNeedsTls,
    frontClientAlpn,
    frontPublicHost,
    frontBasePath,
    buildFrontRoutes,
    assignFrontLoopbackPorts,
    captureFrontInboundLayout,
    applyFrontInboundLayout,
    restoreFrontInboundLayout,
    releaseFrontInboundLayout,
    normalizeXrayFront,
    validateXrayFront,
};
