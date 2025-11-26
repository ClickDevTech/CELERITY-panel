/**
 * Общие хелперы
 */

const Settings = require('../models/settingsModel');

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

module.exports = {
    getSettings,
    invalidateSettingsCache,
    getNodesByGroups,
};
