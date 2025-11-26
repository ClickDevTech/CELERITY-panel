/**
 * HTTP Auth эндпоинт для Hysteria 2 нод
 * Ноды отправляют сюда запросы при каждом подключении клиента
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const HyUser = require('../models/hyUserModel');
const HyNode = require('../models/hyNodeModel');
const cryptoService = require('../services/cryptoService');
const logger = require('../utils/logger');

// Кэш онлайн сессий (обновляется раз в 5 секунд)
let onlineCache = {};
let onlineCacheTime = 0;
const ONLINE_CACHE_TTL = 5000; // 5 секунд

/**
 * Получить количество онлайн сессий пользователя со всех нод
 */
async function getOnlineSessions(userId) {
    const now = Date.now();
    
    // Используем кэш если свежий
    if (now - onlineCacheTime < ONLINE_CACHE_TTL && onlineCache[userId] !== undefined) {
        return onlineCache[userId];
    }
    
    // Обновляем кэш
    try {
        const nodes = await HyNode.find({ active: true, statsPort: { $gt: 0 }, statsSecret: { $ne: '' } });
        const newCache = {};
        
        await Promise.all(nodes.map(async (node) => {
            try {
                const response = await axios.get(`http://${node.ip}:${node.statsPort}/online`, {
                    headers: { Authorization: node.statsSecret },
                    timeout: 2000,
                });
                
                // response.data = { "userId1": {...}, "userId2": {...}, ... }
                for (const id of Object.keys(response.data)) {
                    newCache[id] = (newCache[id] || 0) + 1;
                }
            } catch (err) {
                // Нода недоступна - пропускаем
            }
        }));
        
        onlineCache = newCache;
        onlineCacheTime = now;
        
        return newCache[userId] || 0;
    } catch (err) {
        logger.error(`[Auth] Ошибка получения онлайн сессий: ${err.message}`);
        return 0; // В случае ошибки разрешаем подключение
    }
}

/**
 * POST /auth - Проверка авторизации пользователя
 * 
 * Hysteria отправляет:
 * {
 *   "addr": "IP:port клиента",
 *   "auth": "строка авторизации от клиента",
 *   "tx": bandwidth клиента
 * }
 * 
 * Мы ожидаем auth в формате: "userId:password" или просто "userId"
 * 
 * Ответ:
 * { "ok": true, "id": "userId" } — разрешить
 * { "ok": false } — запретить
 */
router.post('/', async (req, res) => {
    try {
        const { addr, auth, tx } = req.body;
        
        if (!auth) {
            logger.warn(`[Auth] Пустой auth от ${addr}`);
            return res.json({ ok: false });
        }
        
        // Парсим auth строку: может быть "userId:password" или "userId"
        let userId, password;
        
        if (auth.includes(':')) {
            [userId, password] = auth.split(':');
        } else {
            userId = auth;
            password = null;
        }
        
        // Ищем пользователя с группами
        const user = await HyUser.findOne({ userId }).populate('groups');
        
        if (!user) {
            logger.warn(`[Auth] Пользователь не найден: ${userId} (${addr})`);
            return res.json({ ok: false });
        }
        
        // Проверяем что подписка активна
        if (!user.enabled) {
            logger.warn(`[Auth] Подписка неактивна: ${userId} (${addr})`);
            return res.json({ ok: false });
        }
        
        // Проверяем пароль если указан
        if (password) {
            const expectedPassword = cryptoService.generatePassword(userId);
            if (password !== expectedPassword && password !== user.password) {
                logger.warn(`[Auth] Неверный пароль: ${userId} (${addr})`);
                return res.json({ ok: false });
            }
        }
        
        // Проверяем лимит трафика
        if (user.trafficLimit > 0) {
            const usedTraffic = (user.traffic?.tx || 0) + (user.traffic?.rx || 0);
            if (usedTraffic >= user.trafficLimit) {
                logger.warn(`[Auth] Превышен лимит трафика: ${userId} (${addr})`);
                return res.json({ ok: false });
            }
        }
        
        // Проверяем дату истечения
        if (user.expireAt && new Date(user.expireAt) < new Date()) {
            logger.warn(`[Auth] Подписка истекла: ${userId} (${addr})`);
            return res.json({ ok: false });
        }
        
        // Проверяем лимит устройств
        let maxDevices = user.maxDevices;
        
        // Если у пользователя 0 - берём минимальный из групп
        if (maxDevices === 0 && user.groups?.length > 0) {
            const groupLimits = user.groups
                .filter(g => g.maxDevices > 0)
                .map(g => g.maxDevices);
            
            if (groupLimits.length > 0) {
                maxDevices = Math.min(...groupLimits);
            }
        }
        
        // -1 = безлимит, 0 = без ограничений (нет настроек)
        if (maxDevices > 0) {
            const currentSessions = await getOnlineSessions(userId);
            
            if (currentSessions >= maxDevices) {
                logger.warn(`[Auth] Превышен лимит устройств (${currentSessions}/${maxDevices}): ${userId} (${addr})`);
                return res.json({ ok: false });
            }
        }
        
        logger.info(`[Auth] ✅ Авторизован: ${userId} (${addr})`);
        
        // Успешная авторизация
        // Bandwidth ограничивается на стороне КЛИЕНТА (в подписке)
        // или глобально на сервере (bandwidth в config.yaml)
        return res.json({ 
            ok: true, 
            id: userId,
        });
        
    } catch (error) {
        logger.error(`[Auth] Ошибка: ${error.message}`);
        // В случае ошибки — запрещаем (безопаснее)
        return res.json({ ok: false });
    }
});

// Эндпоинт /check/:userId удалён по соображениям безопасности
// Для отладки используйте логи или веб-панель

module.exports = router;


