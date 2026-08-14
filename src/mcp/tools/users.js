/**
 * MCP Tools — User management
 * Tools: query (users), manage_user
 */

const { z } = require('zod');
const HyUser = require('../../models/hyUserModel');
const HyNode = require('../../models/hyNodeModel');
const UserDevice = require('../../models/userDeviceModel');
const hwidDeviceService = require('../../services/hwidDeviceService');
const cryptoService = require('../../services/cryptoService');
const cache = require('../../services/cacheService');
const logger = require('../../utils/logger');
const webhook = require('../../services/webhookService');
const expireScheduler = require('../../services/expireScheduler');
const { recomputeEnabled, isExpired, isOverLimit } = require('../../utils/userActivity');
const { sanitizeUserComment } = require('../../utils/textSanitize');

async function invalidateUserCache(userId, subscriptionToken) {
    await cache.invalidateUser(userId);
    if (subscriptionToken) await cache.invalidateSubscription(subscriptionToken);
    await cache.clearDeviceIPs(userId);
    await cache.invalidateDashboardCounts();
}

function getSyncService() {
    return require('../../services/syncService');
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const queryUsersSchema = z.object({
    id: z.string().optional().describe('Specific userId to fetch'),
    filter: z.object({
        enabled: z.boolean().optional(),
        group: z.string().optional(),
    }).optional(),
    limit: z.number().int().min(1).max(500).default(50),
    page: z.number().int().min(1).default(1),
    sortBy: z.enum(['createdAt', 'userId', 'username', 'traffic', 'enabled']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const manageUserSchema = z.object({
    action: z.enum(['create', 'update', 'delete', 'enable', 'disable', 'reset_traffic']),
    userId: z.string().optional(),
    data: z.object({
        username: z.string().optional(),
        comment: z.string().optional().describe('Free-form operator note (trimmed, max 500 chars)'),
        groups: z.array(z.string()).optional(),
        trafficLimit: z.number().min(0).optional().describe('Traffic limit in bytes, 0 = unlimited'),
        expireAt: z.string().datetime().nullable().optional(),
        maxDevices: z.number().int().min(0).optional().describe('0 = unlimited'),
        enabled: z.boolean().optional(),
        hwidMode: z.enum(['inherit', 'off', 'strict']).optional(),
        hwidEnforceFrom: z.string().nullable().optional(),
    }).optional(),
});

const manageHwidDevicesSchema = z.object({
    action: z.enum(['list', 'unlink', 'unlink_all']),
    userId: z.string(),
    hwid: z.string().optional(),
});

// ─── Handlers ────────────────────────────────────────────────────────────────

async function queryUsers(args) {
    const parsed = queryUsersSchema.parse(args);

    if (parsed.id) {
        const user = await HyUser.findOne({ userId: parsed.id })
            .populate('nodes', 'name ip domain port portRange')
            .populate('groups', 'name color');
        if (!user) return { error: `User '${parsed.id}' not found`, code: 404 };
        return { user };
    }

    // Hidden probe users never appear in listings or counts.
    const filter = { isProbe: { $ne: true } };
    if (parsed.filter?.enabled !== undefined) filter.enabled = parsed.filter.enabled;
    if (parsed.filter?.group) filter.groups = parsed.filter.group;

    const order = parsed.sortOrder === 'asc' ? 1 : -1;
    const skip = (parsed.page - 1) * parsed.limit;

    if (parsed.sortBy === 'traffic') {
        const pipeline = [
            { $match: filter },
            { $addFields: { totalTraffic: { $add: ['$traffic.tx', '$traffic.rx'] } } },
            { $sort: { totalTraffic: order } },
            { $skip: skip },
            { $limit: parsed.limit },
        ];
        const usersAgg = await HyUser.aggregate(pipeline);
        const users = await HyUser.populate(usersAgg, [
            { path: 'nodes', select: 'name ip' },
            { path: 'groups', select: 'name color' },
        ]);
        const total = await HyUser.countDocuments(filter);
        return { users, pagination: { page: parsed.page, limit: parsed.limit, total, pages: Math.ceil(total / parsed.limit) } };
    }

    const sortField = {
        userId: { userId: order },
        username: { username: order },
        enabled: { enabled: order },
        createdAt: { createdAt: order },
    }[parsed.sortBy] || { createdAt: order };

    const users = await HyUser.find(filter)
        .sort(sortField)
        .skip(skip)
        .limit(parsed.limit)
        .populate('nodes', 'name ip')
        .populate('groups', 'name color');

    const total = await HyUser.countDocuments(filter);

    return {
        users,
        pagination: { page: parsed.page, limit: parsed.limit, total, pages: Math.ceil(total / parsed.limit) },
    };
}

async function manageUser(args, emit) {
    const parsed = manageUserSchema.parse(args);
    const { action, userId, data = {} } = parsed;

    switch (action) {
        case 'create': {
            if (!userId) throw new Error('userId is required for create');
            const existing = await HyUser.findOne({ userId });
            if (existing) return { error: 'User already exists', code: 409, user: existing };

            const password = cryptoService.generatePassword(userId);
            const hm = data.hwidMode;
            const hwidMode = ['inherit', 'off', 'strict'].includes(String(hm)) ? hm : 'inherit';
            let hwidEnforceFrom = null;
            if (data.hwidEnforceFrom) {
                const d = new Date(data.hwidEnforceFrom);
                if (!Number.isNaN(d.getTime())) hwidEnforceFrom = d;
            }
            const user = new HyUser({
                userId,
                username: data.username || '',
                comment: sanitizeUserComment(data.comment),
                password,
                groups: data.groups || [],
                enabled: data.enabled !== undefined ? data.enabled : false,
                trafficLimit: data.trafficLimit || 0,
                expireAt: data.expireAt || null,
                maxDevices: data.maxDevices || 0,
                hwidMode,
                hwidEnforceFrom,
                nodes: [],
            });
            await user.save();
            logger.info(`[MCP] Created user ${userId}`);
            webhook.emit(webhook.EVENTS.USER_CREATED, { userId, username: data.username || '', groups: data.groups || [] });
            if (user.enabled) getSyncService().addUserToAllXrayNodes(user.toObject()).catch(() => {});
            if (user.expireAt) expireScheduler.notify(user.expireAt);
            emit('progress', { message: `User '${userId}' created` });
            return { success: true, user };
        }

        case 'update': {
            if (!userId) throw new Error('userId is required for update');
            const user = await HyUser.findOne({ userId });
            if (!user) return { error: `User '${userId}' not found`, code: 404 };

            const updates = {};
            if (data.enabled !== undefined) updates.enabled = data.enabled;
            if (data.username !== undefined) updates.username = data.username;
            if (data.comment !== undefined) updates.comment = sanitizeUserComment(data.comment);
            if (data.trafficLimit !== undefined) updates.trafficLimit = data.trafficLimit;
            if (data.expireAt !== undefined) updates.expireAt = data.expireAt;
            if (data.groups !== undefined) updates.groups = data.groups;
            if (data.maxDevices !== undefined) updates.maxDevices = data.maxDevices;
            if (data.hwidMode !== undefined) {
                const hm = String(data.hwidMode);
                if (['inherit', 'off', 'strict'].includes(hm)) updates.hwidMode = hm;
            }
            if (data.hwidEnforceFrom !== undefined) {
                updates.hwidEnforceFrom = data.hwidEnforceFrom
                    ? new Date(data.hwidEnforceFrom)
                    : null;
            }

            const prevObj = user.toObject();
            const wasEnabled = user.enabled;
            updates.enabled = recomputeEnabled(prevObj, updates);
            const nowEnabled = updates.enabled;

            const updated = await HyUser.findOneAndUpdate({ userId }, { $set: updates }, { new: true })
                .populate('nodes', 'name ip')
                .populate('groups', 'name color');

            await invalidateUserCache(userId, user.subscriptionToken);
            const limitTouched = updates.maxDevices !== undefined
                && updates.maxDevices !== user.maxDevices;
            const modeRelaxed = updates.hwidMode !== undefined
                && updates.hwidMode !== user.hwidMode
                && (updates.hwidMode === 'off' || updates.hwidMode === 'inherit');
            const enforceDelayed = Object.prototype.hasOwnProperty.call(updates, 'hwidEnforceFrom');
            if (limitTouched || modeRelaxed || enforceDelayed) {
                webhook.clearDeviceLimitNotified(userId);
            }

            // Sync Xray runtime when enabled flips (was previously missing here).
            if (wasEnabled !== nowEnabled) {
                const sync = getSyncService();
                const merged = { ...prevObj, ...updates };
                if (nowEnabled) {
                    sync.addUserToAllXrayNodes(merged).catch(() => {});
                    webhook.emit(webhook.EVENTS.USER_ENABLED, { userId });
                } else {
                    sync.removeUserFromAllXrayNodes(merged).catch(() => {});
                    webhook.emit(webhook.EVENTS.USER_DISABLED, { userId });
                }
            }

            if (Object.prototype.hasOwnProperty.call(updates, 'expireAt')) {
                expireScheduler.notify(updates.expireAt);
            }

            logger.info(`[MCP] Updated user ${userId}`);
            webhook.emit(webhook.EVENTS.USER_UPDATED, { userId, updates });
            return { success: true, user: updated };
        }

        case 'delete': {
            if (!userId) throw new Error('userId is required for delete');
            const user = await HyUser.findOneAndDelete({ userId });
            if (!user) return { error: `User '${userId}' not found`, code: 404 };
            await UserDevice.deleteMany({ userId });
            getSyncService().removeUserFromAllXrayNodes(user.toObject()).catch(() => {});
            await invalidateUserCache(userId, user.subscriptionToken);
            webhook.clearDeviceLimitNotified(userId);
            logger.info(`[MCP] Deleted user ${userId}`);
            webhook.emit(webhook.EVENTS.USER_DELETED, { userId });
            return { success: true, message: `User '${userId}' deleted` };
        }

        case 'enable': {
            if (!userId) throw new Error('userId is required for enable');
            const user = await HyUser.findOneAndUpdate({ userId }, { $set: { enabled: true } }, { new: true });
            if (!user) return { error: `User '${userId}' not found`, code: 404 };
            getSyncService().addUserToAllXrayNodes(user.toObject()).catch(() => {});
            await invalidateUserCache(userId, user.subscriptionToken);
            logger.info(`[MCP] Enabled user ${userId}`);
            webhook.emit(webhook.EVENTS.USER_ENABLED, { userId });
            return { success: true, user };
        }

        case 'disable': {
            if (!userId) throw new Error('userId is required for disable');
            const user = await HyUser.findOneAndUpdate({ userId }, { $set: { enabled: false } }, { new: true });
            if (!user) return { error: `User '${userId}' not found`, code: 404 };
            getSyncService().removeUserFromAllXrayNodes(user.toObject()).catch(() => {});
            await invalidateUserCache(userId, user.subscriptionToken);
            logger.info(`[MCP] Disabled user ${userId}`);
            webhook.emit(webhook.EVENTS.USER_DISABLED, { userId });
            return { success: true, user };
        }

        case 'reset_traffic': {
            if (!userId) throw new Error('userId is required for reset_traffic');
            const prev = await HyUser.findOne({ userId });
            if (!prev) return { error: `User '${userId}' not found`, code: 404 };

            const set = { 'traffic.tx': 0, 'traffic.rx': 0 };

            // Renewal-by-reset: if this user was disabled and the zeroed
            // counter makes them healthy again, flip enabled back on in the
            // same write so we don't race with concurrent stats cycles.
            const merged = { ...prev.toObject(), traffic: { tx: 0, rx: 0 } };
            const autoEnable = !prev.enabled && !isExpired(merged) && !isOverLimit(merged);
            if (autoEnable) set.enabled = true;

            const user = await HyUser.findOneAndUpdate(
                { userId },
                { $set: set },
                { new: true }
            );

            await invalidateUserCache(userId, user.subscriptionToken);

            if (autoEnable) {
                getSyncService().addUserToAllXrayNodes(user.toObject()).catch(() => {});
                webhook.emit(webhook.EVENTS.USER_ENABLED, { userId });
            }

            logger.info(`[MCP] Reset traffic for user ${userId}${autoEnable ? ' (auto-enabled)' : ''}`);
            return { success: true, message: `Traffic reset for '${userId}'`, user };
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

/**
 * MCP: list / unlink HWID devices
 */
async function manageHwidDevices(args) {
    const parsed = manageHwidDevicesSchema.parse(args);
    const { action, userId, hwid } = parsed;

    const user = await HyUser.findOne({ userId }).select('userId subscriptionToken').lean();
    if (!user) return { error: `User '${userId}' not found`, code: 404 };

    switch (action) {
        case 'list': {
            const devices = await hwidDeviceService.listDevices(userId);
            const full = await HyUser.findOne({ userId }).populate('groups', 'maxDevices').lean();
            const limit = hwidDeviceService.effectiveDeviceLimit(full);
            return { userId, count: devices.length, limit, devices };
        }
        case 'unlink': {
            if (!hwid) throw new Error('hwid is required for unlink');
            const r = await UserDevice.deleteOne({ userId, hwid });
            if (r.deletedCount === 0) return { error: 'Device not found', code: 404 };
            await hwidDeviceService.invalidateCountCache(userId);
            await invalidateUserCache(userId, user.subscriptionToken);
            webhook.clearDeviceLimitNotified(userId);
            return { success: true, userId, hwid };
        }
        case 'unlink_all': {
            await UserDevice.deleteMany({ userId });
            await hwidDeviceService.invalidateCountCache(userId);
            await invalidateUserCache(userId, user.subscriptionToken);
            webhook.clearDeviceLimitNotified(userId);
            return { success: true, userId, message: 'All HWID devices removed' };
        }
        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

module.exports = {
    queryUsers,
    manageUser,
    manageHwidDevices,
    schemas: {
        queryUsers: queryUsersSchema,
        manageUser: manageUserSchema,
        manageHwidDevices: manageHwidDevicesSchema,
    },
};
