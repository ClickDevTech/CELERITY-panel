/**
 * Cascade link model — represents a reverse-proxy tunnel between two Xray nodes.
 *
 * Portal (entry) accepts client traffic and proxies it via reverse tunnel.
 * Bridge (exit) initiates the tunnel to Portal and releases traffic to the internet.
 */

const mongoose = require('mongoose');

const cascadeLinkSchema = new mongoose.Schema({
    name: { type: String, required: true },

    portalNode: { type: mongoose.Schema.Types.ObjectId, ref: 'HyNode', required: true },
    bridgeNode: { type: mongoose.Schema.Types.ObjectId, ref: 'HyNode', required: true },

    tunnelUuid: { type: String, required: true },
    tunnelPort: { type: Number, default: 10086 },
    tunnelDomain: { type: String, default: 'reverse.tunnel.internal' },
    tunnelProtocol: { type: String, enum: ['vless', 'vmess'], default: 'vless' },
    tunnelSecurity: { type: String, enum: ['none', 'tls'], default: 'none' },
    tunnelTransport: { type: String, enum: ['tcp', 'ws', 'grpc'], default: 'tcp' },

    tcpFastOpen: { type: Boolean, default: true },
    tcpKeepAlive: { type: Number, default: 100 },
    tcpNoDelay: { type: Boolean, default: true },

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
