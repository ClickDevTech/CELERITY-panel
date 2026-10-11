require('dotenv').config();
const { z } = require('zod');

// Flexible, validated config — single source of truth for all env vars.
// Backwards compatible: old keys keep same names/types, new keys are additive.
const envSchema = z.object({
    // Required in production. In local dev (USE_CADDY=true + localhost) defaults apply.
    PANEL_DOMAIN: z.string().min(1).default('localhost:3000'),
    ACME_EMAIL: z.string().email().or(z.string().min(1)).default('dev@example.com'),
    ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY must be at least 32 characters'),
    SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),

    MONGO_URI: z.string().min(1).default('mongodb://localhost:27017/hysteria'),
    REDIS_URL: z.string().min(1).default('redis://redis:6379'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    USE_CADDY: z.string().optional().default(''),
    SESSION_COOKIE_SECURE: z.string().optional().default('true'),
    PANEL_IP_WHITELIST: z.string().optional().default(''),
    SYNC_INTERVAL: z.coerce.number().int().min(1).max(1440).default(2),
    API_DOCS_ENABLED: z.string().optional().default(''),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    SSH_DIRECT_MAX_CONCURRENT: z.coerce.number().int().min(1).max(32).default(3),
    UPDATER_SECRET: z.string().optional().default(''),
    PANEL_TAG: z.string().optional().default('latest'),
    NODE_ENV: z.string().optional().default('production'),
});

let env;
try {
    env = envSchema.parse(process.env);
} catch (e) {
    console.error('[Config] Invalid environment:');
    for (const issue of e.issues || []) {
        console.error(`[Config]  - ${issue.path.join('.')}: ${issue.message}`);
    }
    console.error('[Config] Copy docker.env.example to .env and configure');
    process.exit(1);
}

// Production guard: no dev defaults for secrets/domain in real deploy
const isLocalDev = env.USE_CADDY === 'true' && /localhost|^127\.|^192\.168\.|^10\./.test(env.PANEL_DOMAIN);
if (!isLocalDev) {
    const missing = [];
    if (!process.env.PANEL_DOMAIN) missing.push('PANEL_DOMAIN');
    if (!process.env.ACME_EMAIL) missing.push('ACME_EMAIL');
    if (!process.env.ENCRYPTION_KEY) missing.push('ENCRYPTION_KEY');
    if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');
    if (missing.length) {
        console.error(`[Config] Error: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required in production`);
        console.error('[Config] Copy docker.env.example to .env and configure');
        process.exit(1);
    }
}

function parseWhitelist(raw) {
    if (!raw || !raw.trim()) return [];
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// http for localhost / local dev, https otherwise — fixes subscription links in local mode
function buildBaseUrl(domain, useCaddy) {
    const clean = String(domain).replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (/^localhost(:\d+)?$/.test(clean) || /^(127\.|192\.168\.|10\.)/.test(clean)) {
        const hasPort = /:\d+$/.test(clean);
        return `http://${clean}${hasPort ? '' : ':3000'}`;
    }
    void useCaddy;
    return `https://${clean}`;
}

const BASE_URL = process.env.BASE_URL || buildBaseUrl(env.PANEL_DOMAIN, env.USE_CADDY);

module.exports = {
    PANEL_DOMAIN: env.PANEL_DOMAIN,
    ACME_EMAIL: env.ACME_EMAIL,
    BASE_URL,
    MONGO_URI: env.MONGO_URI,
    REDIS_URL: env.REDIS_URL,
    PORT: env.PORT,
    USE_CADDY: env.USE_CADDY === 'true',
    SESSION_COOKIE_SECURE: env.SESSION_COOKIE_SECURE !== 'false',
    ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    SESSION_SECRET: env.SESSION_SECRET,
    PANEL_IP_WHITELIST: env.PANEL_IP_WHITELIST,
    PANEL_IP_WHITELIST_LIST: parseWhitelist(env.PANEL_IP_WHITELIST),
    SYNC_INTERVAL: env.SYNC_INTERVAL,
    API_DOCS_ENABLED: env.API_DOCS_ENABLED === 'true',
    LOG_LEVEL: env.LOG_LEVEL,
    SSH_DIRECT_MAX_CONCURRENT: env.SSH_DIRECT_MAX_CONCURRENT,
    UPDATER_SECRET: env.UPDATER_SECRET,
    PANEL_TAG: env.PANEL_TAG,
    IS_LOCAL_DEV: isLocalDev,
    DEFAULT_NODE_CONFIG: {
        portRange: process.env.DEFAULT_PORT_RANGE || '20000-50000',
        mainPort: parseInt(process.env.DEFAULT_MAIN_PORT, 10) || 443,
        statsPort: parseInt(process.env.DEFAULT_STATS_PORT, 10) || 9999,
    },
};
