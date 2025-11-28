require('dotenv').config();

// Проверка обязательных переменных
const requiredEnv = ['PANEL_DOMAIN', 'ACME_EMAIL', 'ENCRYPTION_KEY', 'SESSION_SECRET'];
for (const key of requiredEnv) {
    if (!process.env[key]) {
        console.error(`❌ Ошибка: переменная ${key} обязательна!`);
        console.error('Скопируйте docker.env.example в .env и настройте');
        process.exit(1);
    }
}

// Проверка длины ENCRYPTION_KEY
if (process.env.ENCRYPTION_KEY.length < 32) {
    console.error('❌ Ошибка: ENCRYPTION_KEY должен быть минимум 32 символа!');
    process.exit(1);
}

module.exports = {
    // Домен панели (обязательно)
    PANEL_DOMAIN: process.env.PANEL_DOMAIN,
    ACME_EMAIL: process.env.ACME_EMAIL,
    
    // Публичный URL (генерируется из домена)
    BASE_URL: `https://${process.env.PANEL_DOMAIN}`,
    
    // MongoDB
    MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/hysteria',
    
    // Redis (кэширование)
    USE_REDIS: process.env.USE_REDIS !== 'false', // По умолчанию включено
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    
    // Безопасность (обязательные переменные, проверяются выше)
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    SESSION_SECRET: process.env.SESSION_SECRET,
    
    // IP whitelist для панели (через запятую, пустой = разрешено всем)
    PANEL_IP_WHITELIST: process.env.PANEL_IP_WHITELIST || '',
    
    // Интервал синхронизации с нодами (в минутах)
    SYNC_INTERVAL: parseInt(process.env.SYNC_INTERVAL) || 2,
    
    // Настройки по умолчанию для нод
    DEFAULT_NODE_CONFIG: {
        portRange: '20000-50000',
        mainPort: 443,
        statsPort: 9999,
    },
    
};
