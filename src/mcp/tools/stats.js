/**
 * MCP Tools — Statistics and monitoring (included in query tool)
 */

const { z } = require('zod');
const HyUser = require('../../models/hyUserModel');
const HyNode = require('../../models/hyNodeModel');
const StatsSnapshot = require('../../models/statsSnapshotModel');

// ─── Schema ──────────────────────────────────────────────────────────────────

const queryStatsSchema = z.object({
    type: z.enum(['summary', 'traffic', 'nodes', 'online_users']).default('summary'),
    period: z.enum(['hourly', 'daily', 'monthly']).optional().default('daily'),
    limit: z.number().int().min(1).max(200).optional().default(48),
});

// ─── Handler ─────────────────────────────────────────────────────────────────

async function queryStats(args) {
    const parsed = queryStatsSchema.parse(args);

    switch (parsed.type) {
        case 'summary': {
            const [usersTotal, usersEnabled, nodesTotal, nodesOnline] = await Promise.all([
                HyUser.countDocuments({ isProbe: { $ne: true } }),
                HyUser.countDocuments({ enabled: true, isProbe: { $ne: true } }),
                HyNode.countDocuments(),
                HyNode.countDocuments({ status: 'online' }),
            ]);

            const nodes = await HyNode.find({ active: true }).select('name onlineUsers status traffic');
            const totalOnline = nodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);

            const syncService = require('../../services/syncService');

            return {
                users: { total: usersTotal, enabled: usersEnabled, disabled: usersTotal - usersEnabled },
                nodes: {
                    total: nodesTotal,
                    online: nodesOnline,
                    offline: nodesTotal - nodesOnline,
                    list: nodes.map(n => ({
                        name: n.name,
                        status: n.status,
                        online: n.onlineUsers || 0,
                        traffic: n.traffic,
                    })),
                },
                onlineUsers: totalOnline,
                lastSync: syncService.lastSyncTime,
                isSyncing: syncService.isSyncing,
            };
        }

        case 'online_users': {
            const nodes = await HyNode.find({ active: true, status: 'online' })
                .select('name onlineUsers');
            const perNode = nodes.map(n => ({ node: n.name, online: n.onlineUsers || 0 }));
            const total = perNode.reduce((s, n) => s + n.online, 0);
            return { total, perNode };
        }

        case 'traffic': {
            const snapshots = await StatsSnapshot.find({ period: parsed.period })
                .sort({ timestamp: -1 })
                .limit(parsed.limit)
                .lean();
            return { snapshots: snapshots.reverse() };
        }

        case 'nodes': {
            const nodes = await HyNode.find({ active: true })
                .select('name ip status onlineUsers traffic lastSync lastError type cascadeRole country')
                .populate('groups', 'name color')
                .lean();
            return { nodes };
        }

        default:
            throw new Error(`Unknown stats type: ${parsed.type}`);
    }
}

module.exports = {
    queryStats,
    schemas: { queryStats: queryStatsSchema },
};
