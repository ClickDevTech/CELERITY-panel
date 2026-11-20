/**
 * Translations for the network map, rendered by the server into
 * <script type="application/json" id="networkI18n"> (the `network` locale section).
 */

let dict = null;

function load() {
    if (dict) return dict;
    dict = {};
    const el = document.getElementById('networkI18n');
    if (el) {
        try { dict = JSON.parse(el.textContent || '{}') || {}; } catch (_) { dict = {}; }
    }
    return dict;
}

/**
 * Resolve a dotted key ("map.status.online") and substitute {name} placeholders.
 * Missing keys fall back to the key itself so gaps are visible but harmless.
 */
export function t(key, vars) {
    let value = load();
    for (const part of key.split('.')) {
        value = value && typeof value === 'object' ? value[part] : undefined;
    }
    let str = typeof value === 'string' ? value : key;
    if (vars) {
        str = str.replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : m));
    }
    return str;
}

/** Pick a plural form: forms = [one, few, many] (Russian rules; other languages use one/many). */
export function plural(n, key) {
    const forms = t(key).split('|');
    if (forms.length < 2) return forms[0];
    const lang = (document.documentElement.lang || 'en').toLowerCase();
    const abs = Math.abs(n);
    if (lang.startsWith('ru') && forms.length >= 3) {
        const m10 = abs % 10;
        const m100 = abs % 100;
        if (m10 === 1 && m100 !== 11) return forms[0];
        if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
        return forms[2];
    }
    return abs === 1 ? forms[0] : forms[forms.length - 1];
}
