/**
 * MCP Tools — Cascade link management and topology
 * Tools: query (cascade), manage_cascade, get_topology
 */

const { z } = require('zod');
const CascadeLink = require('../../models/cascadeLinkModel');
const HyNode = require('../../models/hyNodeModel');
const cascadeService = require('../../services/cascadeService');
const cache = require('../../services/cacheService');
const logger = require('../../utils/logger');
const { isServerlessNode } = require('../../utils/nodeTypes');

async function invalidateCascadeCache() {
    await cache.invalidateAllSubscriptions();
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const queryCascadeSchema = z.object({
    id: z.string().optional().describe('Cascade link MongoDB _id'),
    filter: z.object({
        nodeId: z.string().optional().describe('Filter by portal or bridge node ID'),
        status: z.string().optional(),
        active: z.boolean().optional(),
    }).optional(),
});

const manageCascadeSchema = z.object({
    action: z.enum(['create', 'update', 'delete', 'deploy', 'undeploy', 'reconnect']),
    id: z.string().optional().describe('Link _id (required for all except create)'),
    data: z.object({
        name: z.string().optional(),
        portalNodeId: z.string().optional(),
        bridgeNodeId: z.string().optional(),
        tunnelPort: z.number().int().min(1).max(65535).optional(),
        tunnelProtocol: z.enum(['vless', 'vmess']).optional(),
        tunnelSecurity: z.enum(['none', 'tls', 'reality']).optional(),
        tunnelTransport: z.enum(['tcp', 'ws', 'grpc', 'splithttp']).optional(),
        mode: z.enum(['reverse', 'forward']).optional(),
        priority: z.number().int().optional(),
    }).optional(),
});

const getTopologySchema = z.object({});

// ─── Handlers ────────────────────────────────────────────────────────────────

async function queryCascade(args) {
    const parsed = queryCascadeSchema.parse(args);

    if (parsed.id) {
        const link = await CascadeLink.findById(parsed.id)
            .populate('portalNode', 'name ip status')
            .populate('bridgeNode', 'name ip status');
        if (!link) return { error: `Cascade link '${parsed.id}' not found`, code: 404 };
        return { link };
    }

    const filter = {};
    if (parsed.filter?.active !== undefined) filter.active = parsed.filter.active;
    if (parsed.filter?.status) filter.status = parsed.filter.status;
    if (parsed.filter?.nodeId) {
        filter.$or = [{ portalNode: parsed.filter.nodeId }, { bridgeNode: parsed.filter.nodeId }];
    }

    const links = await CascadeLink.find(filter)
        .populate('portalNode', 'name ip status')
        .populate('bridgeNode', 'name ip status')
        .sort({ createdAt: -1 });

    return { links };
}

async function manageCascade(args, emit) {
    const parsed = manageCascadeSchema.parse(args);
    const { action, id, data = {} } = parsed;

    switch (action) {
        case 'create': {
            if (!data.name || !data.portalNodeId || !data.bridgeNodeId) {
                throw new Error('name, portalNodeId, and bridgeNodeId are required for create');
            }

            const [portalNode, bridgeNode] = await Promise.all([
                HyNode.findById(data.portalNodeId),
                HyNode.findById(data.bridgeNodeId),
            ]);
            if (!portalNode) return { error: 'Portal node not found', code: 404 };
            if (!bridgeNode) return { error: 'Bridge node not found', code: 404 };
            if (data.portalNodeId === data.bridgeNodeId) {
                return { error: 'Portal and Bridge must be different nodes', code: 400 };
            }
            // Same rule as the REST route: a tunnel needs two reachable hosts,
            // and CDN/virtual nodes have neither an IP nor SSH credentials.
            if (isServerlessNode(portalNode) || isServerlessNode(bridgeNode)) {
                return { error: 'Serverless nodes cannot participate in cascade links', code: 400 };
            }

            const port = data.tunnelPort || 10086;
            const linkMode = data.mode || 'reverse';
            const sec = data.tunnelSecurity || 'none';
            const trans = data.tunnelTransport || 'tcp';

            if (sec === 'reality' && trans === 'ws') {
                return { error: 'REALITY is not compatible with WebSocket transport', code: 400 };
            }

            const portCheckField = linkMode === 'forward' ? 'bridgeNode' : 'portalNode';
            const portCheckId = linkMode === 'forward' ? data.bridgeNodeId : data.portalNodeId;
            const conflict = await CascadeLink.findOne({ [portCheckField]: portCheckId, tunnelPort: port, active: true });
            if (conflict) {
                return { error: `Port ${port} is already used by link "${conflict.name}"`, code: 409 };
            }

            const crypto = require('crypto');
            const link = await CascadeLink.create({
                name: data.name,
                mode: linkMode,
                portalNode: data.portalNodeId,
                bridgeNode: data.bridgeNodeId,
                tunnelUuid: crypto.randomUUID(),
                tunnelPort: port,
                tunnelDomain: 'reverse.tunnel.internal',
                tunnelProtocol: data.tunnelProtocol || 'vless',
                tunnelSecurity: sec,
                tunnelTransport: trans,
                priority: data.priority || 100,
                tcpFastOpen: true,
                tcpKeepAlive: 100,
                tcpNoDelay: true,
                wsPath: '/cascade',
                grpcServiceName: 'cascade',
                xhttpPath: '/cascade',
                xhttpMode: 'auto',
                muxEnabled: false,
                muxConcurrency: 8,
            });

            await invalidateCascadeCache();
            logger.info(`[MCP] Created cascade link ${data.name}: ${portalNode.name} -> ${bridgeNode.name}`);

            const populated = await CascadeLink.findById(link._id)
                .populate('portalNode', 'name ip status')
                .populate('bridgeNode', 'name ip status');

            return { success: true, link: populated };
        }

        case 'update': {
            if (!id) throw new Error('id is required for update');
            const allowed = ['name', 'tunnelPort', 'tunnelProtocol', 'tunnelSecurity', 'tunnelTransport', 'mode', 'priority'];
            const updates = {};
            for (const k of allowed) {
                if (data[k] !== undefined) updates[k] = data[k];
            }
            const link = await CascadeLink.findByIdAndUpdate(id, { $set: updates }, { new: true })
                .populate('portalNode', 'name ip status')
                .populate('bridgeNode', 'name ip status');
            if (!link) return { error: `Cascade link '${id}' not found`, code: 404 };
            await invalidateCascadeCache();
            return { success: true, link };
        }

        case 'delete': {
            if (!id) throw new Error('id is required for delete');
            const link = await CascadeLink.findById(id);
            if (!link) return { error: `Cascade link '${id}' not found`, code: 404 };
            if (link.status === 'active') {
                emit('progress', { message: 'Undeploying before delete...' });
                await cascadeService.undeployLink(link).catch(() => {});
            }
            await CascadeLink.findByIdAndDelete(id);
            await invalidateCascadeCache();
            logger.info(`[MCP] Deleted cascade link ${link.name}`);
            return { success: true, message: `Link '${link.name}' deleted` };
        }

        case 'deploy': {
            if (!id) throw new Error('id is required for deploy');
            const link = await CascadeLink.findById(id)
                .populate('portalNode')
                .populate('bridgeNode');
            if (!link) return { error: `Cascade link '${id}' not found`, code: 404 };
            if (isServerlessNode(link.portalNode) || isServerlessNode(link.bridgeNode)) {
                return { error: 'Serverless nodes cannot participate in cascade links', code: 400 };
            }

            emit('progress', { message: `Deploying cascade link '${link.name}'...` });
            const result = await cascadeService.deployLink(link);

            if (result.success) {
                logger.info(`[MCP] Deployed cascade link ${link.name}`);
                return { success: true, message: `Link '${link.name}' deployed` };
            }
            return { success: false, error: result.error };
        }

        case 'undeploy': {
            if (!id) throw new Error('id is required for undeploy');
            const link = await CascadeLink.findById(id)
                .populate('portalNode')
                .populate('bridgeNode');
            if (!link) return { error: `Cascade link '${id}' not found`, code: 404 };

            emit('progress', { message: `Undeploying cascade link '${link.name}'...` });
            await cascadeService.undeployLink(link);
            return { success: true, message: `Link '${link.name}' undeployed` };
        }

        case 'reconnect': {
            if (!id) throw new Error('id is required for reconnect');
            const link = await CascadeLink.findById(id)
                .populate('portalNode')
                .populate('bridgeNode');
            if (!link) return { error: `Cascade link '${id}' not found`, code: 404 };
            if (isServerlessNode(link.portalNode) || isServerlessNode(link.bridgeNode)) {
                return { error: 'Serverless nodes cannot participate in cascade links', code: 400 };
            }

            emit('progress', { message: `Reconnecting cascade link '${link.name}'...` });
            await cascadeService.deployLink(link);
            return { success: true, message: `Link '${link.name}' reconnection triggered` };
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

async function getTopology() {
    const [nodes, links] = await Promise.all([
        HyNode.find({ active: true }).select('name ip status cascadeRole country type').lean(),
        CascadeLink.find({})
            .populate('portalNode', 'name ip status')
            .populate('bridgeNode', 'name ip status')
            .lean(),
    ]);

    return {
        nodes,
        links: links.map(l => ({
            _id: l._id,
            name: l.name,
            status: l.status,
            mode: l.mode,
            tunnelPort: l.tunnelPort,
            portal: l.portalNode ? { _id: l.portalNode._id, name: l.portalNode.name } : null,
            bridge: l.bridgeNode ? { _id: l.bridgeNode._id, name: l.bridgeNode.name } : null,
        })),
    };
}

module.exports = {
    queryCascade,
    manageCascade,
    getTopology,
    schemas: {
        queryCascade: queryCascadeSchema,
        manageCascade: manageCascadeSchema,
        getTopology: getTopologySchema,
    },
};
