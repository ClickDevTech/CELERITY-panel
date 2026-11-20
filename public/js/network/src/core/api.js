/**
 * Thin client for the cascade API used by the network map.
 * Every id is validated before it is placed into a URL.
 */

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

const DEFAULT_TIMEOUT_MS = 20000;
/** Deploys run SSH sessions on both nodes and can take a while. */
const DEPLOY_TIMEOUT_MS = 180000;

export class ApiError extends Error {
    constructor(message, status, data) {
        super(message);
        this.status = status;
        this.data = data || null;
    }
}

export function isObjectId(id) {
    return typeof id === 'string' && OBJECT_ID_RE.test(id);
}

function idPath(id) {
    if (!isObjectId(id)) throw new ApiError('Invalid id', 0);
    return encodeURIComponent(id);
}

async function request(method, url, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, {
            method,
            credentials: 'same-origin',
            headers: body !== undefined
                ? { 'Content-Type': 'application/json', Accept: 'application/json' }
                : { Accept: 'application/json' },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: ctrl.signal,
        });
    } catch (err) {
        throw new ApiError(err && err.name === 'AbortError' ? 'Request timed out' : 'Network error', 0);
    } finally {
        clearTimeout(timer);
    }

    let data = null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) {
        data = await res.json().catch(() => null);
    }
    if (!res.ok || (data && data.success === false)) {
        const msg = (data && (data.error || (Array.isArray(data.errors) && data.errors.join('; ')))) || `HTTP ${res.status}`;
        throw new ApiError(String(msg).slice(0, 500), res.status, data);
    }
    return data;
}

export const api = {
    topology: () => request('GET', '/api/cascade/topology'),

    savePositions: positions => request('POST', '/api/cascade/topology/positions', {
        positions: positions.filter(p => isObjectId(p.id)),
    }),

    getLink: id => request('GET', `/api/cascade/links/${idPath(id)}`),
    createLink: body => request('POST', '/api/cascade/links', body),
    updateLink: (id, body) => request('PUT', `/api/cascade/links/${idPath(id)}`, body),
    deleteLink: id => request('DELETE', `/api/cascade/links/${idPath(id)}`),
    deployLink: id => request('POST', `/api/cascade/links/${idPath(id)}/deploy`, undefined, DEPLOY_TIMEOUT_MS),
    undeployLink: id => request('POST', `/api/cascade/links/${idPath(id)}/undeploy`, undefined, DEPLOY_TIMEOUT_MS),
    deployChain: linkId => {
        idPath(linkId);
        return request('POST', '/api/cascade/chain/deploy', { linkId }, DEPLOY_TIMEOUT_MS);
    },
    reconnect: (id, side, nodeId) => {
        idPath(nodeId);
        const body = side === 'bridge' ? { bridgeNodeId: nodeId } : { portalNodeId: nodeId };
        return request('PATCH', `/api/cascade/links/${idPath(id)}/reconnect`, body, DEPLOY_TIMEOUT_MS);
    },
    checkHealth: id => request('GET', `/api/cascade/links/${idPath(id)}/health`, undefined, 60000),
};

/** Backend link id from a topology edge id ("link-<objectId>"). */
export function linkIdOf(edgeId) {
    const id = typeof edgeId === 'string' && edgeId.startsWith('link-') ? edgeId.slice(5) : '';
    return isObjectId(id) ? id : null;
}

export function nodeUrl(nodeId, suffix = '') {
    return isObjectId(nodeId) ? `/panel/nodes/${encodeURIComponent(nodeId)}${suffix}` : null;
}
