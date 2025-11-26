/**
 * Модель пользователя Hysteria
 * Синхронизируется с основной БД пользователей
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const hyUserSchema = new mongoose.Schema({
    // Telegram userId (основной идентификатор)
    userId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    
    // Токен для URL подписки (хэш, не палит userId)
    subscriptionToken: {
        type: String,
        unique: true,
        index: true,
    },
    
    // Username для отображения
    username: {
        type: String,
        default: '',
    },
    
    // Пароль для Hysteria (генерируется автоматически)
    password: {
        type: String,
        required: true,
    },
    
    // Активен ли пользователь (payment = true в основной БД)
    enabled: {
        type: Boolean,
        default: false,
    },
    
    // Группы серверов (пользователь получает ноды из этих групп)
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServerGroup',
    }],
    
    // На каких нодах зарегистрирован (массив ID нод)
    // Если пустой - берутся все ноды из групп пользователя
    nodes: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'HyNode',
    }],
    
    // Статистика трафика (обновляется периодически)
    traffic: {
        tx: { type: Number, default: 0 }, // Отправлено байт
        rx: { type: Number, default: 0 }, // Получено байт
        lastUpdate: { type: Date, default: null },
    },
    
    // Лимит трафика (0 = безлимит)
    trafficLimit: {
        type: Number,
        default: 0,
    },
    
    // Лимит устройств (0 = использовать лимит группы, -1 = безлимит)
    maxDevices: {
        type: Number,
        default: 0,
    },
    
    // Дата истечения подписки
    expireAt: {
        type: Date,
        default: null,
    },
    
}, { timestamps: true });

// Индексы для быстрого поиска
hyUserSchema.index({ enabled: 1 });
hyUserSchema.index({ groups: 1 });

// Виртуальное поле: использованный трафик в ГБ
hyUserSchema.virtual('trafficUsedGB').get(function() {
    return ((this.traffic.tx + this.traffic.rx) / (1024 * 1024 * 1024)).toFixed(2);
});

// Метод: проверка лимита трафика
hyUserSchema.methods.isTrafficExceeded = function() {
    if (this.trafficLimit === 0) return false;
    return (this.traffic.tx + this.traffic.rx) >= this.trafficLimit;
};

// Генерация subscriptionToken перед сохранением
hyUserSchema.pre('save', function(next) {
    if (!this.subscriptionToken) {
        // Генерируем уникальный токен из userId + random
        const hash = crypto.createHash('sha256')
            .update(this.userId + crypto.randomBytes(8).toString('hex'))
            .digest('hex')
            .substring(0, 16);
        this.subscriptionToken = hash;
    }
    next();
});

// Статический метод: найти по токену
hyUserSchema.statics.findByToken = function(token) {
    return this.findOne({ subscriptionToken: token });
};

module.exports = mongoose.model('HyUser', hyUserSchema);

