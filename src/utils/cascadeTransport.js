/**
 * Cascade tunnel transport rules shared by the model, REST, MCP, the config
 * generator and the deploy service, so every entry point accepts and rejects
 * the same transport/security combinations.
 */

const crypto = require('crypto');

const CASCADE_TRANSPORTS = ['tcp', 'ws', 'grpc', 'xhttp', 'splithttp', 'kcp'];
const CASCADE_SECURITIES = ['none', 'tls', 'reality'];

// 'none' means no packet-header camouflage; values map to finalmask mkcp-legacy headers.
const KCP_HEADERS = ['none', 'wechat', 'dtls', 'srtp', 'wireguard'];

const KCP_LIMITS = {
    mtu: { min: 576, max: 1460 },
    tti: { min: 10, max: 100 },
    capacity: { min: 1, max: 1000 },
};

// Xray defaults (uplink 5 MB/s) would make a cascade slower than plain TCP.
const KCP_DEFAULTS = {
    mtu: 1350,
    tti: 20,
    uplinkCapacity: 100,
    downlinkCapacity: 100,
    header: 'none',
};

// finalmask "mkcp-legacy" (replacement for kcpSettings.header/seed) first shipped in this release.
const MIN_KCP_XRAY_VERSION = '26.6.1';

const KCP_NUMERIC_FIELDS = {
    kcpMtu: KCP_LIMITS.mtu,
    kcpTti: KCP_LIMITS.tti,
    kcpUplinkCapacity: KCP_LIMITS.capacity,
    kcpDownlinkCapacity: KCP_LIMITS.capacity,
};

const KCP_INPUT_FIELDS = [...Object.keys(KCP_NUMERIC_FIELDS), 'kcpHeader'];

function normalizeTransport(transport) {
    return transport === 'splithttp' ? 'xhttp' : (transport || 'tcp');
}

function isKcpTransport(transport) {
    return transport === 'kcp';
}

/**
 * @returns {string|null} error message, or null when the combination is valid
 */
function validateTransportSecurity(transport, security) {
    const trans = transport || 'tcp';
    const sec = security || 'none';
    if (!CASCADE_TRANSPORTS.includes(trans)) {
        return `tunnelTransport must be one of: ${CASCADE_TRANSPORTS.join(', ')}`;
    }
    if (!CASCADE_SECURITIES.includes(sec)) {
        return `tunnelSecurity must be one of: ${CASCADE_SECURITIES.join(', ')}`;
    }
    if (sec === 'reality' && trans === 'ws') {
        return 'REALITY security is not compatible with WebSocket transport. Use TCP, gRPC, or SplitHTTP.';
    }
    if (sec === 'reality' && trans === 'kcp') {
        return 'REALITY security is not compatible with mKCP transport. Use none or TLS.';
    }
    return null;
}

/**
 * Validate mKCP fields from untrusted input. Only keys present in `input` are
 * returned, so the result can be used for both create and partial update.
 * kcpPassword is intentionally ignored: it is generated server-side only.
 *
 * @returns {{ fields: Object, error: string|null }}
 */
function sanitizeKcpInput(input = {}) {
    const fields = {};
    for (const [key, range] of Object.entries(KCP_NUMERIC_FIELDS)) {
        if (input[key] === undefined || input[key] === null || input[key] === '') continue;
        const value = Number(input[key]);
        if (!Number.isInteger(value) || value < range.min || value > range.max) {
            return { fields: {}, error: `${key} must be an integer between ${range.min} and ${range.max}` };
        }
        fields[key] = value;
    }
    if (input.kcpHeader !== undefined && input.kcpHeader !== null && input.kcpHeader !== '') {
        const header = String(input.kcpHeader);
        if (!KCP_HEADERS.includes(header)) {
            return { fields: {}, error: `kcpHeader must be one of: ${KCP_HEADERS.join(', ')}` };
        }
        fields.kcpHeader = header;
    }
    return { fields, error: null };
}

function generateKcpPassword() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Firewall / socket protocol used by the tunnel listener.
 */
function tunnelSocketProtocol(link) {
    return isKcpTransport(link?.tunnelTransport) ? 'udp' : 'tcp';
}

/**
 * Whether a port lies in a Hysteria hopping range ("start-end"). Malformed
 * ranges never match, mirroring the setup script that skips them.
 */
function portInRange(port, range) {
    const match = /^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/.exec(String(range || ''));
    if (!match) return false;
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    return start <= end && port >= start && port <= end;
}

/**
 * Describe a clash between an mKCP tunnel port and the UDP ports of Hysteria
 * nodes sharing the listener's IP: the main port is taken, and port hopping
 * REDIRECTs its whole range to Hysteria at the NAT level.
 * @param {number} port
 * @param {Array<{name: string, port?: number, portRange?: string, portConfigs?: Array}>} hysteriaNodes
 * @returns {string|null}
 */
function findHysteriaUdpConflict(port, hysteriaNodes) {
    for (const hy of hysteriaNodes || []) {
        const entries = [
            { port: hy.port || 443, portRange: hy.portRange },
            ...(hy.portConfigs || []).filter(c => c && c.enabled !== false),
        ];
        for (const entry of entries) {
            if (entry.port === port) {
                return `UDP port ${port} is used by Hysteria on ${hy.name}`;
            }
            if (portInRange(port, entry.portRange)) {
                return `UDP port ${port} is inside the Hysteria port hopping range ${entry.portRange} on ${hy.name}`;
            }
        }
    }
    return null;
}

module.exports = {
    CASCADE_TRANSPORTS,
    CASCADE_SECURITIES,
    KCP_HEADERS,
    KCP_LIMITS,
    KCP_DEFAULTS,
    KCP_INPUT_FIELDS,
    MIN_KCP_XRAY_VERSION,
    normalizeTransport,
    isKcpTransport,
    validateTransportSecurity,
    sanitizeKcpInput,
    generateKcpPassword,
    tunnelSocketProtocol,
    portInRange,
    findHysteriaUdpConflict,
};
