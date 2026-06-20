/**
 * Homepage Service - serves the public root page (`/`).
 *
 * Modes:
 *   - 'nginx'  : built-in fake nginx welcome page (mask the panel)
 *   - 'custom' : user-uploaded HTML stored in settings
 *   - 'template': static decoy site from sni-templates/
 *
 * Hot path (`respond`) only touches in-memory state — no DB or disk
 * reads for HTML. Cache is rebuilt on init() and on setMode/setCustom/clearCustom.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');

// 256 KB is plenty for a static landing/decoy page and bounds heap usage.
const MAX_CUSTOM_BYTES = 256 * 1024;
const MAX_TEMPLATE_HTML_BYTES = 512 * 1024;

const FAKE_SERVER_HEADER = 'nginx/1.24.0';
const DEFAULT_TEMPLATES_DIR = path.join(__dirname, '../../sni-templates');
const TEMPLATE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ROOT_TEMPLATE_ASSETS = new Set([
    '/apple-touch-icon.png',
    '/favicon.ico',
    '/favicon.svg',
    '/favicon-96x96.png',
    '/site.webmanifest',
    '/vite.svg',
    '/web-app-manifest-192x192.png',
    '/web-app-manifest-512x512.png',
]);

// Verbatim nginx 1.24 (Debian/Ubuntu) welcome page — kept byte-for-byte
// so masking is convincing. Do not pretty-print or reformat.
const NGINX_WELCOME_HTML = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>
`;

const NGINX_BUFFER = Buffer.from(NGINX_WELCOME_HTML, 'utf8');
const NGINX_ETAG = computeEtag(NGINX_BUFFER);

// Atomically-replaced state object. Always treat as immutable; never mutate fields.
let state = {
    mode: 'nginx',
    body: NGINX_BUFFER,
    etag: NGINX_ETAG,
    hasCustom: false,
    customSize: 0,
    templateSlug: '',
    templateRoot: null,
    templateRootReal: null,
};

function computeEtag(buf) {
    return '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"';
}

function normalizeCustomBuffer(value) {
    if (!value) return null;

    let buf;
    try {
        buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    } catch (err) {
        logger.warn(`[Homepage] customHtml has invalid buffer value: ${err.message}`);
        return null;
    }
    if (buf.length === 0) return null;
    if (buf.length > MAX_CUSTOM_BYTES) {
        logger.warn(`[Homepage] customHtml is ${buf.length} bytes, exceeds ${MAX_CUSTOM_BYTES}; ignoring`);
        return null;
    }
    return buf;
}

function getTemplatesDir() {
    return process.env.SNI_TEMPLATES_DIR || DEFAULT_TEMPLATES_DIR;
}

function isSafeTemplateSlug(value) {
    const slug = String(value || '').trim();
    return TEMPLATE_SLUG_RE.test(slug) ? slug : '';
}

function getTemplateInfo(slug) {
    const safeSlug = isSafeTemplateSlug(slug);
    if (!safeSlug) return null;

    const root = path.resolve(getTemplatesDir());
    const templateRoot = path.resolve(root, safeSlug);
    if (!templateRoot.startsWith(root + path.sep)) return null;

    const indexPath = path.join(templateRoot, 'index.html');
    let stat;
    try {
        stat = fs.statSync(indexPath);
    } catch (_err) {
        return null;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TEMPLATE_HTML_BYTES) {
        return null;
    }

    let templateRootReal;
    try {
        templateRootReal = fs.realpathSync(templateRoot);
    } catch (_err) {
        return null;
    }

    return {
        slug: safeSlug,
        label: safeSlug,
        indexPath,
        root: templateRoot,
        rootReal: templateRootReal,
        size: stat.size,
    };
}

function listTemplates() {
    const root = path.resolve(getTemplatesDir());
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_err) {
        return [];
    }

    return entries
        .filter(entry => entry.isDirectory())
        .map(entry => getTemplateInfo(entry.name))
        .filter(Boolean)
        .sort((a, b) => a.slug.localeCompare(b.slug, undefined, { sensitivity: 'base' }));
}

function isValidTemplateSlug(slug) {
    return !!getTemplateInfo(slug);
}

function loadTemplate(slug) {
    const template = getTemplateInfo(slug);
    if (!template) return null;

    let body;
    try {
        body = fs.readFileSync(template.indexPath);
    } catch (err) {
        logger.warn(`[Homepage] failed to read template ${template.slug}: ${err.message}`);
        return null;
    }
    if (body.length === 0 || body.length > MAX_TEMPLATE_HTML_BYTES) {
        return null;
    }

    return {
        ...template,
        body,
        etag: computeEtag(body),
    };
}

function setNginxState(customBuf = null) {
    state = {
        mode: 'nginx',
        body: NGINX_BUFFER,
        etag: NGINX_ETAG,
        hasCustom: !!customBuf,
        customSize: customBuf ? customBuf.length : 0,
        templateSlug: '',
        templateRoot: null,
        templateRootReal: null,
    };
}

function setCustomState(buf) {
    state = {
        mode: 'custom',
        body: buf,
        etag: computeEtag(buf),
        hasCustom: true,
        customSize: buf.length,
        templateSlug: '',
        templateRoot: null,
        templateRootReal: null,
    };
}

function setTemplateState(template, customBuf = null) {
    state = {
        mode: 'template',
        body: template.body,
        etag: template.etag,
        hasCustom: !!customBuf,
        customSize: customBuf ? customBuf.length : 0,
        templateSlug: template.slug,
        templateRoot: template.root,
        templateRootReal: template.rootReal,
    };
}

/**
 * Initialize the in-memory cache. Reads Settings.homepage.mode and payload
 * data. Falls back to 'nginx' if the selected custom/template payload is
 * missing or invalid.
 */
