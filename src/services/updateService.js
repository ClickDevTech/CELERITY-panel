'use strict';

/**
 * Panel update service.
 *
 * Two responsibilities, both kept OFF the request path:
 *   1. Version discovery: query GitHub Releases for ClickDevTech/CELERITY-panel,
 *      cache in Redis (long TTL, forced refresh on demand), compare with the
 *      running version from package.json.
 *   2. Updater bridge: talk to the isolated updater sidecar over the internal
 *      network using HMAC-signed requests (status + apply).
 *
 * No new npm dependencies: uses global fetch (Node 22) and the built-in crypto
 * module only.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const cache = require('./cacheService');

const { version: currentVersion } = require('../../package.json');

const GITHUB_REPO = 'ClickDevTech/CELERITY-panel';
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`;
const CACHE_KEY = 'panel:updates:releases';
const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

const UPDATER_URL = process.env.UPDATER_URL || '';
const UPDATER_SECRET = process.env.UPDATER_SECRET || '';
const STATUS_MICROCACHE_MS = 20 * 1000;
// While an update is actively running the UI polls every few seconds; serve it
// near-fresh data instead of the long idle-time cache.
const STATUS_MICROCACHE_ACTIVE_MS = 2 * 1000;

// In-memory micro-cache for updater status so the settings page never blocks on
// a network round-trip on every render.
let statusCache = { at: 0, value: null };

// Panel-side update flow state (pre-update backup + trigger call). Kept off the
// HTTP request path: apply-update responds 202 immediately and the UI reads
// this via update-status. Lost on restart by design - after the backend is
// recreated the UI detects success by comparing the running version.
let updateFlow = {
    state: 'idle', // idle | running | done | error
    step: null,    // backup | trigger
    version: null,
    error: null,
    startedAt: null,
    finishedAt: null,
};

/**
 * Parse a semver-ish string into comparable parts. Returns null when it is not
 * a plain X.Y.Z (optionally prefixed with v). Pre-release/build metadata is
 * intentionally rejected so only stable releases are offered.
 */
function parseVersion(v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compare two versions. Returns 1 if a > b, -1 if a < b, 0 if equal/unknown.
 */
function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return 0;
    for (let i = 0; i < 3; i++) {
        if (pa[i] > pb[i]) return 1;
        if (pa[i] < pb[i]) return -1;
    }
    return 0;
}

function normalizeReleases(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((r) => r && !r.draft && !r.prerelease && parseVersion(r.tag_name))
        .map((r) => ({
            version: String(r.tag_name).replace(/^v/, ''),
            tag: String(r.tag_name),
            name: String(r.name || r.tag_name || '').slice(0, 200),
            body: String(r.body || '').slice(0, 20000),
            publishedAt: r.published_at || null,
            htmlUrl: r.html_url || null,
        }))
        .sort((a, b) => compareVersions(b.version, a.version));
}

async function fetchReleasesFromGitHub() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(RELEASES_URL, {
            headers: {
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'celerity-panel-updater',
            },
            signal: controller.signal,
        });
        if (!res.ok) {
            throw new Error(`GitHub API returned HTTP ${res.status}`);
        }
        const raw = await res.json();
        return normalizeReleases(raw);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Get version info. Reads Redis cache unless `force` is set. Never throws to the
 * caller: on failure it returns whatever cache exists plus an `error` field.
 */
async function getVersionInfo({ force = false } = {}) {
    let releases = null;
    let checkedAt = null;
    let error = null;

    if (!force && cache.isConnected()) {
        try {
            const rawCached = await cache.redis.get(CACHE_KEY);
            if (rawCached) {
                const parsed = JSON.parse(rawCached);
                releases = parsed.releases;
                checkedAt = parsed.checkedAt;
            }
        } catch (err) {
            logger.warn(`[Update] Release cache read failed: ${err.message}`);
        }
    }

    if (!releases) {
        try {
            releases = await fetchReleasesFromGitHub();
            checkedAt = new Date().toISOString();
            if (cache.isConnected()) {
                await cache.redis.setex(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify({ releases, checkedAt }));
            }
        } catch (err) {
            error = err.message;
            logger.warn(`[Update] Release fetch failed: ${err.message}`);
            // On a failed (possibly forced) fetch fall back to whatever cache
            // exists instead of wiping the release list from the response.
            if (cache.isConnected()) {
                try {
                    const rawCached = await cache.redis.get(CACHE_KEY);
                    if (rawCached) {
                        const parsed = JSON.parse(rawCached);
                        releases = parsed.releases;
                        checkedAt = parsed.checkedAt;
                    }
                } catch (_) { /* keep empty list */ }
            }
            releases = releases || [];
        }
    }

    const latest = releases && releases.length ? releases[0].version : null;
    const updateAvailable = latest ? compareVersions(latest, currentVersion) > 0 : false;

    return {
        currentVersion,
        latestVersion: latest,
        updateAvailable,
        releases: releases || [],
        checkedAt,
        error,
    };
}

/**
 * Return true when `version` matches one of the known released versions. This is
 * the whitelist that prevents arbitrary version strings from ever reaching the
 * updater.
 */
async function isKnownRelease(version) {
    const info = await getVersionInfo();
    const target = String(version || '').replace(/^v/, '');
    return info.releases.some((r) => r.version === target);
}

