/**
 * Модель настроек панели
 * Хранит настройки в БД, редактируется через панель
 */

const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    // Единственный документ настроек
    _id: {
        type: String,
        default: 'settings',
    },
    
    // Балансировка нагрузки
    loadBalancing: {
        // Сортировать ноды по загрузке
        enabled: { type: Boolean, default: false },
        // Скрывать перегруженные ноды
        hideOverloaded: { type: Boolean, default: false },
    },
    
    // Лимит устройств
    // Grace period — как долго помнить IP после отключения (минуты)
    // Защищает от ложных срабатываний при смене WiFi↔LTE
    deviceGracePeriod: { type: Number, default: 15 },
    
    // TTL кэша (в секундах)
    cache: {
        // Подписки (готовые конфиги Clash/Singbox/URI)
        subscriptionTTL: { type: Number, default: 3600 },    // 1 час
        // Данные пользователей (для авторизации подключений)
        userTTL: { type: Number, default: 900 },             // 15 минут
        // Онлайн-сессии (для лимита устройств)
        onlineSessionsTTL: { type: Number, default: 10 },    // 10 секунд
        // Список активных нод
        activeNodesTTL: { type: Number, default: 30 },       // 30 секунд
    },
    
    // Rate limiting
    rateLimit: {
        // Лимит запросов подписок в минуту (на IP)
        subscriptionPerMinute: { type: Number, default: 100 },
        // Лимит запросов авторизации в секунду (на IP ноды)
        authPerSecond: { type: Number, default: 200 },
    },
    
}, { timestamps: true });

// Статический метод: получить настройки (создаёт если нет)
settingsSchema.statics.get = async function() {
    let settings = await this.findById('settings');
    if (!settings) {
        settings = await this.create({ _id: 'settings' });
    }
    return settings;
};

// Статический метод: обновить настройки
settingsSchema.statics.update = async function(updates) {
    return this.findByIdAndUpdate('settings', { $set: updates }, { 
        new: true, 
        upsert: true,
        setDefaultsOnInsert: true,
    });
};

module.exports = mongoose.model('Settings', settingsSchema);