async function init() {
    try {
        const Settings = require('../models/settingsModel');
        const settings = await Settings.get();
        const rawMode = settings?.homepage?.mode;
        const mode = ['custom', 'template'].includes(rawMode) ? rawMode : 'nginx';
        const customBuf = normalizeCustomBuffer(settings?.homepage?.customHtml);

        if (mode === 'custom') {
            if (customBuf) {
                setCustomState(customBuf);
                logger.info(`[Homepage] Loaded custom HTML (${customBuf.length} bytes)`);
                return;
            }
            await Settings.update({ 'homepage.mode': 'nginx' });
            logger.warn('[Homepage] mode=custom but no valid customHtml found; falling back to nginx');
        }
        if (mode === 'template') {
            const template = loadTemplate(settings?.homepage?.templateSlug);
            if (template) {
                setTemplateState(template, customBuf);
                logger.info(`[Homepage] Loaded template ${template.slug} (${template.size} bytes)`);
                return;
            }
            await Settings.update({
                'homepage.mode': 'nginx',
                'homepage.templateSlug': '',
            });
            logger.warn('[Homepage] mode=template but selected template is invalid; falling back to nginx');
        }
        setNginxState(customBuf);
        logger.info('[Homepage] Serving fake nginx welcome page');
    } catch (err) {
        logger.error(`[Homepage] init failed: ${err.message}`);
        setNginxState();
    }
}

/**
 * Switch the active mode. Invalid custom/template requests revert persisted
 * mode to nginx so the next restart stays consistent.
 */
async function setMode(mode, templateSlug = '') {
    if (!['nginx', 'custom', 'template'].includes(mode)) return;

    const Settings = require('../models/settingsModel');
    const settings = await Settings.get();
    const customBuf = normalizeCustomBuffer(settings?.homepage?.customHtml);

    if (mode === 'nginx') {
        await Settings.update({ 'homepage.mode': 'nginx' });
        setNginxState(customBuf);
        return;
    }

    if (mode === 'template') {
        const requestedSlug = templateSlug || settings?.homepage?.templateSlug;
        const template = loadTemplate(requestedSlug);
        if (!template) {
            await Settings.update({
                'homepage.mode': 'nginx',
                'homepage.templateSlug': '',
            });
            setNginxState(customBuf);
            logger.warn('[Homepage] setMode(template) requested but template is invalid; staying on nginx');
            return;
        }
        await Settings.update({
            'homepage.mode': 'template',
            'homepage.templateSlug': template.slug,
        });
        setTemplateState(template, customBuf);
        return;
    }

    if (!customBuf) {
        await Settings.update({ 'homepage.mode': 'nginx' });
        setNginxState();
        logger.warn('[Homepage] setMode(custom) requested but no customHtml in settings; staying on nginx');
        return;
    }
    await Settings.update({ 'homepage.mode': 'custom' });
    setCustomState(customBuf);
}

