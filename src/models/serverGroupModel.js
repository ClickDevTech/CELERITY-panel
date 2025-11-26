/**
 * Модель группы серверов
 * Админ создаёт группы и привязывает к ним ноды и пользователей
 */

const mongoose = require('mongoose');

const serverGroupSchema = new mongoose.Schema({
    // Название группы (например: "Европа", "Premium", "Тест")
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true,
    },
    
    // Описание (опционально)
    description: {
        type: String,
        default: '',
    },
    
    // Цвет для UI (hex)
    color: {
        type: String,
        default: '#6366f1',
    },
    
    // Активна ли группа
    active: {
        type: Boolean,
        default: true,
    },
    
    // Лимит устройств (одновременных подключений)
    // 0 = без лимита
    maxDevices: {
        type: Number,
        default: 0,
    },
    
    // Название подписки (отображается в приложениях)
    // Если не задано - используется name
    subscriptionTitle: {
        type: String,
        default: '',
        trim: true,
    },
    
}, { timestamps: true });

module.exports = mongoose.model('ServerGroup', serverGroupSchema);

