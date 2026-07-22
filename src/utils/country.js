const ISO_COUNTRY_CODES = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ
VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW EU XK
`.trim().split(/\s+/);

function normalizeCountryCode(value) {
    const code = String(value || '').trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : '';
}

function countryCodeToFlag(value) {
    const code = normalizeCountryCode(value);
    if (!code) return '';
    return String.fromCodePoint(...Array.from(code, char => 127397 + char.charCodeAt(0)));
}

const countryOptionsCache = new Map();

function normalizeLocale(value) {
    const locale = String(value || '').trim().toLowerCase();
    if (locale.startsWith('zh')) return 'zh-CN';
    if (locale.startsWith('ru')) return 'ru';
    return 'en';
}

function getCountryOptions(locale = 'ru') {
    const normalizedLocale = normalizeLocale(locale);
    if (countryOptionsCache.has(normalizedLocale)) return countryOptionsCache.get(normalizedLocale);

    const names = new Intl.DisplayNames([normalizedLocale], { type: 'region', fallback: 'code' });
    const options = Object.freeze(ISO_COUNTRY_CODES.map(code => Object.freeze({
        code,
        flag: countryCodeToFlag(code),
        name: names.of(code) || code,
    })));
    countryOptionsCache.set(normalizedLocale, options);
    return options;
}

const COUNTRY_OPTIONS = getCountryOptions('ru');

module.exports = {
    COUNTRY_OPTIONS,
    getCountryOptions,
    normalizeCountryCode,
    countryCodeToFlag,
};
