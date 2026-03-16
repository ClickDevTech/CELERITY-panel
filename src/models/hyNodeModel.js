/**
 * Hysteria + Xray node model with cascade topology support
 */

const mongoose = require('mongoose');

const portConfigSchema = new mongoose.Schema({
    name: { type: String, default: '' },
    port: { type: Number, required: true },
    portRange: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
}, { _id: false });

const outboundSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: { type: String, enum: ['direct', 'socks5', 'http'], required: true },
    addr: { type: String, default: '' },
    username: { type: String, default: '' },
    password: { type: String, default: '' },
}, { _id: false });

const xrayConfigSchema = new mongoose.Schema({
    // Transport: tcp, ws, grpc, xhttp (splithttp)
    transport: { type: String, enum: ['tcp', 'ws', 'grpc', 'xhttp'], default: 'tcp' },
    // Security: reality (no cert needed), tls (cert files), none
    security: { type: String, enum: ['reality', 'tls', 'none'], default: 'reality' },
    // XTLS flow — only for tcp+reality/tls
    flow: { type: String, default: 'xtls-rprx-vision' },

    // TLS Fingerprint (uTLS) — chrome, firefox, safari, ios, android, edge, random, randomized
    fingerprint: { type: String, default: 'chrome' },
    // ALPN — comma-separated or array: h3, h2, http/1.1
    alpn: { type: [String], default: [] },

    // Reality-specific
    realityDest: { type: String, default: 'www.google.com:443' },
    realitySni: { type: [String], default: ['www.google.com'] },
    realityPrivateKey: { type: String, default: '' },
    realityPublicKey: { type: String, default: '' },
    realityShortIds: { type: [String], default: [''] },
    realitySpiderX: { type: String, default: '/' },

    // WebSocket-specific
    wsPath: { type: String, default: '/' },
    wsHost: { type: String, default: '' },

    // gRPC-specific
    grpcServiceName: { type: String, default: 'grpc' },

    // xhttp (splithttp) specific
    xhttpPath: { type: String, default: '/' },
    xhttpHost: { type: String, default: '' },
    xhttpMode: { type: String, enum: ['auto', 'packet-up', 'stream-up'], default: 'auto' },

    // gRPC API port for user management (local, not exposed)
    apiPort: { type: Number, default: 61000 },

    // Inbound tag used in config and API calls
    inboundTag: { type: String, default: 'vless-in' },

    // CC Agent settings
    agentPort: { type: Number, default: 62080 },
    agentToken: { type: String, default: '' },
    agentTls: { type: Boolean, default: true },
}, { _id: false });

const hyNodeSchema = new mongoose.Schema({
    // 'hysteria' (default) or 'xray'
    type: { type: String, enum: ['hysteria', 'xray'], default: 'hysteria' },

    name: { type: String, required: true },
    flag: { type: String, default: '' },
    ip: { type: String, required: true, unique: true },
    domain: { type: String, default: '' },
    sni: { type: String, default: '' },
    port: { type: Number, default: 443 },
    portRange: { type: String, default: '20000-50000' },
    portConfigs: { type: [portConfigSchema], default: [] },
    obfs: {
        type: { type: String, enum: ['', 'salamander'], default: '' },
        password: { type: String, default: '' },
    },
    statsPort: { type: Number, default: 9999 },
    statsSecret: { type: String, default: '' },

    // Xray-specific configuration (only used when type === 'xray')
    xray: { type: xrayConfigSchema, default: () => ({}) },
    
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServerGroup',
    }],
    
    ssh: {
        port: { type: Number, default: 22 },
        username: { type: String, default: 'root' },
        privateKey: { type: String, default: '' },
        password: { type: String, default: '' },
    },
    
    paths: {
        config: { type: String, default: '/etc/hysteria/config.yaml' },
        cert: { type: String, default: '/etc/hysteria/cert.pem' },
        key: { type: String, default: '/etc/hysteria/key.pem' },
    },
    
    outbounds: { type: [outboundSchema], default: [] },
    aclRules: { type: [String], default: [] },
    
    active: { type: Boolean, default: true },
    status: { type: String, enum: ['online', 'offline', 'error', 'syncing'], default: 'offline' },
    lastError: { type: String, default: '' },
    lastSync: { type: Date, default: null },

    // Agent & Xray version info (populated by health checks)
    xrayVersion: { type: String, default: '' },
    agentVersion: { type: String, default: '' },
    agentStatus: { type: String, enum: ['online', 'offline', 'unknown'], default: 'unknown' },
    agentLastSeen: { type: Date, default: null },
    onlineUsers: { type: Number, default: 0 },
    maxOnlineUsers: { type: Number, default: 0 },
    healthFailures: { type: Number, default: 0 },
    
    traffic: {
        tx: { type: Number, default: 0 },
        rx: { type: Number, default: 0 },
        lastUpdate: { type: Date, default: null },
    },
    
    rankingCoefficient: { type: Number, default: 1.0 },
    settings: { type: Object, default: {} },
    customConfig: { type: String, default: '' },
    useCustomConfig: { type: Boolean, default: false },
    useTlsFiles: { type: Boolean, default: false },

    // Cascade topology fields
    cascadeRole: {
        type: String,
        enum: ['standalone', 'entry', 'relay', 'exit'],
        default: 'standalone',
    },
    mapPosition: {
        x: { type: Number, default: null },
        y: { type: Number, default: null },
    },
    country: { type: String, default: '' },

}, { timestamps: true });

hyNodeSchema.index({ active: 1 });
hyNodeSchema.index({ groups: 1 });
hyNodeSchema.index({ status: 1 });

hyNodeSchema.virtual('serverAddress').get(function() {
    const host = this.domain || this.ip;
    return `${host}:${this.portRange}`;
});

hyNodeSchema.methods.getSubscriptionAddress = function() {
    const host = this.domain || this.ip;
    if (this.portRange && this.portRange.includes('-')) {
        return `${host}:${this.portRange}`;
    }
    return `${host}:${this.port}`;
};

module.exports = mongoose.model('HyNode', hyNodeSchema);

