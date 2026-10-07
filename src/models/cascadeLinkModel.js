/**
 * Cascade link model — represents a reverse-proxy tunnel between two Xray nodes.
 *
 * Portal (entry) accepts client traffic and proxies it via reverse tunnel.
 * Bridge (exit) initiates the tunnel to Portal and releases traffic to the internet.
 */

const mongoose = require('mongoose');
const {
    CASCADE_TRANSPORTS,
    KCP_HEADERS,
    KCP_LIMITS,
    KCP_DEFAULTS,
} = require('../utils/cascadeTransport');

const cascadeLinkSchema = new mongoose.Schema({
    name: { type: String, required: true },

    // reverse = Xray reverse-proxy (Bridge initiates tunnel TO Portal)
    // forward = proxySettings.tag chaining (Portal connects TO Bridge)
    mode: { type: String, enum: ['reverse', 'forward'], default: 'reverse' },

    portalNode: { type: mongoose.Schema.Types.ObjectId, ref: 'HyNode', required: true },
    bridgeNode: { type: mongoose.Schema.Types.ObjectId, ref: 'HyNode', required: true },

    tunnelUuid: { type: String, required: true },
    tunnelPort: { type: Number, default: 10086 },
    tunnelDomain: { type: String, default: 'reverse.tunnel.internal' },
    tunnelProtocol: { type: String, enum: ['vless', 'vmess'], default: 'vless' },
    tunnelSecurity: { type: String, enum: ['none', 'tls', 'reality'], default: 'none' },
    tunnelTransport: { type: String, enum: CASCADE_TRANSPORTS, default: 'tcp' },

    // TCP settings
    tcpFastOpen: { type: Boolean, default: true },
    tcpKeepAlive: { type: Number, default: 100 },
    tcpNoDelay: { type: Boolean, default: true },

    // WebSocket settings
    wsPath: { type: String, default: '/cascade' },
    wsHost: { type: String, default: '' },

    // gRPC settings
    grpcServiceName: { type: String, default: 'cascade' },

    // SplitHTTP (XHTTP) settings
    xhttpPath: { type: String, default: '/cascade' },
    xhttpHost: { type: String, default: '' },
    xhttpMode: { type: String, enum: ['auto', 'packet-up', 'stream-up', 'stream-one'], default: 'auto' },

    // mKCP (UDP) settings; capacities are in MB/s, as Xray expects
    kcpMtu: { type: Number, min: KCP_LIMITS.mtu.min, max: KCP_LIMITS.mtu.max, default: KCP_DEFAULTS.mtu },
    kcpTti: { type: Number, min: KCP_LIMITS.tti.min, max: KCP_LIMITS.tti.max, default: KCP_DEFAULTS.tti },
    kcpUplinkCapacity: {
        type: Number, min: KCP_LIMITS.capacity.min, max: KCP_LIMITS.capacity.max, default: KCP_DEFAULTS.uplinkCapacity,
    },
    kcpDownlinkCapacity: {
        type: Number, min: KCP_LIMITS.capacity.min, max: KCP_LIMITS.capacity.max, default: KCP_DEFAULTS.downlinkCapacity,
    },
    // AES-128-GCM password for finalmask; generated server-side, never accepted from clients
    kcpPassword: { type: String, default: '' },
    kcpHeader: { type: String, enum: KCP_HEADERS, default: 'none' },

    // REALITY security settings (used when tunnelSecurity = 'reality')
    realityDest: { type: String, default: '' },
    realitySni: { type: [String], default: [] },
    realityPrivateKey: { type: String, default: '' },
    realityPublicKey: { type: String, default: '' },
    realityShortIds: { type: [String], default: [''] },
    realityFingerprint: { type: String, default: 'chrome' },

    // MUX settings for tunnel outbound
    muxEnabled: { type: Boolean, default: false },
    muxConcurrency: { type: Number, default: 8 },

    // Geo-routing: route specific domains/IPs through this bridge instead of the default
    geoRouting: {
        enabled: { type: Boolean, default: false },
        domains: [{ type: String }],
        geoip:   [{ type: String }],
    },

    // Lower priority value = preferred; also determines chain order for forward mode
    priority: { type: Number, default: 100 },

    active: { type: Boolean, default: true },
    status: {
        type: String,
        enum: ['pending', 'deployed', 'online', 'offline', 'error'],
        default: 'pending',
    },
    lastError: { type: String, default: '' },
    lastHealthCheck: { type: Date, default: null },
    latencyMs: { type: Number, default: null },
}, { timestamps: true });

cascadeLinkSchema.index({ portalNode: 1 });
cascadeLinkSchema.index({ bridgeNode: 1 });
cascadeLinkSchema.index({ active: 1, status: 1 });

module.exports = mongoose.model('CascadeLink', cascadeLinkSchema);
