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

