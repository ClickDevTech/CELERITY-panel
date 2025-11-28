/**
 * Модель ноды Hysteria
 */

const mongoose = require('mongoose');

// Схема для конфигурации порта
const portConfigSchema = new mongoose.Schema({
    name: { type: String, default: '' },        // Название конфига (TLS, HTTP, Hopping)
    port: { type: Number, required: true },     // Порт
    portRange: { type: String, default: '' },   // Диапазон для hopping
    enabled: { type: Boolean, default: true },
}, { _id: false });

const hyNodeSchema = new mongoose.Schema({
    // Название ноды (Германия, Нидерланды и т.д.)
    name: {
        type: String,
        required: true,
    },
    
    // Код страны (для флага: DE, NL, US и т.д.)
    countryCode: {
        type: String,
        default: '',
    },
    
    // Эмодзи флага
    flag: {
        type: String,
        default: '',
    },
    
    // IP адрес сервера
    ip: {
        type: String,
        required: true,
        unique: true,
    },
    
    // Домен (для SNI)
    domain: {
        type: String,
        default: '',
    },
    
    // Основной порт Hysteria
    port: {
        type: Number,
        default: 443,
    },
    
    // Диапазон портов для port hopping (например: "20000-50000")
    portRange: {
        type: String,
        default: '20000-50000',
    },
    
    // Дополнительные конфигурации портов
    // [{ name: "TLS", port: 443 }, { name: "HTTP", port: 80 }, { name: "Hopping", port: 443, portRange: "20000-50000" }]
    portConfigs: {
        type: [portConfigSchema],
        default: [],
    },
    
    // Порт API статистики
    statsPort: {
        type: Number,
        default: 9999,
    },
    
    // Секрет для API статистики
    statsSecret: {
        type: String,
        default: '',
    },
    
    // Группы серверов (привязка к ServerGroup)
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServerGroup',
    }],
    
    // SSH доступ
    ssh: {
        port: { type: Number, default: 22 },
        username: { type: String, default: 'root' },
        // Приватный ключ или пароль (зашифрованные)
        privateKey: { type: String, default: '' },
        password: { type: String, default: '' },
    },
    
    // Пути на сервере
    paths: {
        config: { type: String, default: '/etc/hysteria/config.yaml' },
        cert: { type: String, default: '/etc/hysteria/cert.pem' },
        key: { type: String, default: '/etc/hysteria/key.pem' },
    },
    
    // Активна ли нода
    active: {
        type: Boolean,
        default: true,
    },
    
    // Статус (online/offline/error)
    status: {
        type: String,
        enum: ['online', 'offline', 'error', 'syncing'],
        default: 'offline',
    },
    
    // Последняя ошибка
    lastError: {
        type: String,
        default: '',
    },
    
    // Время последней синхронизации
    lastSync: {
        type: Date,
        default: null,
    },
    
    // Количество онлайн пользователей (обновляется периодически)
    onlineUsers: {
        type: Number,
        default: 0,
    },
    
    // Максимум онлайн пользователей (0 = без лимита)
    maxOnlineUsers: {
        type: Number,
        default: 0,
    },
    
    // Статистика трафика ноды (сумма всех пользователей)
    traffic: {
        tx: { type: Number, default: 0 }, // Передано байт
        rx: { type: Number, default: 0 }, // Получено байт
        lastUpdate: { type: Date, default: null },
    },
    
    // Коэффициент ранжирования (для балансировки)
    rankingCoefficient: {
        type: Number,
        default: 1.0,
    },
    
    // Дополнительные настройки (резерв для будущего)
    settings: {
        type: Object,
        default: {},
    },
    
    // Кастомный конфиг (если заполнен - используется вместо автогенерации)
    customConfig: {
        type: String,
        default: '',
        },
    
    // Использовать кастомный конфиг
    useCustomConfig: {
        type: Boolean,
        default: false,
    },
    
}, { timestamps: true });

// Индексы
hyNodeSchema.index({ active: 1 });
hyNodeSchema.index({ groups: 1 });
hyNodeSchema.index({ status: 1 });

// Виртуальное поле: полный адрес с port hopping
hyNodeSchema.virtual('serverAddress').get(function() {
    const host = this.domain || this.ip;
    return `${host}:${this.portRange}`;
});

// Метод: получить адрес для подписки
hyNodeSchema.methods.getSubscriptionAddress = function() {
    const host = this.domain || this.ip;
    // Если есть диапазон портов - используем его, иначе основной порт
    if (this.portRange && this.portRange.includes('-')) {
        return `${host}:${this.portRange}`;
    }
    return `${host}:${this.port}`;
};

module.exports = mongoose.model('HyNode', hyNodeSchema);

