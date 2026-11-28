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
// VLESS Reverse Proxy, which replaced the removed top-level `reverse` section.
const MIN_REVERSE_XRAY_VERSION = '25.9.11';
// VLESS Encryption, which protects VLESS links without TLS/REALITY.
const MIN_VLESS_ENC_XRAY_VERSION = '25.9.5';
// `vlessRoute` routing field, used by portals to pin per-exit subscription entries.
const MIN_VLESS_ROUTE_XRAY_VERSION = '25.9.5';
// Lowest core that runs every cascade link type except mKCP.
const MIN_CASCADE_XRAY_VERSION = MIN_REVERSE_XRAY_VERSION;
// Bump when deployed link ends must be regenerated (they stop interoperating or
// lack a required rule): links deployed in an older format are redeployed on
// the next sync of their nodes.
const CASCADE_CONFIG_FORMAT = 2;

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
 * Tunnel protocol actually deployed: VLESS Reverse Proxy has no VMess
 * counterpart, so reverse links always run VLESS.
 */
function cascadeProtocol(link) {
    return link?.mode === 'forward' && link.tunnelProtocol === 'vmess' ? 'vmess' : 'vless';
}

function validateTunnelProtocol(mode, protocol) {
    if (protocol === undefined || protocol === null || protocol === '') return null;
    if (!['vless', 'vmess'].includes(protocol)) return 'tunnelProtocol must be "vless" or "vmess"';
    if (protocol === 'vmess' && (mode || 'reverse') !== 'forward') {
        return 'Reverse links use VLESS Reverse Proxy; VMess is supported only for forward chains';
    }
    return null;
}

/**
 * Plaintext VLESS links get VLESS Encryption: Xray refuses VLESS without
 * TLS/REALITY/encryption to a public address.
 */
function usesLinkVlessEncryption(link) {
    return cascadeProtocol(link) === 'vless' && (link?.tunnelSecurity || 'none') === 'none';
}

/**
 * Lowest Xray version able to run `link`, with the feature that sets it.
 * @returns {{version: string, feature: string}|null}
 */
function linkXrayRequirement(link) {
    const { compareVersions } = require('../services/xrayVersionService');
    const needs = [];
    if (isKcpTransport(link?.tunnelTransport)) needs.push({ version: MIN_KCP_XRAY_VERSION, feature: 'mKCP' });
    if (link?.mode !== 'forward') {
        needs.push({ version: MIN_REVERSE_XRAY_VERSION, feature: 'VLESS Reverse Proxy' });
        needs.push({ version: MIN_VLESS_ROUTE_XRAY_VERSION, feature: 'VLESS route' });
    }
    if (usesLinkVlessEncryption(link)) needs.push({ version: MIN_VLESS_ENC_XRAY_VERSION, feature: 'VLESS Encryption' });
    return needs.reduce((max, need) => (!max || compareVersions(need.version, max.version) > 0 ? need : max), null);
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

// ==================== ADDRESS FAMILY ====================

const IP_VERSIONS = [4, 6];

/**
 * Validate `ipVersion` from untrusted input. Absent values return no field,
 * so the result serves both create and partial update.
 * @returns {{ fields: Object, error: string|null }}
 */
function sanitizeIpVersionInput(input = {}) {
    const raw = input.ipVersion;
    if (raw === undefined || raw === null || raw === '') return { fields: {}, error: null };
    const value = Number(raw);
    if (!IP_VERSIONS.includes(value)) {
        return { fields: {}, error: 'ipVersion must be 4 or 6' };
    }
    return { fields: { ipVersion: value }, error: null };
}

function isIpv6Link(link) {
    return Number(link?.ipVersion) === 6;
}

/**
 * Node that accepts the tunnel: the bridge dials the portal in reverse mode,
 * the portal dials the bridge in forward mode.
 */
function cascadeListenRole(mode) {
    return mode === 'forward' ? 'bridge' : 'portal';
}

/**
 * Address the dialing end of `link` connects to on `node` (the listening end).
 * IPv6 links never fall back to IPv4: a missing address is a configuration
 * error that must surface instead of silently changing the tunnel family.
 * @param {Object} link
 * @param {Object} node - listening node
 * @param {string} [v4Address] - IPv4-side address, defaults to node.ip
 * @returns {string}
 */
function cascadeDialAddress(link, node, v4Address = node?.ip) {
    if (!isIpv6Link(link)) return v4Address || '';
    const address = node?.ipv6 || '';
    if (!address) {
        throw new Error(`Cascade link "${link?.name || link?._id}" runs over IPv6, but node "${node?.name || node?._id}" has no IPv6 address`);
    }
    return address;
}

/**
 * Check that an IPv6 link can be built from the given nodes.
 * @param {Object} params
 * @param {number} params.ipVersion
 * @param {string} params.mode - 'reverse' | 'forward'
 * @param {string} params.transport
 * @param {Object} params.portalNode
 * @param {Object} params.bridgeNode
 * @returns {string|null} error message, or null when valid
 */
function validateLinkIpVersion({ ipVersion, mode, transport, portalNode, bridgeNode }) {
    if (Number(ipVersion || 4) !== 6) return null;
    if (isKcpTransport(transport)) {
        return 'mKCP tunnels run over IPv4 only for now: switch the link to IPv4 or choose another transport';
    }
    const role = cascadeListenRole(mode);
    const node = role === 'bridge' ? bridgeNode : portalNode;
    if (!node?.ipv6) {
        const modeLabel = mode === 'forward' ? 'Forward' : 'Reverse';
        return `${modeLabel} link over IPv6 needs an IPv6 address on the ${role} "${node?.name || ''}": open the node and click Detect next to the IPv6 field, or switch the link to IPv4`;
    }
    return null;
}

/**
 * Mongo filter for active IPv6 links whose listening end is `nodeId`, i.e.
 * the links that stop working when the node loses its `ipv6`.
 */
function ipv6ListenerLinkFilter(nodeId) {
    return {
        active: true,
        ipVersion: 6,
        $or: [
            { mode: { $ne: 'forward' }, portalNode: nodeId },
            { mode: 'forward', bridgeNode: nodeId },
        ],
    };
}

module.exports = {
    IP_VERSIONS,
    sanitizeIpVersionInput,
    isIpv6Link,
    cascadeListenRole,
    cascadeDialAddress,
    validateLinkIpVersion,
    ipv6ListenerLinkFilter,
    CASCADE_TRANSPORTS,
    CASCADE_SECURITIES,
    KCP_HEADERS,
    KCP_LIMITS,
    KCP_DEFAULTS,
    KCP_INPUT_FIELDS,
    MIN_KCP_XRAY_VERSION,
    MIN_REVERSE_XRAY_VERSION,
    MIN_VLESS_ENC_XRAY_VERSION,
    MIN_VLESS_ROUTE_XRAY_VERSION,
    MIN_CASCADE_XRAY_VERSION,
    CASCADE_CONFIG_FORMAT,
    normalizeTransport,
    isKcpTransport,
    cascadeProtocol,
    validateTunnelProtocol,
    usesLinkVlessEncryption,
    linkXrayRequirement,
    validateTransportSecurity,
    sanitizeKcpInput,
    generateKcpPassword,
    tunnelSocketProtocol,
    portInRange,
    findHysteriaUdpConflict,
};
