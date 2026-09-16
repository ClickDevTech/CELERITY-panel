'use strict';

// Caddy version from the official GitHub release, cached in Redis so
// provisioning several nodes costs one request.

const cache = require('../cacheService');
const logger = require('../../utils/logger');

const LATEST_RELEASE_URL = 'https://api.github.com/repos/caddyserver/caddy/releases/latest';
const DOWNLOAD_PREFIX = 'https://github.com/caddyserver/caddy/releases/download/';
const CACHE_KEY = 'front:caddy:release';
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const FRESH_TTL_MS = 24 * 60 * 60 * 1000;
const VERSION_RE = /^v?(\d+\.\d+\.\d+)$/;

// uname -m to the architecture used in Caddy's release asset names.
const ARCH_MAP = {
    x86_64: 'amd64',
    amd64: 'amd64',
    aarch64: 'arm64',
    arm64: 'arm64',
    armv7l: 'armv7',
    armv6l: 'armv6',
    s390x: 's390x',
    ppc64le: 'ppc64le',
    riscv64: 'riscv64',
};

function normalizeVersion(value) {
    return VERSION_RE.exec(String(value || '').trim())?.[1] || '';
}

async function fetchLatestVersion() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(LATEST_RELEASE_URL, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'celerity-front-provisioner',
            },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`GitHub API returned HTTP ${response.status}`);
        }
        const version = normalizeVersion((await response.json())?.tag_name);
        if (!version) throw new Error('Caddy release has no usable tag');
        return version;
    } finally {
        clearTimeout(timer);
    }
}

// Falls back to the cached version when GitHub is unreachable.
async function resolveCaddyVersion() {
    let cached = null;
    try {
        if (cache.isConnected()) {
            cached = JSON.parse(await cache.redis.get(CACHE_KEY) || 'null');
        }
    } catch (error) {
        logger.warn(`[Front] Caddy release cache read failed: ${error.message}`);
    }

    const age = cached?.checkedAt ? Date.now() - new Date(cached.checkedAt).getTime() : Infinity;
    if (cached?.version && age >= 0 && age < FRESH_TTL_MS) return cached.version;

    try {
        const version = await fetchLatestVersion();
        if (cache.isConnected()) {
            await cache.redis.setex(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify({
                version,
                checkedAt: new Date().toISOString(),
            }));
        }
        return version;
    } catch (error) {
        if (cached?.version) {
            logger.warn(`[Front] Caddy release lookup failed, reusing ${cached.version}: ${error.message}`);
            return cached.version;
        }
        throw new Error(`Could not determine the Caddy version to install: ${error.message}`);
    }
}

// Download URLs for a version and a `uname -m` value, or null if unsupported.
function selectCaddyAsset(version, architecture) {
    const normalized = normalizeVersion(version);
    const arch = ARCH_MAP[String(architecture || '').trim().toLowerCase()];
    if (!normalized || !arch) return null;

    const archiveName = `caddy_${normalized}_linux_${arch}.tar.gz`;
    return {
        version: normalized,
        archiveName,
        archiveUrl: `${DOWNLOAD_PREFIX}v${normalized}/${archiveName}`,
        checksumsUrl: `${DOWNLOAD_PREFIX}v${normalized}/caddy_${normalized}_checksums.txt`,
    };
}

module.exports = {
    ARCH_MAP,
    normalizeVersion,
    resolveCaddyVersion,
    selectCaddyAsset,
};
