/**
 * i18n middleware (supports: ru, en, zh-CN)
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LANG = 'ru';
const FALLBACK_LANG = 'en';
const LANGUAGE_OPTIONS = Object.freeze([
    { code: 'ru', label: 'RU', name: 'Русский', dateLocale: 'ru-RU' },
    { code: 'en', label: 'EN', name: 'English', dateLocale: 'en-US' },
    { code: 'zh-CN', label: '中文', name: '简体中文', dateLocale: 'zh-CN' },
]);
const SUPPORTED_LANGS = LANGUAGE_OPTIONS.map(option => option.code);
const LANGUAGE_BY_CODE = new Map(LANGUAGE_OPTIONS.map(option => [option.code, option]));
const LOCALE_FILE_CANDIDATES = {
    en: ['en.json'],
    ru: ['ru.json'],
    'zh-CN': ['zh-CN.json', 'zh-cn.json', 'zh.json', 'zh-Hans.json'],
};

const locales = {};
const localeCache = new Map();
const localesDir = path.join(__dirname, '../locales');

function loadLocale(lang) {
    const candidates = LOCALE_FILE_CANDIDATES[lang] || [`${lang}.json`];

    for (const filename of candidates) {
        const filePath = path.join(localesDir, filename);
        if (!fs.existsSync(filePath)) continue;

        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            console.error(`Failed to load locale ${lang} from ${filename}:`, err.message);
            return {};
        }
    }

    if (lang !== 'zh-CN') {
        console.error(`Failed to load locale ${lang}: file not found`);
    }

    return {};
}

for (const lang of SUPPORTED_LANGS) {
    locales[lang] = loadLocale(lang);
}

function normalizeLanguage(value) {
    if (Array.isArray(value)) {
        value = value[0];
    }
    if (typeof value !== 'string') {
        return null;
    }

    const token = value.trim().split(',')[0].split(';')[0].trim().replace(/_/g, '-');
    if (!token) {
        return null;
    }

    const lower = token.toLowerCase();
    if (lower === 'zh' || lower.startsWith('zh-')) {
        return 'zh-CN';
    }
    if (lower === 'en' || lower.startsWith('en-')) {
        return 'en';
    }
    if (lower === 'ru' || lower.startsWith('ru-')) {
        return 'ru';
    }

    return SUPPORTED_LANGS.find(lang => lang.toLowerCase() === lower) || null;
}

function getFallbackChain(lang = DEFAULT_LANG) {
    const normalized = normalizeLanguage(lang) || DEFAULT_LANG;
    const chain = [normalized];

    if (normalized !== FALLBACK_LANG) {
        chain.push(FALLBACK_LANG);
    }
    if (normalized !== DEFAULT_LANG) {
        chain.push(DEFAULT_LANG);
    }

    return [...new Set(chain)];
}

function getNestedValue(locale, key) {
    const keys = key.split('.');
    let value = locale;

    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            return undefined;
        }
    }

    return value;
}

function t(key, lang = DEFAULT_LANG) {
    for (const fallbackLang of getFallbackChain(lang)) {
        const value = getNestedValue(locales[fallbackLang], key);
        if (typeof value === 'string') {
            return value;
        }
    }

    return key;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeLocale(target, source) {
    for (const [key, value] of Object.entries(source || {})) {
        if (isPlainObject(value)) {
            target[key] = mergeLocale(isPlainObject(target[key]) ? target[key] : {}, value);
        } else if (value !== undefined) {
            target[key] = value;
        }
    }

    return target;
}

function getLocale(lang = DEFAULT_LANG) {
    const normalized = normalizeLanguage(lang) || DEFAULT_LANG;
    if (localeCache.has(normalized)) {
        return localeCache.get(normalized);
    }

    const merged = {};
    for (const fallbackLang of getFallbackChain(normalized).reverse()) {
        mergeLocale(merged, locales[fallbackLang]);
    }

    localeCache.set(normalized, merged);
    return merged;
}

function getDateLocale(lang = DEFAULT_LANG) {
    const normalized = normalizeLanguage(lang) || DEFAULT_LANG;
    return LANGUAGE_BY_CODE.get(normalized)?.dateLocale || LANGUAGE_BY_CODE.get(DEFAULT_LANG).dateLocale;
}

function detectAcceptLanguage(acceptLang) {
    if (typeof acceptLang !== 'string') {
        return null;
    }

    const candidates = acceptLang
        .split(',')
        .map((part, index) => {
            const [tag, ...params] = part.trim().split(';');
            const qParam = params.find(param => param.trim().startsWith('q='));
            const q = qParam ? Number(qParam.split('=')[1]) : 1;

            return {
                lang: normalizeLanguage(tag),
                q: Number.isFinite(q) ? q : 0,
                index,
            };
        })
        .filter(candidate => candidate.lang && candidate.q > 0)
        .sort((a, b) => b.q - a.q || a.index - b.index);

    return candidates[0]?.lang || null;
}

function detectLanguage(req) {
    const queryLang = normalizeLanguage(req.query?.lang);
    if (queryLang) {
        return queryLang;
    }

    const cookieLang = normalizeLanguage(req.cookies?.lang);
    if (cookieLang) {
        return cookieLang;
    }

    const sessionLang = normalizeLanguage(req.session?.lang);
    if (sessionLang) {
        return sessionLang;
    }

    return detectAcceptLanguage(req.headers['accept-language']) || DEFAULT_LANG;
}

function i18nMiddleware(req, res, next) {
    // VamPanel is Russian-only: ignore query/cookie/session language prefs.
    const lang = DEFAULT_LANG;
    const queryLang = normalizeLanguage(req.query?.lang);
    
    if (queryLang) {
        if (req.session) {
            req.session.lang = queryLang;
        }
        res.cookie('lang', queryLang, {
            maxAge: 365 * 24 * 60 * 60 * 1000,
            httpOnly: true
        });
    }
    
    res.locals.lang = lang;
    res.locals.t = (key) => t(key, lang);
    res.locals.supportedLangs = SUPPORTED_LANGS;
    res.locals.languageOptions = LANGUAGE_OPTIONS;
    res.locals.dateLocale = getDateLocale(lang);
    res.locals.locales = getLocale(lang);
    
    next();
}

module.exports = {
    i18nMiddleware,
    t,
    detectLanguage,
    normalizeLanguage,
    getDateLocale,
    getLocale,
    LANGUAGE_OPTIONS,
    SUPPORTED_LANGS,
    DEFAULT_LANG,
};
