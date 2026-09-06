const FINGERPRINT_VALUES = Object.freeze([
    'chrome', 'firefox', 'safari', 'ios', 'android',
    'edge', '360', 'qq', 'random', 'randomized',
]);

function normalizeFingerprint(value, fallback = 'chrome') {
    return FINGERPRINT_VALUES.includes(value) ? value : fallback;
}

function normalizeFingerprintPool(raw) {
    if (raw === undefined || raw === null) return [];
    const values = Array.isArray(raw) ? raw : String(raw).split(',');
    return [...new Set(
        values
            .map(value => String(value).trim())
            .filter(value => FINGERPRINT_VALUES.includes(value))
    )];
}

function pickFingerprint(fingerprint, pool, random = Math.random) {
    const normalizedPool = normalizeFingerprintPool(pool);
    if (normalizedPool.length > 0) {
        return normalizedPool[Math.floor(random() * normalizedPool.length)];
    }
    return normalizeFingerprint(fingerprint);
}

function distributeFingerprints(fingerprint, pool, count, random = Math.random) {
    const size = Number.isSafeInteger(count) && count > 0 ? count : 0;
    const normalizedPool = normalizeFingerprintPool(pool);
    if (normalizedPool.length === 0) {
        return Array(size).fill(normalizeFingerprint(fingerprint));
    }

    const offset = Math.floor(random() * normalizedPool.length);
    return Array.from(
        { length: size },
        (_, index) => normalizedPool[(offset + index) % normalizedPool.length]
    );
}

module.exports = {
    FINGERPRINT_VALUES,
    normalizeFingerprint,
    normalizeFingerprintPool,
    pickFingerprint,
    distributeFingerprints,
};