function signRequest(rawBody) {
    const ts = Date.now().toString();
    const signature = crypto.createHmac('sha256', UPDATER_SECRET).update(`${ts}.${rawBody}`).digest('hex');
    return { ts, signature };
}

function isUpdaterConfigured() {
    return Boolean(UPDATER_URL && UPDATER_SECRET && UPDATER_SECRET.length >= 32);
}

async function requestUpdater(method, path, bodyObj) {
    const rawBody = bodyObj ? JSON.stringify(bodyObj) : '';
    const { ts, signature } = signRequest(rawBody);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), method === 'POST' ? 10000 : 2500);
    try {
        const res = await fetch(`${UPDATER_URL}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Updater-Ts': ts,
                'X-Updater-Signature': signature,
            },
            body: method === 'POST' ? rawBody : undefined,
            signal: controller.signal,
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
        return { ok: res.ok, status: res.status, json };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Get updater status. Returns { available: false } when the sidecar is not
 * configured or unreachable (so the UI falls back to manual instructions).
 * Micro-cached to keep the settings page snappy.
 */
async function getUpdaterStatus({ force = false } = {}) {
    if (!isUpdaterConfigured()) {
        return { available: false, reason: 'not_configured' };
    }
    // Shorten the cache while an update is in flight (panel-side flow running or
    // the sidecar itself last reported "running") so progress and errors reach
    // the polling UI within seconds, not after the idle-time TTL.
    const active = updateFlow.state === 'running' || statusCache.value?.state === 'running';
    const ttl = active ? STATUS_MICROCACHE_ACTIVE_MS : STATUS_MICROCACHE_MS;
    if (!force && statusCache.value && (Date.now() - statusCache.at) < ttl) {
        return statusCache.value;
    }
    try {
        const { ok, status, json } = await requestUpdater('GET', '/status', null);
        if (!ok) {
            const value = { available: false, reason: status === 503 ? 'not_configured' : 'error' };
            statusCache = { at: Date.now(), value };
            return value;
        }
        const value = { available: true, ...json };
        statusCache = { at: Date.now(), value };
        return value;
    } catch (err) {
        logger.warn(`[Update] Updater status unreachable: ${err.message}`);
        const value = { available: false, reason: 'unreachable' };
        statusCache = { at: Date.now(), value };
        return value;
    }
}

/**
 * Ask the updater to move the panel to `version`. Caller MUST have already
 * validated the version against the release whitelist and re-authenticated the
 * admin. Returns { accepted } or throws with a descriptive message.
 */
async function applyUpdate(version) {
    if (!isUpdaterConfigured()) {
        throw new Error('Updater is not available');
    }
    const requestId = crypto.randomUUID();
    const { ok, status, json } = await requestUpdater('POST', '/update', { version, requestId });
    // Invalidate the micro-cache so the UI immediately sees the running state.
    statusCache = { at: 0, value: null };
    if (!ok) {
        const msg = (json && json.error) || `Updater returned HTTP ${status}`;
        const err = new Error(msg);
        err.statusCode = status;
        throw err;
    }
    return { accepted: true, requestId, version };
}

function getUpdateFlow() {
    return { ...updateFlow };
}

/**
 * Start the full update flow in the background: optional pre-update backup,
 * then the HMAC-signed trigger call to the updater sidecar. Returns
 * synchronously once the flow is accepted; progress and errors are exposed via
 * getUpdateFlow() for the polling UI. Throws immediately when a flow is
 * already running.
 *
 * mongodump on a large database can take minutes, which is far beyond what an
 * HTTP request (and any reverse proxy in front) should be kept open for -
 * hence fire-and-forget with observable state instead of awaiting inline.
 */
function startUpdateFlow(version, { backup = true } = {}) {
    if (updateFlow.state === 'running') {
        const err = new Error('An update is already in progress');
        err.statusCode = 409;
        throw err;
    }
    if (!isUpdaterConfigured()) {
        throw new Error('Updater is not available');
    }

    updateFlow = {
        state: 'running',
        step: backup ? 'backup' : 'trigger',
        version,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
    };

    setImmediate(async () => {
        try {
            if (backup) {
                const backupService = require('./backupService');
                const Settings = require('../models/settingsModel');
                const settings = await Settings.get();
                const result = await backupService.createBackup(settings);
                logger.info(`[Update] Pre-update backup created: ${result.filename} (${result.sizeMB} MB)`);
            }

            updateFlow.step = 'trigger';
            await applyUpdate(version);

            updateFlow.state = 'done';
            updateFlow.finishedAt = new Date().toISOString();
        } catch (err) {
            logger.error(`[Update] Update flow failed at step "${updateFlow.step}": ${err.message}`);
            updateFlow.state = 'error';
            updateFlow.error = `${updateFlow.step}: ${err.message}`;
            updateFlow.finishedAt = new Date().toISOString();
        }
    });

    return getUpdateFlow();
}

module.exports = {
    getVersionInfo,
    getUpdaterStatus,
    applyUpdate,
    startUpdateFlow,
    getUpdateFlow,
    isKnownRelease,
    isUpdaterConfigured,
    compareVersions,
    parseVersion,
    currentVersion,
};
