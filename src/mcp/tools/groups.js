/**
 * MCP Tools — Server group management
 * Tools: query (groups), manage_group
 */

const { z } = require('zod');
const ServerGroup = require('../../models/serverGroupModel');
const HyNode = require('../../models/hyNodeModel');
const HyUser = require('../../models/hyUserModel');
const cache = require('../../services/cacheService');
const logger = require('../../utils/logger');

// ─── Schemas ────────────────────────────────────────────────────────────────

const queryGroupsSchema = z.object({
    id: z.string().optional().describe('Group MongoDB _id to fetch'),
});

const manageGroupSchema = z.object({
    action: z.enum(['create', 'update', 'delete']),
    id: z.string().optional().describe('Group MongoDB _id (required for update/delete)'),
    data: z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        color: z.string().optional().describe('CSS color, e.g. #ff0000'),
        active: z.boolean().optional(),
        maxDevices: z.number().int().min(0).optional().describe('0 = unlimited'),
        subscriptionTitle: z.string().optional(),
    }).optional(),
});

// Invalidate every cache surface a group change can affect — mirrors the
// panel group handlers so REST/MCP/panel behave identically.
async function invalidateGroupCaches() {
    await Promise.all([
        cache.invalidateGroups(),
        cache.invalidateNodes(),
        cache.invalidateAllSubscriptions(),
        cache.invalidateDashboardCounts(),
    ]);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function queryGroups(args) {
    const parsed = queryGroupsSchema.parse(args);

    if (parsed.id) {
        const group = await ServerGroup.findById(parsed.id);
        if (!group) return { error: `Group '${parsed.id}' not found`, code: 404 };

        const [nodeCount, userCount] = await Promise.all([
            HyNode.countDocuments({ groups: group._id }),
            HyUser.countDocuments({ groups: group._id, isProbe: { $ne: true } }),
        ]);

        return { group: { ...group.toObject(), nodeCount, userCount } };
    }

    const groups = await ServerGroup.find({}).sort({ name: 1 });

    const result = await Promise.all(groups.map(async (g) => {
        const [nodeCount, userCount] = await Promise.all([
            HyNode.countDocuments({ groups: g._id }),
            HyUser.countDocuments({ groups: g._id, isProbe: { $ne: true } }),
        ]);
        return { ...g.toObject(), nodeCount, userCount };
    }));

    return { groups: result };
}

async function manageGroup(args) {
    const parsed = manageGroupSchema.parse(args);
    const { action, id, data = {} } = parsed;

    switch (action) {
        case 'create': {
            if (!data.name) throw new Error('name is required for create');
            const group = new ServerGroup({
                name: data.name,
                description: data.description || '',
                color: data.color || '#6366f1',
                active: data.active !== undefined ? data.active : true,
                maxDevices: data.maxDevices || 0,
                subscriptionTitle: data.subscriptionTitle || data.name,
            });
            await group.save();
            await invalidateGroupCaches();
            logger.info(`[MCP] Created group ${data.name}`);
            return { success: true, group };
        }

        case 'update': {
            if (!id) throw new Error('id is required for update');
            const updates = {};
            if (data.name !== undefined) updates.name = data.name;
            if (data.description !== undefined) updates.description = data.description;
            if (data.color !== undefined) updates.color = data.color;
            if (data.active !== undefined) updates.active = data.active;
            if (data.maxDevices !== undefined) updates.maxDevices = data.maxDevices;
            if (data.subscriptionTitle !== undefined) updates.subscriptionTitle = data.subscriptionTitle;

            const group = await ServerGroup.findByIdAndUpdate(id, { $set: updates }, { new: true });
            if (!group) return { error: `Group '${id}' not found`, code: 404 };
            await invalidateGroupCaches();
            logger.info(`[MCP] Updated group ${group.name}`);
            return { success: true, group };
        }

        case 'delete': {
            if (!id) throw new Error('id is required for delete');
            const group = await ServerGroup.findByIdAndDelete(id);
            if (!group) return { error: `Group '${id}' not found`, code: 404 };
            await HyNode.updateMany({ groups: group._id }, { $pull: { groups: group._id } });
            await HyUser.updateMany({ groups: group._id }, { $pull: { groups: group._id } });
            await invalidateGroupCaches();
            logger.info(`[MCP] Deleted group ${group.name}`);
            return { success: true, message: `Group '${group.name}' deleted` };
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

module.exports = {
    queryGroups,
    manageGroup,
    schemas: {
        queryGroups: queryGroupsSchema,
        manageGroup: manageGroupSchema,
    },
};
