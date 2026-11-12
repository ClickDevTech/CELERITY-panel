'use strict';

// Probe settings of a virtual node, shared by the panel form, REST and MCP.

const OBSERVATORY_HTTP_METHODS = ['HEAD', 'GET'];
const DEFAULT_OBSERVATORY_DESTINATION = 'http://www.gstatic.com/generate_204';

function trimmed(value) {
    return typeof value === 'string' ? value.trim() : '';
}

// Xray only reads the response body when the method is exactly "GET" and never
// checks the status, so any other method behaves like HEAD at best.
function normalizeObservatoryHttpMethod(value) {
    if (value === undefined || value === null || value === '') return 'HEAD';
    if (typeof value !== 'string') return null;
    const method = value.trim().toUpperCase();
    if (!method) return 'HEAD';
    return OBSERVATORY_HTTP_METHODS.includes(method) ? method : null;
}

/**
 * @param {Object} [raw]
 * @returns {{ value: Object } | { error: string }}
 */
function normalizeVirtualObservatory(raw) {
    const obs = raw && typeof raw === 'object' ? raw : {};
    const httpMethod = normalizeObservatoryHttpMethod(obs.httpMethod);
    if (!httpMethod) {
        return { error: `Virtual node: observatory.httpMethod must be one of ${OBSERVATORY_HTTP_METHODS.join(', ')}` };
    }
    return {
        value: {
            destination: trimmed(obs.destination) || DEFAULT_OBSERVATORY_DESTINATION,
            connectivity: trimmed(obs.connectivity),
            interval: trimmed(obs.interval) || '1m',
            timeout: trimmed(obs.timeout) || '5s',
            sampling: parseInt(obs.sampling, 10) || 3,
            httpMethod,
        },
    };
}

module.exports = {
    OBSERVATORY_HTTP_METHODS,
    DEFAULT_OBSERVATORY_DESTINATION,
    normalizeObservatoryHttpMethod,
    normalizeVirtualObservatory,
};
