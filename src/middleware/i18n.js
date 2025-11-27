/**
 * Middleware для интернационализации (i18n)
 * Поддерживает: ru, en
 */

const fs = require('fs');
const path = require('path');

// Загружаем переводы
const locales = {};
const localesDir = path.join(__dirname, '../locales');

try {
    locales.en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8'));
    locales.ru = JSON.parse(fs.readFileSync(path.join(localesDir, 'ru.json'), 'utf8'));
} catch (err) {
    console.error('Failed to load locales:', err.message);
}

const DEFAULT_LANG = 'ru';
const SUPPORTED_LANGS = ['en', 'ru'];

/**
 * Получить перевод по ключу (вложенные ключи через точку)
 * @param {string} key - Ключ перевода (например, "nav.dashboard")
 * @param {string} lang - Язык
 * @returns {string} Перевод или ключ если не найден
 */
function t(key, lang = DEFAULT_LANG) {
    const locale = locales[lang] || locales[DEFAULT_LANG];
    
    // Разбираем вложенные ключи
    const keys = key.split('.');
    let value = locale;
    
    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            return key; // Ключ не найден
        }
    }
    
    return typeof value === 'string' ? value : key;
}

/**
 * Определить язык из запроса
 */
function detectLanguage(req) {
    // 1. Из query параметра
    if (req.query.lang && SUPPORTED_LANGS.includes(req.query.lang)) {
        return req.query.lang;
    }
    
    // 2. Из cookie
    if (req.cookies?.lang && SUPPORTED_LANGS.includes(req.cookies.lang)) {
        return req.cookies.lang;
    }
    
    // 3. Из сессии
    if (req.session?.lang && SUPPORTED_LANGS.includes(req.session.lang)) {
        return req.session.lang;
    }
    
    // 4. Из Accept-Language header
    const acceptLang = req.headers['accept-language'];
    if (acceptLang) {
        for (const lang of SUPPORTED_LANGS) {
            if (acceptLang.toLowerCase().includes(lang)) {
                return lang;
            }
        }
    }
    
    return DEFAULT_LANG;
}

/**
 * Middleware для добавления t() функции в res.locals
 */
function i18nMiddleware(req, res, next) {
    const lang = detectLanguage(req);
    
    // Сохраняем язык в сессию если изменился через query
    if (req.query.lang && SUPPORTED_LANGS.includes(req.query.lang)) {
        if (req.session) {
            req.session.lang = req.query.lang;
        }
        // Устанавливаем cookie на год
        res.cookie('lang', req.query.lang, { 
            maxAge: 365 * 24 * 60 * 60 * 1000,
            httpOnly: true 
        });
    }
    
    // Добавляем в res.locals для использования в EJS
    res.locals.lang = lang;
    res.locals.t = (key) => t(key, lang);
    res.locals.supportedLangs = SUPPORTED_LANGS;
    res.locals.locales = locales[lang] || locales[DEFAULT_LANG];
    
    next();
}

module.exports = {
    i18nMiddleware,
    t,
    detectLanguage,
    SUPPORTED_LANGS,
    DEFAULT_LANG,
};



