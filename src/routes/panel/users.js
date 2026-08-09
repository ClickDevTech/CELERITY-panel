const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const HyUser = require('../../models/hyUserModel');
const HyNode = require('../../models/hyNodeModel');
const ServerGroup = require('../../models/serverGroupModel');
const cryptoService = require('../../services/cryptoService');
const syncService = require('../../services/syncService');
const expireScheduler = require('../../services/expireScheduler');
const hwidDeviceService = require('../../services/hwidDeviceService');
const webhookService = require('../../services/webhookService');
const { render } = require('./helpers');
const { getActiveGroups, invalidateGroupsCache, getSettings, invalidateUserCache, invalidateNodesCache } = require('../../utils/helpers');
const { recomputeEnabled } = require('../../utils/userActivity');
const logger = require('../../utils/logger');

// Whether the global HWID feature is enabled (permissive/strict).
// Controls visibility of HWID UI in user form and detail.
async function isHwidFeatureEnabled() {
    const s = await getSettings();
    const m = s?.subscription?.happ?.hwid?.mode || 'off';
    return m === 'permissive' || m === 'strict';
}

// ==================== USERS ====================

// GET /users - User list (with search and sorting)
router.get('/users', async (req, res) => {
    try {
        const { enabled, group, page = 1, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
        const limit = 50;
        
        // Hidden probe users never appear in listings or counts.
        const filter = { isProbe: { $ne: true } };
        if (enabled !== undefined) filter.enabled = enabled === 'true';
        if (group) filter.groups = new mongoose.Types.ObjectId(group);
        
        if (search && search.trim()) {
            const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const searchRegex = new RegExp(escaped, 'i');
            filter.$or = [
                { userId: searchRegex },
                { username: searchRegex }
            ];
        }
        
        let users;
        const order = sortOrder === 'asc' ? 1 : -1;
        
        if (sortBy === 'traffic') {
            const pipeline = [
                { $match: filter },
                {
                    $addFields: {
                        totalTraffic: { $add: [{ $ifNull: ['$traffic.tx', 0] }, { $ifNull: ['$traffic.rx', 0] }] }
                    }
                },
                { $sort: { totalTraffic: order } },
                { $skip: (page - 1) * limit },
                { $limit: limit }
            ];
            
            const usersAggregated = await HyUser.aggregate(pipeline);
            users = await HyUser.populate(usersAggregated, [
                { path: 'groups', select: 'name color' }
            ]);
        } else {
            let sortField = {};
            switch (sortBy) {
                case 'userId':
                    sortField = { userId: order };
                    break;
                case 'username':
                    sortField = { username: order };
                    break;
                case 'enabled':
                    sortField = { enabled: order };
                    break;
                case 'createdAt':
                default:
                    sortField = { createdAt: order };
                    break;
            }
            
            users = await HyUser.find(filter)
                .sort(sortField)
                .skip((page - 1) * limit)
                .limit(limit)
                .populate('groups', 'name color')
                .lean();
        }
        
        const [total, groups] = await Promise.all([
            HyUser.countDocuments(filter),
            getActiveGroups(),
        ]);
        
        render(res, 'users', {
            title: res.locals.locales.users.title,
            page: 'users',
            users,
            groups,
            pagination: {
                page: parseInt(page),
                limit,
                total,
                pages: Math.ceil(total / limit),
            },
            query: req.query,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// GET /users/add - Create user form
router.get('/users/add', async (req, res) => {
    try {
        const [groups, hwidEnabled] = await Promise.all([
            getActiveGroups(),
            isHwidFeatureEnabled(),
        ]);
        render(res, 'user-form', {
            title: res.locals.locales.users.newUser,
            page: 'users',
            groups,
            isEdit: false,
            user: null,
            error: null,
            hwidEnabled,
        });
    } catch (error) {
        logger.error('[Panel] GET /users/add error:', error.message);
        res.status(500).send('Error: ' + error.message);
    }
});

// GET /users/:userId/edit - Edit user form
router.get('/users/:userId/edit', async (req, res) => {
    try {
        const [user, groups, hwidEnabled] = await Promise.all([
            HyUser.findOne({ userId: req.params.userId }).populate('groups', 'name color'),
            getActiveGroups(),
            isHwidFeatureEnabled(),
        ]);

        if (!user) {
            return res.redirect('/panel/users');
        }

        render(res, 'user-form', {
            title: `Редактирование ${user.userId}`,
            page: 'users',
            groups,
            user,
            isEdit: true,
            error: null,
            hwidEnabled,
        });
    } catch (error) {
        res.status(500).send(`${res.locals.t?.('common.error') || 'Error'}: ${error.message}`);
    }
});

// POST /users - Create user
router.post('/users', async (req, res) => {
    try {
        const { userId, username, trafficLimitGB, expireDays, expireAt: expireAtRaw, enabled, maxDevices } = req.body;
        
        if (!userId) {
            return res.status(400).send('userId обязателен');
        }
        
        const existing = await HyUser.findOne({ userId });
        if (existing) {
            return res.status(409).send('Пользователь уже существует');
        }
        
        const password = cryptoService.generatePassword(userId);
        
        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }
        
        let expireAt = null;
        const hasExpireAt = typeof expireAtRaw === 'string' && expireAtRaw.trim() !== '';

        if (hasExpireAt) {
            const parsedExpireAt = new Date(expireAtRaw);

            if (Number.isNaN(parsedExpireAt.getTime())) {
                return res.status(400).send('Некорректный формат даты/времени окончания');
            }

            if (parsedExpireAt.getTime() < Date.now()) {
                return res.status(400).send('Дата/время окончания не может быть в прошлом');
            }

            expireAt = parsedExpireAt;
        } else if (expireDays && parseInt(expireDays) > 0) {
            expireAt = new Date();
            expireAt.setDate(expireAt.getDate() + parseInt(expireDays));
        }
        
        const trafficLimit = (parseInt(trafficLimitGB, 10) || 0) * 1024 * 1024 * 1024;
        
        const userMaxDevices = parseInt(maxDevices) || 0;

        const hm = req.body.hwidMode;
        const hwidMode = ['inherit', 'off', 'strict'].includes(String(hm)) ? hm : 'inherit';
        let hwidEnforceFrom = null;
        if (req.body.hwidEnforceFrom) {
            const d = new Date(req.body.hwidEnforceFrom);
            if (!Number.isNaN(d.getTime())) hwidEnforceFrom = d;
        }
        
        const newUser = await HyUser.create({
            userId,
            username: username || '',
            password,
            groups,
            enabled: enabled === 'on',
            trafficLimit,
            maxDevices: userMaxDevices,
            hwidMode,
            hwidEnforceFrom,
            expireAt,
            nodes: [],
        });

        await invalidateUserCache(userId, newUser.subscriptionToken);

        if (newUser.enabled) {
            syncService.addUserToAllXrayNodes(newUser.toObject()).catch(err => {
                logger.error(`[Panel] Xray addUser error for ${userId}: ${err.message}`);
            });
        }

        // Arm the scheduler on the new expiry if it is the earliest upcoming.
        if (newUser.expireAt) expireScheduler.notify(newUser.expireAt);

        webhookService.emit(webhookService.EVENTS.USER_CREATED, {
            userId,
            username: username || '',
            groups,
        });

        res.redirect(`/panel/users/${userId}`);
    } catch (error) {
        res.status(500).send(`${res.locals.t?.('common.error') || 'Error'}: ${error.message}`);
    }
});

// POST /users/:userId - Update user
router.post('/users/:userId', async (req, res) => {
    try {
        const { username, trafficLimitGB, expireDays, expireAt: expireAtRaw, enabled, maxDevices } = req.body;
        const [user, availableGroups] = await Promise.all([
            HyUser.findOne({ userId: req.params.userId }),
            getActiveGroups(),
        ]);

        if (!user) {
            return res.redirect('/panel/users');
        }

        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }

        const trafficLimit = (parseInt(trafficLimitGB, 10) || 0) * 1024 * 1024 * 1024;
        const userMaxDevices = parseInt(maxDevices, 10) || 0;
        const draftUser = {
            ...user.toObject(),
            username: username || '',
            groups,
            enabled: enabled === 'on',
            trafficLimit,
            maxDevices: userMaxDevices,
            hwidMode: ['inherit', 'off', 'strict'].includes(String(req.body.hwidMode)) ? req.body.hwidMode : (user.hwidMode || 'inherit'),
            hwidEnforceFrom: req.body.hwidEnforceFrom || user.hwidEnforceFrom,
            expireAt: expireAtRaw,
        };

        let expireAt = null;
        const hasExpireAt = typeof expireAtRaw === 'string' && expireAtRaw.trim() !== '';

        if (hasExpireAt) {
            const parsedExpireAt = new Date(expireAtRaw);

            if (Number.isNaN(parsedExpireAt.getTime())) {
                draftUser.expireAt = null;
                return render(res, 'user-form', {
                    title: res.locals.t('users.editUser') + ' ' + req.params.userId,
                    page: 'users',
                    groups: availableGroups,
                    user: draftUser,
                    isEdit: true,
                    error: res.locals.t('users.expireAtInvalidError'),
                    hwidEnabled: await isHwidFeatureEnabled(),
                });
            }

            expireAt = parsedExpireAt;
            draftUser.expireAt = parsedExpireAt;
        } else if (expireDays && parseInt(expireDays, 10) > 0) {
            expireAt = new Date();
            expireAt.setDate(expireAt.getDate() + parseInt(expireDays, 10));
            draftUser.expireAt = expireAt;
        } else {
            draftUser.expireAt = null;
        }

        const updates = {
            username: username || '',
            groups,
            trafficLimit,
            expireAt,
            maxDevices: userMaxDevices,
        };

        // Only forward `enabled` when the checkbox state actually differs from
        // the stored value, so recomputeEnabled can auto-reenable on renewal
        // when the admin only moved expireAt/trafficLimit.
        const formEnabled = enabled === 'on';
        if (formEnabled !== user.enabled) updates.enabled = formEnabled;

        const hm = req.body.hwidMode;
        if (['inherit', 'off', 'strict'].includes(String(hm))) {
            updates.hwidMode = hm;
        }
        if (Object.prototype.hasOwnProperty.call(req.body, 'hwidEnforceFrom')) {
            if (!req.body.hwidEnforceFrom) {
                updates.hwidEnforceFrom = null;
            } else {
                const d = new Date(req.body.hwidEnforceFrom);
                updates.hwidEnforceFrom = Number.isNaN(d.getTime()) ? null : d;
            }
        }

        const prevObj = user.toObject();
        updates.enabled = recomputeEnabled(prevObj, updates);

        const wasEnabled = user.enabled;
        const nowEnabled = updates.enabled;

        await HyUser.findOneAndUpdate({ userId: req.params.userId }, { $set: updates });

        await invalidateUserCache(req.params.userId, user.subscriptionToken);

        const limitTouched = updates.maxDevices !== user.maxDevices;
        const modeChanged = updates.hwidMode !== undefined && updates.hwidMode !== user.hwidMode;
        const enforceTouched = Object.prototype.hasOwnProperty.call(updates, 'hwidEnforceFrom');
        if (limitTouched || modeChanged || enforceTouched) {
            webhookService.clearDeviceLimitNotified(req.params.userId);
        }

        if (wasEnabled !== nowEnabled) {
            const updatedUser = { ...prevObj, ...updates };
            if (nowEnabled) {
                syncService.addUserToAllXrayNodes(updatedUser).catch(err => {
                    logger.error(`[Panel] Xray addUser error for ${req.params.userId}: ${err.message}`);
                });
                webhookService.emit(webhookService.EVENTS.USER_ENABLED, { userId: req.params.userId });
            } else {
                syncService.removeUserFromAllXrayNodes(updatedUser).catch(err => {
                    logger.error(`[Panel] Xray removeUser error for ${req.params.userId}: ${err.message}`);
                });
                webhookService.emit(webhookService.EVENTS.USER_DISABLED, { userId: req.params.userId });
            }
        }

        // Reschedule the expiry timer if the new expireAt could become the next event.
        if (Object.prototype.hasOwnProperty.call(updates, 'expireAt')) {
            expireScheduler.notify(updates.expireAt);
        }

        webhookService.emit(webhookService.EVENTS.USER_UPDATED, { userId: req.params.userId, updates });

        res.redirect(`/panel/users/${req.params.userId}`);
    } catch (error) {
        res.status(500).send(`${res.locals.t?.('common.error') || 'Error'}: ${error.message}`);
    }
});

// GET /users/:userId - User details
router.get('/users/:userId', async (req, res) => {
    try {
        const [user, allGroups] = await Promise.all([
            HyUser.findOne({ userId: req.params.userId })
                .populate('nodes', 'name ip domain active groups')
                .populate('groups', 'name color maxDevices'),
            getActiveGroups(),
        ]);

        if (!user) {
            return res.redirect('/panel/users');
        }

        const settings = await getSettings();
        const hwidGlobalMode = settings?.subscription?.happ?.hwid?.mode || 'off';
        const hwidEnabled = hwidGlobalMode === 'permissive' || hwidGlobalMode === 'strict';

        const [hwidDevices, hwidCount] = hwidEnabled
            ? await Promise.all([
                hwidDeviceService.listDevices(user.userId),
                hwidDeviceService.getDeviceCount(user.userId),
            ])
            : [[], 0];
        const hwidLimit = hwidEnabled ? hwidDeviceService.effectiveDeviceLimit(user.toObject()) : 0;
        
        let effectiveNodes = [];
        const directNodes = (user.nodes || []).filter(n => n && n.active);
        if (directNodes.length > 0) {
            effectiveNodes = directNodes;
        } else if (user.groups && user.groups.length > 0) {
            effectiveNodes = await HyNode.find({ active: true, groups: { $in: user.groups } })
                .select('name ip domain type groups').lean();
        }
        
        render(res, 'user-detail', {
            title: `Пользователь ${user.userId}`,
            page: 'users',
            user,
            allGroups,
            effectiveNodes,
            hwidDevices,
            hwidCount,
            hwidLimit,
            hwidEnabled,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// ==================== GROUPS ====================

// GET /groups - Group list
router.get('/groups', async (req, res) => {
    try {
        const groups = await ServerGroup.find().sort({ name: 1 });

        const groupIds = groups.map((group) => group._id);
        let nodeCountMap = new Map();
        let userCountMap = new Map();

        if (groupIds.length > 0) {
            const [nodeCounts, userCounts] = await Promise.all([
                HyNode.aggregate([
                    { $match: { groups: { $in: groupIds } } },
                    { $unwind: '$groups' },
                    { $match: { groups: { $in: groupIds } } },
                    { $group: { _id: '$groups', count: { $sum: 1 } } },
                ]),
                HyUser.aggregate([
                    { $match: { groups: { $in: groupIds }, isProbe: { $ne: true } } },
                    { $unwind: '$groups' },
                    { $match: { groups: { $in: groupIds } } },
                    { $group: { _id: '$groups', count: { $sum: 1 } } },
                ]),
            ]);

            nodeCountMap = new Map(nodeCounts.map((item) => [String(item._id), item.count]));
            userCountMap = new Map(userCounts.map((item) => [String(item._id), item.count]));
        }

        const groupsWithCounts = groups.map((group) => ({
            ...group.toObject(),
            nodesCount: nodeCountMap.get(String(group._id)) || 0,
            usersCount: userCountMap.get(String(group._id)) || 0,
        }));
        
        render(res, 'groups', {
            title: res.locals.locales.groups.title,
            page: 'groups',
            groups: groupsWithCounts,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /groups - Create group
router.post('/groups', async (req, res) => {
    try {
        const { name, description, color, maxDevices, subscriptionTitle } = req.body;
        
        if (!name || !name.trim()) {
            return res.status(400).send('Название обязательно');
        }
        
        await ServerGroup.create({
            name: name.trim(),
            description: description || '',
            color: color || '#6366f1',
            maxDevices: parseInt(maxDevices) || 0,
            subscriptionTitle: subscriptionTitle?.trim() || '',
        });
        
        await Promise.all([
            invalidateGroupsCache(),
            invalidateNodesCache(),
        ]);
        
        res.redirect('/panel/groups');
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).send('Группа с таким названием уже существует');
        }
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /groups/:id - Update group
router.post('/groups/:id', async (req, res) => {
    try {
        const { name, description, color, active, maxDevices, subscriptionTitle } = req.body;
        
        await ServerGroup.findByIdAndUpdate(req.params.id, {
            $set: {
                name: name?.trim() || '',
                description: description || '',
                color: color || '#6366f1',
                active: active === 'on',
                maxDevices: parseInt(maxDevices) || 0,
                subscriptionTitle: subscriptionTitle?.trim() || '',
            }
        });
        
        await Promise.all([
            invalidateGroupsCache(),
            invalidateNodesCache(),
        ]);
        
        res.redirect('/panel/groups');
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /groups/:id/delete - Delete group
router.post('/groups/:id/delete', async (req, res) => {
    try {
        await Promise.all([
            HyNode.updateMany({ groups: req.params.id }, { $pull: { groups: req.params.id } }),
            HyUser.updateMany({ groups: req.params.id }, { $pull: { groups: req.params.id } }),
            ServerGroup.findByIdAndDelete(req.params.id),
        ]);
        
        await Promise.all([
            invalidateGroupsCache(),
            invalidateNodesCache(),
        ]);
        
        res.redirect('/panel/groups');
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

module.exports = router;
