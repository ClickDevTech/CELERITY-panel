/**
 * Middleware для подсчета RPS/RPM
 * 
 * Оптимизирован для производительности:
 * - O(1) сложность
 * - Нет массивов/объектов
 * - Минимальное использование памяти (4 переменные)
 */

// Счетчики запросов
let rpsCounter = 0;
let rpmCounter = 0;
let lastRpsReset = Date.now();
let lastRpmReset = Date.now();

/**
 * Middleware для подсчета запросов
 */
function countRequest(req, res, next) {
    const now = Date.now();
    
    // Сброс счетчика RPS каждую секунду
    if (now - lastRpsReset >= 1000) {
        rpsCounter = 1;
        lastRpsReset = now;
    } else {
        rpsCounter++;
    }
    
    // Сброс счетчика RPM каждую минуту
    if (now - lastRpmReset >= 60000) {
        rpmCounter = 1;
        lastRpmReset = now;
    } else {
        rpmCounter++;
    }
    
    next();
}

/**
 * Получить текущие значения RPS/RPM
 */
function getStats() {
    return {
        rps: rpsCounter,
        rpm: rpmCounter,
    };
}

/**
 * Сбросить счетчики (для тестирования)
 */
function reset() {
    rpsCounter = 0;
    rpmCounter = 0;
    lastRpsReset = Date.now();
    lastRpmReset = Date.now();
}

module.exports = {
    countRequest,
    getStats,
    reset,
};

