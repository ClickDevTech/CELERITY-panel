/**
 * Optional-feature flags that drive the sidebar navigation.
 *
 * Every panel page render needs them, so they are cached in-process instead of
 * hitting the settings store per request. Saving settings drops the cache, so a
 * toggled feature shows up in the menu on the next page load.
 */

const FEATURE_TTL_MS = 30 * 1000;

let cached = { accessLogs: false, probes: false, at: 0 };

async function getFeatureFlags() {
    const now = Date.now();
    if (now - cached.at <= FEATURE_TTL_MS) return cached;

    const Settings = require('../models/settingsModel');
    const settings = await Settings.get();

    cached = {
        accessLogs: !!settings?.accessLogs?.enabled,
        probes: !!settings?.probes?.enabled,
        at: now,
    };
    return cached;
}

function invalidateFeatureFlags() {
    cached = { ...cached, at: 0 };
}

module.exports = { getFeatureFlags, invalidateFeatureFlags };