/**
 * Persist a new custom HTML buffer and refresh the in-memory cache.
 */
async function setCustom(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error('Empty file');
    }
    if (buffer.length > MAX_CUSTOM_BYTES) {
        throw new Error(`File too large (max ${MAX_CUSTOM_BYTES} bytes)`);
    }
    // Reject obvious binary content — checking the first 4 KB is enough
    // to catch executables/images while keeping cost negligible.
    const probe = buffer.subarray(0, Math.min(4096, buffer.length));
    if (probe.includes(0)) {
        throw new Error('Binary content not allowed');
    }

    const Settings = require('../models/settingsModel');
    await Settings.update({
        'homepage.mode': 'custom',
        'homepage.customHtml': buffer,
    });

    setCustomState(buffer);
    logger.info(`[Homepage] Custom HTML saved (${buffer.length} bytes)`);
}

/**
 * Remove the custom HTML payload and reset the cache to the built-in nginx page.
 */
async function clearCustom() {
    const Settings = require('../models/settingsModel');
    await Settings.update({
        'homepage.mode': 'nginx',
        'homepage.customHtml': null,
    });
    setNginxState();
    logger.info('[Homepage] Custom HTML cleared, reverted to nginx');
}

function hasCustom() {
    return state.hasCustom;
}

function getCustomSize() {
    return state.customSize;
}

function getTemplateSlug() {
    return state.templateSlug || '';
}

function normalizeRequestPath(requestPath) {
    let rawPath = String(requestPath || '').split('?')[0];
    if (!rawPath.startsWith('/')) rawPath = `/${rawPath}`;
    if (rawPath.includes('\0')) return null;

    let decoded;
    try {
        decoded = decodeURIComponent(rawPath);
    } catch (_err) {
        return null;
    }
    if (decoded.includes('\0')) return null;

    const normalized = path.posix.normalize(decoded);
    if (normalized !== decoded) return null;
    return normalized;
}

function resolveTemplateAssetPath(requestPath) {
    if (state.mode !== 'template' || !state.templateRoot || !state.templateRootReal) {
        return null;
    }

    const normalized = normalizeRequestPath(requestPath);
    if (!normalized) return null;

    let relativePath = '';
    if (normalized.startsWith('/assets/')) {
        relativePath = normalized.slice(1);
    } else if (ROOT_TEMPLATE_ASSETS.has(normalized)) {
        relativePath = normalized.slice(1);
    } else {
        return null;
    }

    const candidate = path.resolve(state.templateRoot, relativePath);
    const root = path.resolve(state.templateRoot);
    if (!candidate.startsWith(root + path.sep)) return null;

    let stat;
    let realPath;
    try {
        stat = fs.statSync(candidate);
        realPath = fs.realpathSync(candidate);
    } catch (_err) {
        return null;
    }
    if (!stat.isFile()) return null;
    if (realPath !== state.templateRootReal && !realPath.startsWith(state.templateRootReal + path.sep)) {
        return null;
    }

    return candidate;
}

function serveTemplateAsset(req, res, next) {
    const assetPath = resolveTemplateAssetPath(req.path);
    if (!assetPath) {
        if (typeof next === 'function') return next();
        res.status(404).end();
        return;
    }

    res.setHeader('Server', FAKE_SERVER_HEADER);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.removeHeader('X-Powered-By');
    res.sendFile(assetPath, (err) => {
        if (err && typeof next === 'function') next(err);
    });
}

/**
 * Express handler for `GET /` (and HEAD /). Serves the cached body with
 * masking headers and ETag-based 304 support.
 */
function respond(req, res) {
    const { body, etag } = state;

    res.setHeader('Server', FAKE_SERVER_HEADER);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('ETag', etag);
    res.removeHeader('X-Powered-By');

    if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
    }

    if (req.method === 'HEAD') {
        res.setHeader('Content-Length', body.length);
        res.status(200).end();
        return;
    }

    res.status(200).send(body);
}

function getMode() {
    return state.mode;
}

module.exports = {
    init,
    setMode,
    setCustom,
    clearCustom,
    respond,
    serveTemplateAsset,
    hasCustom,
    getCustomSize,
    getMode,
    getTemplateSlug,
    listTemplates,
    isValidTemplateSlug,
    resolveTemplateAssetPath,
    MAX_CUSTOM_BYTES,
    MAX_TEMPLATE_HTML_BYTES,
};
