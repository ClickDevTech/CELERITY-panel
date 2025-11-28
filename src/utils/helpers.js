/**
 * Общие хелперы
 */

const Settings = require('../models/settingsModel');
const ServerGroup = require('../models/serverGroupModel');
const cache = require('../services/cacheService');

// Кэш настроек (обновляется раз в 30 сек)
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30 секунд

/**
 * Получить настройки (с кэшированием)
 */
async function getSettings() {
    const now = Date.now();
    if (!settingsCache || now - settingsCacheTime > CACHE_TTL) {
        settingsCache = await Settings.get();
        settingsCacheTime = now;
    }
    return settingsCache;
}

/**
 * Сбросить кэш настроек (вызывать после изменения)
 */
function invalidateSettingsCache() {
    settingsCache = null;
    settingsCacheTime = 0;
}

/**
 * Получить активные ноды для пользователя по его группам
 * @param {Array<ObjectId>} userGroups - группы пользователя
 * @returns {Promise<Array>}
 */
async function getNodesByGroups(userGroups) {
    const HyNode = require('../models/hyNodeModel');
    
    // Если у пользователя нет групп - возвращаем все активные ноды без групп
    if (!userGroups || userGroups.length === 0) {
        return HyNode.find({ 
            active: true,
            $or: [
                { groups: { $size: 0 } },
                { groups: { $exists: false } }
            ]
        });
    }
    
    // Ищем ноды, у которых есть пересечение с группами пользователя
    // или у которых нет групп вообще (доступны всем)
    return HyNode.find({
        active: true,
        $or: [
            { groups: { $in: userGroups } },
            { groups: { $size: 0 } },
            { groups: { $exists: false } }
        ]
    });
}

/**
 * Получить активные группы (с кэшированием)
 */
async function getActiveGroups() {
    const logger = require('./logger');
    const startTime = Date.now();
    
    // Проверяем Redis кэш
    const cached = await cache.getGroups();
    if (cached) {
        logger.debug(`[Cache] HIT groups (${Date.now() - startTime}ms)`);
        return cached;
    }
    
    // Если кэша нет — запрашиваем из MongoDB
    const groups = await ServerGroup.find({ active: true }).sort({ name: 1 }).lean();
    
    // Сохраняем в кэш на 5 минут
    await cache.setGroups(groups);
    logger.debug(`[Cache] MISS groups - MongoDB query (${Date.now() - startTime}ms)`);
    
    return groups;
}

/**
 * Инвалидировать кэш групп (вызывать после изменения)
 */
async function invalidateGroupsCache() {
    await cache.invalidateGroups();
}

module.exports = {
    getSettings,
    invalidateSettingsCache,
    getNodesByGroups,
    getActiveGroups,
    invalidateGroupsCache,
};
