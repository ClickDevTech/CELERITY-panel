/**
 * Panel routes: settings, backup settings, API keys, webhooks.
 */

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const HyUser = require('../../models/hyUserModel');
const HyNode = require('../../models/hyNodeModel');
const ServerGroup = require('../../models/serverGroupModel');
const Settings = require('../../models/settingsModel');
const Admin = require('../../models/adminModel');
const ApiKey = require('../../models/apiKeyModel');
const cryptoService = require('../../services/cryptoService');
const totpService = require('../../services/totpService');
const webhookService = require('../../services/webhookService');
const cache = require('../../services/cacheService');
const hwidDeviceService = require('../../services/hwidDeviceService');
const homepageService = require('../../services/homepageService');
const syncService = require('../../services/syncService');
const updateService = require('../../services/updateService');
const { invalidateSettingsCache } = require('../../utils/helpers');
const { sanitizePageNote } = require('../../utils/textSanitize');
const config = require('../../../config');
const logger = require('../../utils/logger');
const {
    render,
    parseBool,
    clearPanelTotpPending,
    redirectSettingsSecurity,
    SETTINGS_TOTP_ACTIONS,
} = require('./helpers');

// ==================== SETTINGS ====================

// GET /settings
router.get('/settings', async (req, res) => {
    try {
        const ssl = {
            enabled: !!config.PANEL_DOMAIN,
            domain: config.PANEL_DOMAIN || null,
        };

        const [admin, settingsDoc, apiKeys, migrationGroups] = await Promise.all([
            Admin.findOne({ username: req.session.adminUsername }),
            Settings.get(),
            ApiKey.listKeys(),
            ServerGroup.find({ active: true }).select('_id name color').lean(),
        ]);

        // Convert to plain object before mutating to avoid Mongoose change tracking
        const settings = settingsDoc ? settingsDoc.toObject() : settingsDoc;

        // Decrypt secrets for form display (stored encrypted since P1-encrypt-secrets)
        if (settings?.webhook?.secret) {
            settings.webhook.secret = cryptoService.decryptSafe(settings.webhook.secret);
        }
        if (settings?.backup?.s3?.secretAccessKey) {
            settings.backup.s3.secretAccessKey = cryptoService.decryptSafe(settings.backup.s3.secretAccessKey);
        }

        // Migration tab data — strip ciphertext (the form never round-trips it).
        const marzbanCfg = (settings?.migration?.marzban) || {};
        delete marzbanCfg.jwtSecretEncrypted;

        let topHwidUsers = [];
        try {
            const cacheKey = 'panel:topHwidUsers';
            if (cache.isConnected()) {
                const raw = await cache.redis.get(cacheKey);
                if (raw) {
                    topHwidUsers = JSON.parse(raw);
                }
            }
            if (!Array.isArray(topHwidUsers) || topHwidUsers.length === 0) {
                const rows = await hwidDeviceService.topUsersByDeviceCount(10);
                topHwidUsers = await Promise.all(
                    rows.map(async (r) => {
                        const u = await HyUser.findOne({ userId: r.userId }).select('username').lean();
                        return { ...r, username: u?.username || '' };
                    })
                );
                if (cache.isConnected() && topHwidUsers.length > 0) {
                    await cache.redis.setex(cacheKey, 60, JSON.stringify(topHwidUsers));
                }
            }
        } catch (e) {
            logger.warn(`[Panel] topHwidUsers: ${e.message}`);
        }

        const homepageInfo = {
            mode: homepageService.getMode(),
            hasCustom: homepageService.hasCustom(),
            customSize: homepageService.getCustomSize(),
            maxBytes: homepageService.MAX_CUSTOM_BYTES,
        };

        // Eligible nodes for access-log collection: client-facing Xray nodes
        // (standalone or portal). Used by the access-logs settings tab.
        let accessLogNodes = [];
        try {
            const HyNode = require('../../models/hyNodeModel');
            accessLogNodes = await HyNode.find({
                type: 'xray',
                cascadeRole: { $in: ['standalone', 'portal'] },
            })
                .select('name cascadeRole agentVersion xray.accessLogs.status xray.accessLogs.lastError xray.accessLogs.lastBatchAt')
                .lean();
        } catch (e) {
            logger.warn(`[Panel] accessLogNodes: ${e.message}`);
        }

        render(res, 'settings', {
            title: res.locals.locales.settings.title,
            page: 'settings',
            ssl,
            admin,
            settings,
            apiKeys,
            validScopes: ApiKey.VALID_SCOPES,
            webhookEvents: Object.values(webhookService.EVENTS),
            topHwidUsers,
            homepageInfo,
            migrationGroups,
            marzbanCfg,
            accessLogNodes,
            message: req.query.message || null,
            error: req.query.error || null,
        });
    } catch (error) {
        logger.error('[Panel] GET /settings error:', error.message);
        res.status(500).send(`${res.locals.t?.('common.error') || 'Error'}: ${error.message}`);
    }
});

// POST /settings - Save settings
router.post('/settings', async (req, res) => {
    try {
        const { reloadSettings } = require('../../../index');
        
        // Build updates only from fields that the submitted form actually contains.
        // Each settings card lives in its own <form>, so when the user saves one
        // card, request body only carries that card's fields. Unconditionally
        // applying parseInt with `|| default` would silently reset settings from
        // other cards on every save.
        const updates = {};

        // Helper: include a setting only when present in the request body.
        const setIfPresent = (key, parser) => {
            if (req.body[key] !== undefined) updates[key] = parser(req.body[key]);
        };
        const setBool = (key) => {
            if (req.body[key] !== undefined) updates[key] = req.body[key] === 'on';
        };

        // System tab: load balancing, cache TTLs, SSH pool, node auth.
        // The whole tab posts as a single form, so any number input that is
        // always rendered (cache.subscriptionTTL) being present means this
        // is a System tab submit. For checkboxes inside that form an absent
        // key means "unchecked", so force-apply booleans on this branch.
        const systemTabSubmit = req.body['cache.subscriptionTTL'] !== undefined;
        if (systemTabSubmit) {
            updates['loadBalancing.enabled']        = req.body['loadBalancing.enabled']        === 'on';
            updates['loadBalancing.hideOverloaded'] = req.body['loadBalancing.hideOverloaded'] === 'on';
            updates['loadBalancing.hideOffline']    = req.body['loadBalancing.hideOffline']    === 'on';
        }
        setIfPresent('cache.subscriptionTTL', v => parseInt(v) || 3600);
        setIfPresent('cache.userTTL', v => parseInt(v) || 900);
        setIfPresent('cache.onlineSessionsTTL', v => parseInt(v) || 10);
        setIfPresent('cache.activeNodesTTL', v => parseInt(v) || 30);
        setIfPresent('rateLimit.subscriptionPerMinute', v => parseInt(v) || 100);
        setBool('sshPool.enabled');
        setIfPresent('sshPool.maxIdleTime', v => parseInt(v) || 120);
        setIfPresent('sshPool.connectTimeout', v => parseInt(v) || 15);
        setIfPresent('sshPool.keepAliveInterval', v => parseInt(v) || 30);
        setIfPresent('sshPool.maxRetries', v => parseInt(v) || 2);

        // Node Auth card is a standalone form; an absent checkbox means
        // "unchecked", so force-apply the boolean when that card is submitted.
        if (req.body['_nodeAuthSettings'] !== undefined) {
            updates['nodeAuth.insecure'] = req.body['nodeAuth.insecure'] === 'on';
        }

        // Hysteria IP device limit (its own card on the Subscription tab).
        if (req.body['_hyLimitSettings'] !== undefined) {
            const grace = parseInt(req.body['deviceGracePeriod'], 10);
            updates['deviceGracePeriod'] = Number.isFinite(grace) ? Math.min(60, Math.max(1, grace)) : 15;
        }
        
        // Webhook settings (only when the dedicated webhook form is submitted)
        if (req.body['_webhookSettings'] !== undefined) {
            updates['webhook.enabled'] = req.body['webhook.enabled'] === 'on';
            updates['webhook.url'] = req.body['webhook.url'] || '';
            const rawWebhookSecret = req.body['webhook.secret'] || '';
            updates['webhook.secret'] = rawWebhookSecret ? cryptoService.encrypt(rawWebhookSecret) : '';
            const rawEvents = req.body['webhook.events'];
            updates['webhook.events'] = rawEvents
                ? (Array.isArray(rawEvents) ? rawEvents : [rawEvents])
                : [];
            const warnPct = parseFloat(req.body['webhook.diskWarnPct']);
            updates['webhook.diskWarnPct'] = Number.isFinite(warnPct) && warnPct > 0 && warnPct < 100 ? warnPct : 15;
            const critGb = parseFloat(req.body['webhook.diskCritGb']);
            updates['webhook.diskCritGb'] = Number.isFinite(critGb) && critGb > 0 ? critGb : 1;

            // Access-logs IP-sharing alert. Clamp to sane bounds; fall back to
            // defaults on invalid input so a bad value never disables the guard.
            updates['webhook.ipAlertEnabled'] = req.body['webhook.ipAlertEnabled'] === 'on';
            const ipThreshold = parseInt(req.body['webhook.ipAlertThreshold'], 10);
            updates['webhook.ipAlertThreshold'] = Number.isFinite(ipThreshold) && ipThreshold >= 1 && ipThreshold <= 10000 ? ipThreshold : 5;
            const ipWindow = parseInt(req.body['webhook.ipAlertWindowMinutes'], 10);
            updates['webhook.ipAlertWindowMinutes'] = Number.isFinite(ipWindow) && ipWindow >= 1 && ipWindow <= 43200 ? ipWindow : 60;
            updates['webhook.ipAlertIncludeIps'] = req.body['webhook.ipAlertIncludeIps'] === 'on';
        }

        // Subscription settings.
        //
        // The Subscription tab is split into multiple <form>s (subscription.ejs,
        // happ.ejs, …), each carrying _subscriptionSettings=1. A submit from any
        // of them must update ONLY the fields that the submitted form actually
        // contains, never wipe fields owned by other cards. Hence every field
        // below goes through setIfPresent — issue #80 was caused by unconditional
        // assignment of subscription.happProviderId, which the main subscription
        // card does not render and therefore silently reset on every save.
        if (req.body['_subscriptionSettings'] !== undefined) {
            const trim = (v) => String(v || '');
            setIfPresent('subscription.supportUrl',     trim);
            setIfPresent('subscription.webPageUrl',     trim);
            setIfPresent('subscription.happProviderId', trim);
            setIfPresent('subscription.logoUrl',        trim);
            setIfPresent('subscription.pageTitle',      trim);
            setIfPresent('subscription.pageNote',       sanitizePageNote);

            setIfPresent('subscription.updateInterval', (v) => {
                const n = parseInt(v, 10);
                return Number.isNaN(n) ? 12 : Math.min(168, Math.max(1, n));
            });

            if (req.body['subscription.buttonsJson'] !== undefined) {
                let parsedButtons = [];
                try { parsedButtons = JSON.parse(req.body['subscription.buttonsJson'] || '[]'); } catch {}
                if (!Array.isArray(parsedButtons)) parsedButtons = [];
                updates['subscription.buttons'] = parsedButtons
                    .filter(b => b && b.label && b.url)
                    .slice(0, 10)
                    .map(b => ({ label: String(b.label).trim(), url: String(b.url).trim(), icon: String(b.icon || '').trim() }));
            }

            // HAPP-specific settings. Text/select fields use setIfPresent; for
            // checkboxes we need the "card was submitted" signal (an absent
            // checkbox means "unchecked", not "field missing").
            const hasHappInBody = Object.keys(req.body).some(k => k.startsWith('subscription.happ.'));

            setIfPresent('subscription.happ.announce', (v) => String(v || '').trim().slice(0, 200));

            if (hasHappInBody) {
                updates['subscription.happ.hideSettings'] = req.body['subscription.happ.hideSettings'] === 'on';
                updates['subscription.happ.notifyExpire'] = req.body['subscription.happ.notifyExpire'] === 'on';
                updates['subscription.happ.alwaysHwid']   = req.body['subscription.happ.alwaysHwid']   === 'on';
            }

            const VALID_PING_TYPES = ['', 'proxy', 'proxy-head', 'tcp', 'icmp'];
            setIfPresent('subscription.happ.pingType', (v) => {
                const raw = String(v || '');
                return VALID_PING_TYPES.includes(raw) ? raw : '';
            });
            setIfPresent('subscription.happ.pingUrl', (v) => String(v || '').trim().slice(0, 500));
            setIfPresent('subscription.happ.colorProfile', (v) => {
                const raw = String(v || '').trim();
                if (!raw) return '';
                if (raw.length > 5120) return '';
                try {
                    const parsed = JSON.parse(raw);
                    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) return '';
                    return JSON.stringify(parsed);
                } catch {
                    return '';
                }
            });

            const VALID_HWID_MODES = ['off', 'permissive', 'strict'];
            setIfPresent('subscription.happ.hwid.mode', (v) => {
                const raw = String(v || 'off');
                return VALID_HWID_MODES.includes(raw) ? raw : 'off';
            });
            setIfPresent('subscription.happ.hwid.inactiveDeviceCleanupDays', (v) => {
                const n = parseInt(v, 10);
                return Number.isFinite(n) ? Math.min(3650, Math.max(7, n)) : 90;
            });
            setIfPresent('subscription.happ.hwid.upsertRateLimitPerMinute', (v) => {
                const n = parseInt(v, 10);
                return Number.isFinite(n) ? Math.min(600, Math.max(1, n)) : 60;
            });
            setIfPresent('subscription.happ.hwid.maxDevicesAnnounce',
                (v) => String(v || '').trim().slice(0, 300));

            // Multiline soft-block remarks. Each non-empty line becomes a
            // separate fake server (parseRemarkLines in subscription.js
            // dedupes and caps per-line length). Here we only normalize
            // line endings and bound the total payload size to keep
            // settings docs small.
            const sanitizeRemark = (raw) => String(raw || '')
                .replace(/\r\n?/g, '\n')
                .replace(/[ \t]+\n/g, '\n')
                .trim()
                .slice(0, 1500);
            setIfPresent('subscription.happ.hwid.notSupportedRemark', sanitizeRemark);
            setIfPresent('subscription.happ.hwid.maxDevicesRemark',   sanitizeRemark);

            // Soft-block for invalid subscriptions: fake locations served to all
            // clients instead of a 403. An absent checkbox means "unchecked",
            // so the enabled flag is forced only when this card was submitted.
            const hasSoftBlockInBody = Object.keys(req.body).some(k => k.startsWith('subscription.softBlock.'));
            if (hasSoftBlockInBody) {
                updates['subscription.softBlock.enabled'] = req.body['subscription.softBlock.enabled'] === 'on';
            }
            const sanitizeAnnounce = (v) => String(v || '').trim().slice(0, 300);
            const sanitizeTitle    = (v) => String(v || '').trim().slice(0, 60);
            for (const k of ['expired', 'disabled', 'trafficExceeded']) {
                setIfPresent(`subscription.softBlock.${k}.remark`,   sanitizeRemark);
                setIfPresent(`subscription.softBlock.${k}.announce`, sanitizeAnnounce);
                setIfPresent(`subscription.softBlock.${k}.title`,    sanitizeTitle);
            }
        }

        // Homepage mode (decoy/custom). File upload has its own endpoint.
        let homepageModeChanged = null;
        let probeTrafficLimit = null;
        if (req.body['_homepageSettings'] !== undefined) {
            const VALID_MODES = ['nginx', 'custom'];
            const mode = String(req.body['homepage.mode'] || 'nginx');
            const safeMode = VALID_MODES.includes(mode) ? mode : 'nginx';
            updates['homepage.mode'] = safeMode;
            homepageModeChanged = safeMode;
        }

        // Routing settings
        if (req.body['_routingSettings'] !== undefined) {
            updates['routing.enabled'] = req.body['routing.enabled'] === 'on';
            updates['routing.dns.domestic'] = (req.body['routing.dns.domestic'] || '77.88.8.8').trim();
            updates['routing.dns.remote']   = (req.body['routing.dns.remote']   || 'tls://1.1.1.1').trim();
            let parsedRules = [];
            try { parsedRules = JSON.parse(req.body['routing.rulesJson'] || '[]'); } catch {}
            if (!Array.isArray(parsedRules)) parsedRules = [];
            const VALID_ACTIONS = ['direct', 'block'];
            const VALID_TYPES   = ['domain_suffix', 'domain_keyword', 'domain', 'geosite', 'geoip', 'ip_cidr'];
            updates['routing.rules'] = parsedRules
                .filter(r => r && VALID_ACTIONS.includes(r.action) && VALID_TYPES.includes(r.type) && r.value)
                .slice(0, 200)
                .map(r => ({
                    action:  r.action,
                    type:    r.type,
                    value:   String(r.value).trim(),
                    comment: String(r.comment || '').trim().slice(0, 100),
                    enabled: r.enabled !== false,
                }));
            // Invalidate all cached subscriptions so clients receive updated rules immediately
            await cache.invalidateAllSubscriptions();
        }

        // Backup settings
        if (req.body['_backupSettings'] || req.body['backup.enabled'] !== undefined) {
            updates['backup.enabled'] = req.body['backup.enabled'] === 'on';
            updates['backup.intervalHours'] = parseInt(req.body['backup.intervalHours']) || 24;
            updates['backup.keepLast'] = parseInt(req.body['backup.keepLast']) || 7;
            // S3
            updates['backup.s3.enabled'] = req.body['backup.s3.enabled'] === 'on';
            updates['backup.s3.endpoint'] = req.body['backup.s3.endpoint'] || '';
            updates['backup.s3.region'] = req.body['backup.s3.region'] || 'us-east-1';
            updates['backup.s3.bucket'] = req.body['backup.s3.bucket'] || '';
            updates['backup.s3.prefix'] = req.body['backup.s3.prefix'] || 'backups';
            updates['backup.s3.accessKeyId'] = req.body['backup.s3.accessKeyId'] || '';
            if (req.body['backup.s3.secretAccessKey']) {
                updates['backup.s3.secretAccessKey'] = cryptoService.encrypt(req.body['backup.s3.secretAccessKey']);
            }
            updates['backup.s3.keepLast'] = parseInt(req.body['backup.s3.keepLast']) || 30;
        }

        // Access-logs settings (opt-in Xray access-log collection & analytics).
        // Its own form carries the _accessLogsSettings marker, so an absent
        // checkbox means "off". Actual node provisioning is kicked off after the
        // settings are persisted (below), never inline with the request.
        let accessLogsToggled = false;
        if (req.body['_accessLogsSettings'] !== undefined) {
            const wantEnabled = req.body['accessLogs.enabled'] === 'on';
            updates['accessLogs.enabled'] = wantEnabled;
            const retention = parseInt(req.body['accessLogs.retentionDays'], 10);
            updates['accessLogs.retentionDays'] = Number.isFinite(retention)
                ? Math.min(3650, Math.max(1, retention)) : 30;

            // External ClickHouse connection. The password is only overwritten
            // when a non-empty value is submitted, so leaving the field blank
            // keeps the stored credential (never wiped by an empty form field).
            updates['accessLogs.clickhouse.host'] = String(req.body['accessLogs.clickhouse.host'] || '').trim().slice(0, 255);
            const chPort = parseInt(req.body['accessLogs.clickhouse.port'], 10);
            updates['accessLogs.clickhouse.port'] = Number.isFinite(chPort)
                ? Math.min(65535, Math.max(1, chPort)) : 8123;
            updates['accessLogs.clickhouse.database'] = String(req.body['accessLogs.clickhouse.database'] || 'default').trim().slice(0, 128);
            updates['accessLogs.clickhouse.username'] = String(req.body['accessLogs.clickhouse.username'] || 'default').trim().slice(0, 128);
            updates['accessLogs.clickhouse.secure'] = req.body['accessLogs.clickhouse.secure'] === 'on';
            const chPassword = req.body['accessLogs.clickhouse.password'];
            if (chPassword !== undefined && chPassword !== '') {
                updates['accessLogs.clickhouse.passwordEncrypted'] = cryptoService.encrypt(String(chPassword));
            }
            const scope = req.body['accessLogs.nodeScope'] === 'selected' ? 'selected' : 'all';
            updates['accessLogs.nodeScope'] = scope;
            const rawNodeIds = req.body['accessLogs.nodeIds'];
            updates['accessLogs.nodeIds'] = rawNodeIds
                ? (Array.isArray(rawNodeIds) ? rawNodeIds : [rawNodeIds]).filter(Boolean)
                : [];
            updates['accessLogs.maskClientIp'] = req.body['accessLogs.maskClientIp'] === 'on';
            // Ingest URL must be an absolute http(s) URL; anything else is
            // silently dropped to the default (derived from BASE_URL).
            const rawIngestUrl = String(req.body['accessLogs.ingestUrl'] || '').trim().slice(0, 500);
            let ingestUrl = '';
            if (rawIngestUrl) {
                try {
                    const u = new URL(rawIngestUrl);
                    if (u.protocol === 'https:' || u.protocol === 'http:') ingestUrl = rawIngestUrl;
                } catch (_) { /* invalid URL -> fall back to derived */ }
            }
            updates['accessLogs.ingestUrl'] = ingestUrl;
            updates['accessLogs.state'] = wantEnabled ? 'enabling' : 'disabling';
            if (wantEnabled) updates['accessLogs.lastEnabledAt'] = new Date();
            accessLogsToggled = true;
        }

        // Probe settings (opt-in external diagnostics). Its own form carries the
        // _probesSettings marker, so an absent checkbox means "off". Sizes are
        // entered in GB/MB and stored as bytes.
        if (req.body['_probesSettings'] !== undefined) {
            const intInRange = (raw, fallback, min, max) => {
                const n = parseInt(raw, 10);
                return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
            };

            updates['probes.enabled'] = req.body['probes.enabled'] === 'on';
            updates['probes.transportIntervalSec'] = intInRange(req.body['probes.transportIntervalSec'], 300, 60, 86400);
            updates['probes.targetsIntervalSec'] = intInRange(req.body['probes.targetsIntervalSec'], 3600, 300, 86400);
            updates['probes.reportIntervalSec'] = intInRange(req.body['probes.reportIntervalSec'], 900, 60, 86400);
            updates['probes.retentionDays'] = intInRange(req.body['probes.retentionDays'], 30, 1, 365);
            updates['probes.probeTrafficLimitBytes'] =
                intInRange(req.body['probes.probeTrafficLimitGB'], 5, 0, 10000) * 1024 * 1024 * 1024;

            updates['probes.speedTest.enabled'] = req.body['probes.speedTest.enabled'] === 'on';
            updates['probes.speedTest.intervalSec'] =
                intInRange(req.body['probes.speedTest.intervalMin'], 180, 5, 1440) * 60;
            updates['probes.speedTest.maxBytes'] =
                intInRange(req.body['probes.speedTest.maxMB'], 20, 1, 1024) * 1024 * 1024;
            updates['probes.speedTest.maxSeconds'] = intInRange(req.body['probes.speedTest.maxSeconds'], 5, 1, 60);
            updates['probes.speedTest.dailyBudgetBytes'] =
                intInRange(req.body['probes.speedTest.dailyBudgetGB'], 1, 0, 1000) * 1024 * 1024 * 1024;

            // Checklist entries are edited as "id|url" lines. Invalid lines are
            // dropped rather than rejected, so one typo cannot block the save.
            const rawTargets = String(req.body['probes.targetsRaw'] || '');
            const seenTargetIds = new Set();
            updates['probes.targets'] = rawTargets
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                    const [id, url, label] = line.split('|').map((part) => (part || '').trim());
                    return { id: id.slice(0, 32), url: (url || '').slice(0, 500), label: (label || '').slice(0, 64) };
                })
                .filter((target) => {
                    if (!target.id || !/^https?:\/\//i.test(target.url)) return false;
                    if (seenTargetIds.has(target.id)) return false;
                    seenTargetIds.add(target.id);
                    return true;
                })
                .slice(0, 25)
                .map((target) => ({ ...target, enabled: true }));

            probeTrafficLimit = updates['probes.probeTrafficLimitBytes'];
        }

        await Settings.update(updates);
        
        await invalidateSettingsCache();
        // Sidebar entries for optional features are cached per process; drop it
        // so a toggled feature appears in the menu on the next page load.
        require('../../utils/featureFlags').invalidateFeatureFlags();
        if (req.body['_backupSettings'] || req.body['backup.enabled'] !== undefined) {
            require('../../services/backupService').resetS3Client();
        }
        try {
            if (cache.isConnected()) await cache.redis.del('panel:topHwidUsers');
        } catch (_e) { /* ignore */ }
        await reloadSettings();

        // Drop subscription cache so load-balancing toggles take effect now,
        // not after subscriptionTTL (up to 1 h).
        if (systemTabSubmit) {
            await cache.invalidateAllSubscriptions();
        }

        if (req.body['_probesSettings'] !== undefined) {
            // Toggling the feature must take effect on the next probe request,
            // not after the ingest route's cache expires.
            try {
                require('../probe').invalidateFeatureCache();
            } catch (_) { /* route not mounted in this process */ }
        }

        // The probe traffic cap only protects the operator if it also applies
        // to probes that already exist.
        if (probeTrafficLimit !== null) {
            try {
                await require('../../services/probes/enrollService')
                    .applyProbeTrafficLimit(probeTrafficLimit);
            } catch (err) {
                logger.warn(`[Panel] Could not apply probe traffic limit: ${err.message}`);
            }
        }
        
        const sshPool = require('../../services/sshPoolService');
        await sshPool.reloadSettings();

        if (homepageModeChanged) {
            await homepageService.setMode(homepageModeChanged);
        }

        // Kick off access-log reconciliation in the background so the request
        // stays fast (Xray restarts on nodes must not block the HTTP response).
        // Also ensure the ClickHouse schema exists and its retention TTL matches
        // the saved setting; both are idempotent and off the request path.
        if (accessLogsToggled) {
            setImmediate(async () => {
                const clickhouse = require('../../services/accessLogs/clickhouseService');
                try {
                    clickhouse.reset();
                    if (await clickhouse.isConfigured()) {
                        await clickhouse.ensureSchema();
                        await clickhouse.applyRetention(updates['accessLogs.retentionDays']);
                    }
                } catch (err) {
                    logger.error('[AccessLogs] ClickHouse setup after settings save failed:', err.message);
                }
                require('../../services/accessLogs/provisionService')
                    .reconcileAll()
                    .catch(err => logger.error('[AccessLogs] Reconcile after settings save failed:', err.message));
            });
        }

        logger.info(`[Panel] Settings updated`);
        
        res.redirect('/panel/settings?message=' + encodeURIComponent(res.locals.t?.('settings.saved') || 'Settings saved'));
    } catch (error) {
        logger.error('[Panel] Settings save error:', error.message);
        res.redirect('/panel/settings?error=' + encodeURIComponent(`${res.locals.t?.('common.error') || 'Error'}: ${error.message}`));
    }
});

// POST /settings/password - Change password
router.post('/settings/password', async (req, res) => {
    try {
        const currentPassword = String(req.body.currentPassword || '');
        const newPassword = String(req.body.newPassword || '');
        const confirmPassword = String(req.body.confirmPassword || '');

        if (!currentPassword || !newPassword || !confirmPassword) {
            return redirectSettingsSecurity(res, { error: res.locals.t?.('settings.passwordFieldsRequired') || 'Fill in all password fields' });
        }

        if (newPassword.length < 6) {
            return redirectSettingsSecurity(res, { error: res.locals.t?.('settings.newPasswordTooShort') || 'New password must be at least 6 characters' });
        }

        if (newPassword !== confirmPassword) {
            return redirectSettingsSecurity(res, { error: res.locals.t?.('setup.passwordsMismatch') || 'Passwords do not match' });
        }

        const admin = await Admin.verifyPassword(req.session.adminUsername, currentPassword);
        if (!admin) {
            return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.invalidCurrentPassword') || 'Invalid current password' });
        }

        if (!admin.twoFactor?.enabled) {
            await Admin.changePassword(req.session.adminUsername, newPassword);

            logger.info(`[Panel] Password changed for: ${req.session.adminUsername}`);
            return redirectSettingsSecurity(res, { message: res.locals.t?.('auth.passwordChanged') || 'Password successfully changed' });
        }

        if (!admin.twoFactor.secretEncrypted) {
            logger.warn(`[Panel] Missing TOTP secret for enabled 2FA on password change: ${req.session.adminUsername} (IP: ${req.ip})`);
            return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.totpConfigError') || 'TOTP configuration error' });
        }

        const newPasswordHash = await bcrypt.hash(newPassword, 12);
        req.session.panelTotpPending = {
            type: 'settings',
            action: 'password_change',
            username: req.session.adminUsername,
            returnTo: '/panel/settings?tab=security',
            payload: {
                newPasswordHash,
            },
            createdAt: Date.now(),
        };

        return res.redirect('/panel/totp');
    } catch (error) {
        logger.error('[Panel] Password change error:', error.message);
        return redirectSettingsSecurity(res, { error: error.message });
    }
});

// POST /settings/totp/start - Start enable/rotate flow
router.post('/settings/totp/start', async (req, res) => {
    try {
        const intent = String(req.body.intent || '').trim();
        const currentPassword = String(req.body.currentPassword || '');

        if (!['enable', 'rotate'].includes(intent)) {
            clearPanelTotpPending(req);
            return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.totpFlowError') || 'Invalid TOTP action' });
        }

        if (!currentPassword) {
            clearPanelTotpPending(req);
            return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.enterCurrentPassword') || 'Enter current password' });
        }

        const admin = await Admin.verifyPassword(req.session.adminUsername, currentPassword);
        if (!admin) {
            clearPanelTotpPending(req);
            return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.invalidCurrentPassword') || 'Invalid current password' });
        }

        if (intent === 'enable') {
            if (admin.twoFactor?.enabled) {
                clearPanelTotpPending(req);
                return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.totpAlreadyEnabled') || 'TOTP is already enabled' });
            }

            const enrollment = await totpService.generateEnrollmentData({ username: admin.username });
            req.session.panelTotpPending = {
                type: 'settings',
                action: 'totp_enable_enroll',
                username: admin.username,
                returnTo: '/panel/settings?tab=security',
                secretEncrypted: enrollment.secretEncrypted,
                createdAt: Date.now(),
            };

            return res.redirect('/panel/totp');
        }

        if (!admin.twoFactor?.enabled || !admin.twoFactor?.secretEncrypted) {
            clearPanelTotpPending(req);
            return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.totpRequiredForRotate') || 'TOTP must be enabled to rotate' });
        }

        req.session.panelTotpPending = {
            type: 'settings',
            action: 'totp_rotate_verify_current',
            username: admin.username,
            returnTo: '/panel/settings?tab=security',
            payload: {
                currentSecretEncrypted: admin.twoFactor.secretEncrypted,
            },
            createdAt: Date.now(),
        };

        return res.redirect('/panel/totp');
    } catch (error) {
        clearPanelTotpPending(req);
        logger.error('[Panel] Settings TOTP start error:', error.message);
        return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.totpFlowError') || 'Error starting TOTP flow' });
    }
});

// POST /settings/totp/disable - Disable TOTP for current admin
router.post('/settings/totp/disable', async (req, res) => {
    try {
        const currentPassword = String(req.body.currentPassword || '');

        if (!currentPassword) {
            return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.enterCurrentPassword') || 'Enter current password' });
        }

        const admin = await Admin.verifyPassword(req.session.adminUsername, currentPassword);
        if (!admin) {
            return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.invalidCurrentPassword') || 'Invalid current password' });
        }

        if (!admin.twoFactor?.enabled || !admin.twoFactor?.secretEncrypted) {
            return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.totpAlreadyDisabled') || 'TOTP is already disabled' });
        }

        req.session.panelTotpPending = {
            type: 'settings',
            action: 'totp_disable_verify_current',
            username: admin.username,
            returnTo: '/panel/settings?tab=security',
            payload: {
                currentSecretEncrypted: admin.twoFactor.secretEncrypted,
            },
            createdAt: Date.now(),
        };

        return res.redirect('/panel/totp');
    } catch (error) {
        logger.error('[Panel] Settings TOTP disable error:', error.message);
        return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.totpDisableError') || 'Error disabling TOTP' });
    }
});

// POST /settings/reset-traffic - Reset traffic counters for all users
router.post('/settings/reset-traffic', async (req, res) => {
    try {
        const now = new Date();
        const result = await HyUser.updateMany(
            {},
            {
                $set: {
                    'traffic.tx': 0,
                    'traffic.rx': 0,
                    'traffic.lastUpdate': now,
                }
            }
        );

        logger.warn(`[Panel] Traffic reset for ${result.modifiedCount} users by admin: ${req.session.adminUsername}`);

        // Renewal-by-reset: bring back users whose only reason to be disabled
        // was hitting their traffic limit. Filter `enabled:false, !expired,
        // trafficLimit>0` — those are the over-traffic auto-disabled set
        // (after the reset above their counter is 0, so they're under-limit).
        const reenableCandidates = await HyUser.find(
            {
                enabled: false,
                trafficLimit: { $gt: 0 },
                $or: [
                    { expireAt: null },
                    { expireAt: { $exists: false } },
                    { expireAt: { $gt: now } },
                ],
            },
            { userId: 1, subscriptionToken: 1, xrayUuid: 1, nodes: 1, groups: 1 }
        ).lean();

        let reenabledCount = 0;
        if (reenableCandidates.length > 0) {
            const ids = reenableCandidates.map(u => u._id);
            const flip = await HyUser.updateMany(
                { _id: { $in: ids }, enabled: false },
                { $set: { enabled: true } }
            );
            reenabledCount = flip.modifiedCount;

            for (const u of reenableCandidates) {
                syncService.addUserToAllXrayNodes(u).catch(() => {});
                webhookService.emit(webhookService.EVENTS.USER_ENABLED, { userId: u.userId });
            }
        }

        const users = await HyUser.find({}).select('userId subscriptionToken').lean();
        const invalidateTasks = users.flatMap((user) => {
            const tasks = [() => cache.invalidateUser(user.userId)];
            if (user.subscriptionToken) {
                tasks.push(() => cache.invalidateSubscription(user.subscriptionToken));
            }
            return tasks;
        });

        const BATCH_SIZE = 100;
        for (let i = 0; i < invalidateTasks.length; i += BATCH_SIZE) {
            await Promise.all(invalidateTasks.slice(i, i + BATCH_SIZE).map((task) => task()));
        }

        await cache.invalidateDashboardCounts();
        await cache.invalidateTrafficStats();

        if (reenabledCount > 0) {
            logger.info(`[Panel] Auto-reenabled ${reenabledCount} over-traffic user(s) after bulk reset`);
        }

        res.json({
            success: true,
            count: result.modifiedCount,
            reenabled: reenabledCount,
            message: `Трафик сброшен у ${result.modifiedCount} пользователей`
        });
    } catch (error) {
        logger.error('[Panel] Traffic reset error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /settings/reset-stats - Reset statistics
router.post('/settings/reset-stats', async (req, res) => {
    try {
        const StatsSnapshot = require('../../models/statsSnapshotModel');
        const result = await StatsSnapshot.deleteMany({});
        
        logger.warn(`[Panel] Stats reset: ${result.deletedCount} snapshots deleted by admin: ${req.session.adminUsername}`);
        
        const statsService = require('../../services/statsService');
        await statsService.invalidateCache();
        
        res.json({ 
            success: true, 
            count: result.deletedCount,
            message: `Удалено ${result.deletedCount} записей статистики`
        });
    } catch (error) {
        logger.error('[Panel] Stats reset error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== HOMEPAGE ====================

// In-memory upload (one small file). Disk write is handled atomically by homepageService.
const homepageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: homepageService.MAX_CUSTOM_BYTES, files: 1 },
});

// POST /settings/homepage/upload - replace custom homepage HTML
router.post('/settings/homepage/upload', (req, res) => {
    homepageUpload.single('file')(req, res, async (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? (res.locals.t?.('settings.homepageFileTooLarge') || 'File too large (max {bytes} bytes)').replace('{bytes}', homepageService.MAX_CUSTOM_BYTES)
                : err.message;
            return res.redirect('/panel/settings?tab=security&error=' + encodeURIComponent(msg));
        }
        if (!req.file) {
            return res.redirect('/panel/settings?tab=security&error=' + encodeURIComponent(res.locals.t?.('settings.homepageNoFile') || 'No file uploaded'));
        }
        try {
            await homepageService.setCustom(req.file.buffer);
            await Settings.update({ 'homepage.mode': 'custom' });
            await homepageService.setMode('custom');
            logger.info(`[Panel] Homepage custom HTML uploaded (${req.file.buffer.length} bytes) by ${req.session.adminUsername}`);
            return res.redirect('/panel/settings?tab=security&message=' + encodeURIComponent(res.locals.t?.('settings.homepageUpdated') || 'Homepage updated'));
        } catch (error) {
            logger.error(`[Panel] Homepage upload error: ${error.message}`);
            return res.redirect('/panel/settings?tab=security&error=' + encodeURIComponent(error.message));
        }
    });
});

// POST /settings/homepage/reset - drop custom HTML, revert to fake nginx
router.post('/settings/homepage/reset', async (req, res) => {
    try {
        await homepageService.clearCustom();
        await Settings.update({ 'homepage.mode': 'nginx' });
        logger.info(`[Panel] Homepage reset to default by ${req.session.adminUsername}`);
        return res.redirect('/panel/settings?tab=security&message=' + encodeURIComponent(res.locals.t?.('settings.homepageResetDone') || 'Homepage reset to default'));
    } catch (error) {
        logger.error(`[Panel] Homepage reset error: ${error.message}`);
        return res.redirect('/panel/settings?tab=security&error=' + encodeURIComponent(error.message));
    }
});

// POST /settings/flush-cache - Flush all Redis cache
router.post('/settings/flush-cache', async (req, res) => {
    try {
        const result = await cache.flushAll();
        
        if (result.success) {
            logger.info(`[Panel] Cache flushed by admin: ${req.session.adminUsername}`);
            res.json({ success: true, message: 'Cache cleared' });
        } else {
            res.status(500).json({ success: false, error: result.error || 'Failed to flush cache' });
        }
    } catch (error) {
        logger.error('[Panel] Cache flush error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== BACKUP SETTINGS ====================

// POST /settings/create-backup - Create backup now
router.post('/settings/create-backup', async (req, res) => {
    try {
        const backupService = require('../../services/backupService');
        const settings = await Settings.get();
        
        const result = await backupService.createBackup(settings);
        
        res.json({
            success: true,
            filename: result.filename,
            size: result.sizeMB,
            s3: result.s3,
        });
    } catch (error) {
        logger.error(`[Backup] Manual backup error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// POST /settings/test-s3 - Test S3 connection
router.post('/settings/test-s3', async (req, res) => {
    try {
        const backupService = require('../../services/backupService');
        const { endpoint, region, bucket, prefix, accessKeyId, secretAccessKey } = req.body;
        
        if (!bucket || !accessKeyId || !secretAccessKey) {
            return res.status(400).json({ error: res.locals.t?.('settings.s3RequiredFields') || 'Bucket, Access Key and Secret Key are required' });
        }
        
        const result = await backupService.testS3Connection({
            endpoint,
            region: region || 'us-east-1',
            bucket,
            prefix: prefix || 'backups',
            accessKeyId,
            secretAccessKey,
        });
        
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /settings/test-clickhouse - Verify ClickHouse credentials before saving.
router.post('/settings/test-clickhouse', async (req, res) => {
    try {
        const clickhouse = require('../../services/accessLogs/clickhouseService');
        const host = String(req.body.host || '').trim();
        if (!host) {
            return res.status(400).json({ error: res.locals.t?.('accessLogs.chHostRequired') || 'Host is required' });
        }
        // If the password field was left blank, fall back to the stored one so a
        // test on an existing config does not require re-typing the secret.
        let passwordEncrypted = '';
        if (!req.body.password) {
            const settings = await Settings.get();
            passwordEncrypted = settings?.accessLogs?.clickhouse?.passwordEncrypted || '';
        }
        const result = await clickhouse.testConnection({
            host,
            port: req.body.port,
            database: req.body.database,
            username: req.body.username,
            password: req.body.password || '',
            passwordEncrypted,
            secure: req.body.secure === 'on' || req.body.secure === true || req.body.secure === 'true',
        });
        if (result.ok) {
            res.json({ success: true, version: result.version });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /settings/backups - List local backups
router.get('/settings/backups', async (req, res) => {
    try {
        const backupService = require('../../services/backupService');
        const backups = await backupService.listBackups();
        res.json({ backups });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /settings/backups-s3 - List S3 backups
router.get('/settings/backups-s3', async (req, res) => {
    try {
        const backupService = require('../../services/backupService');
        const settings = await Settings.get();
        
        if (!settings?.backup?.s3?.enabled) {
            return res.json({ backups: [], error: 'S3 not configured' });
        }
        
        const backups = await backupService.listS3Backups(settings);
        res.json({ backups });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /settings/backups/download - Download a local backup file
// Query: ?name=celerity-backup-YYYY-MM-DDTHH-mm-ss.tar.gz
router.get('/settings/backups/download', async (req, res) => {
    try {
        const backupService = require('../../services/backupService');
        const fsSync = require('fs');

        const name = String(req.query.name || '');
        const localPath = backupService.getLocalBackupPath(name);

        let stats;
        try {
            stats = await require('fs').promises.stat(localPath);
        } catch {
            return res.status(404).json({ error: 'Backup file not found' });
        }

        const safeName = require('path').basename(localPath);
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        res.setHeader('Cache-Control', 'no-store');

        const stream = fsSync.createReadStream(localPath);
        stream.on('error', (err) => {
            logger.error(`[Backup] Local download stream error: ${err.message}`);
            if (!res.headersSent) res.status(500).end();
            else res.destroy(err);
        });
        stream.pipe(res);

        logger.info(`[Panel] Backup download (local): ${safeName} by ${req.session.adminUsername}`);
    } catch (error) {
        logger.error(`[Panel] Backup download error: ${error.message}`);
        if (!res.headersSent) res.status(400).json({ error: error.message });
    }
});

// GET /settings/backups-s3/download - Download an S3 backup file
// Query: ?key=<full S3 object key>
router.get('/settings/backups-s3/download', async (req, res) => {
    try {
        const backupService = require('../../services/backupService');
        const path = require('path');

        const key = String(req.query.key || '').trim();
        if (!key) return res.status(400).json({ error: 'Key is required' });

        const settings = await Settings.get();
        if (!settings?.backup?.s3?.enabled) {
            return res.status(400).json({ error: 'S3 not configured' });
        }

        // Sanity check: key must live in the configured prefix to prevent
        // arbitrary object reads from the bucket via this endpoint.
        const prefix = settings.backup.s3.prefix || 'backups';
        if (!backupService.isBackupKeyForPrefix(key, prefix)) {
            return res.status(400).json({ error: 'Invalid backup key' });
        }

        const { stream, contentLength, contentType } = await backupService.getS3BackupStream(settings, key);

        const safeName = path.basename(key);
        res.setHeader('Content-Type', contentType || 'application/gzip');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        res.setHeader('Cache-Control', 'no-store');

        stream.on('error', (err) => {
            logger.error(`[Backup] S3 download stream error: ${err.message}`);
            if (!res.headersSent) res.status(500).end();
            else res.destroy(err);
        });
        stream.pipe(res);

        logger.info(`[Panel] Backup download (S3): ${safeName} by ${req.session.adminUsername}`);
    } catch (error) {
        logger.error(`[Panel] S3 backup download error: ${error.message}`);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

// POST /settings/restore-backup - Restore from backup (local or S3)
router.post('/settings/restore-backup', async (req, res) => {
    try {
        const backupService = require('../../services/backupService');
        const settings = await Settings.get();
        const { source, identifier } = req.body;
        
        if (!source || !identifier) {
            return res.status(400).json({ error: 'Source and identifier required' });
        }
        
        if (source !== 'local' && source !== 's3') {
            return res.status(400).json({ error: 'Invalid source' });
        }
        
        if (source === 's3' && !settings?.backup?.s3?.enabled) {
            return res.status(400).json({ error: 'S3 not configured' });
        }
        
        logger.info(`[Restore] Starting restore from ${source}: ${identifier}`);
        
        const result = await backupService.restoreBackup(settings, source, identifier);

        logger.info(`[Restore] Completed successfully`);

        res.json({
            success: true,
            message: 'Database restored successfully',
            warning: result?.encryptionKey?.status === 'mismatch'
                ? (res.locals.t?.('settings.restoreKeyMismatch') || 'Backup was created with a different ENCRYPTION_KEY')
                : null,
        });
    } catch (error) {
        logger.error(`[Restore] Error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ==================== API KEYS ====================

// POST /api-keys - Create a new API key (returns plaintext key once)
router.post('/api-keys', async (req, res) => {
    try {
        const { name, scopes, allowedIPs, rateLimit, expiresAt } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const scopesArr = scopes
            ? (Array.isArray(scopes) ? scopes : [scopes])
            : [];

        const invalidScopes = scopesArr.filter(s => !ApiKey.VALID_SCOPES.includes(s));
        if (invalidScopes.length > 0) {
            return res.status(400).json({ error: `Invalid scopes: ${invalidScopes.join(', ')}` });
        }

        const allowedIPsArr = allowedIPs
            ? allowedIPs.split('\n').map(s => s.trim()).filter(Boolean)
            : [];

        const { doc, plainKey } = await ApiKey.createKey({
            name: name.trim(),
            scopes: scopesArr,
            allowedIPs: allowedIPsArr,
            rateLimit: parseInt(rateLimit) || 60,
            expiresAt: expiresAt || null,
            createdBy: req.session.adminUsername,
        });

        logger.info(`[Panel] API key created: "${doc.name}" (${doc.keyPrefix}...) by ${req.session.adminUsername}`);

        res.json({ success: true, key: plainKey, doc });
    } catch (error) {
        logger.error(`[Panel] API key create error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// POST /api-keys/:id/toggle - Enable/disable a key
router.post('/api-keys/:id/toggle', async (req, res) => {
    try {
        const key = await ApiKey.findById(req.params.id);
        if (!key) {
            return res.status(404).json({ error: 'API key not found' });
        }

        key.active = !key.active;
        await key.save();

        logger.info(`[Panel] API key ${key.keyPrefix}... ${key.active ? 'enabled' : 'disabled'} by ${req.session.adminUsername}`);
        res.json({ success: true, active: key.active });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api-keys/:id/delete - Delete a key
router.post('/api-keys/:id/delete', async (req, res) => {
    try {
        const key = await ApiKey.findByIdAndDelete(req.params.id);
        if (!key) {
            return res.status(404).json({ error: 'API key not found' });
        }

        logger.info(`[Panel] API key "${key.name}" (${key.keyPrefix}...) deleted by ${req.session.adminUsername}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /settings/test-webhook - Send test webhook
router.post('/settings/test-webhook', async (req, res) => {
    try {
        const { url, secret, event } = req.body;

        if (!url || !url.trim()) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Whitelist event against EVENTS to prevent spoofing arbitrary headers.
        const knownEvents = Object.values(webhookService.EVENTS);
        const safeEvent = event && knownEvents.includes(event) ? event : undefined;

        const result = await webhookService.test(url.trim(), secret || '', safeEvent);

        if (result.success) {
            logger.info(`[Panel] Webhook test OK: ${url} (HTTP ${result.status})${safeEvent ? ` event=${safeEvent}` : ''}`);
            res.json({ success: true, status: result.status });
        } else {
            res.status(400).json({ success: false, error: result.error, status: result.status });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== PANEL UPDATE ====================

// Forced GitHub re-check is a network egress operation; keep it modest.
const checkUpdatesLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: res.locals.t?.('common.tooManyRequests') || 'Too many requests. Try again later.' }),
});

// Applying an update is the most privileged action in the panel; strict bucket.
const applyUpdateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: res.locals.t?.('common.tooManyRequests') || 'Too many requests. Try again later.' }),
});

// GET /settings/update-status - Versions (cached) + updater sidecar status +
// panel-side flow state (pre-update backup / trigger progress).
router.get('/settings/update-status', async (req, res) => {
    try {
        const [versionInfo, updater] = await Promise.all([
            updateService.getVersionInfo({ force: false }),
            updateService.getUpdaterStatus({ force: false }),
        ]);
        res.json({ ...versionInfo, updater, flow: updateService.getUpdateFlow() });
    } catch (error) {
        logger.error('[Panel] update-status error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// POST /settings/check-updates - Force refresh the GitHub release cache.
// Only the release feed is re-fetched; the updater sidecar status comes from
// the micro-cache (a version check must not cost an extra sidecar round-trip).
router.post('/settings/check-updates', checkUpdatesLimiter, async (req, res) => {
    try {
        const versionInfo = await updateService.getVersionInfo({ force: true });
        const updater = await updateService.getUpdaterStatus({ force: false });
        res.json({ ...versionInfo, updater });
    } catch (error) {
        logger.error('[Panel] check-updates error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// POST /settings/apply-update - Re-auth, back up, then trigger the updater.
// Body: { version, currentPassword, totpToken?, backup?: boolean }
router.post('/settings/apply-update', applyUpdateLimiter, async (req, res) => {
    try {
        if (!updateService.isUpdaterConfigured()) {
            return res.status(409).json({ error: res.locals.t?.('settings.updateUpdaterUnavailable') || 'Updater is not available for this deployment' });
        }

        const version = String(req.body.version || '').trim();
        const currentPassword = String(req.body.currentPassword || '');
        const totpToken = String(req.body.totpToken || '');
        // Default to creating a backup unless the client explicitly opts out.
        const wantBackup = req.body.backup !== false && req.body.backup !== 'false';

        if (!version) {
            return res.status(400).json({ error: res.locals.t?.('settings.updateVersionRequired') || 'Version is required' });
        }

        // Re-authenticate the admin (password, plus TOTP when enabled).
        const admin = await Admin.verifyPassword(req.session.adminUsername, currentPassword);
        if (!admin) {
            return res.status(401).json({ error: res.locals.t?.('auth.invalidCurrentPassword') || 'Invalid current password' });
        }
        if (admin.twoFactor?.enabled) {
            // Empty covers both a missing secret and one that cannot be decrypted
            // with the current ENCRYPTION_KEY — neither can ever verify a code.
            const secret = totpService.decryptSecret(admin.twoFactor.secretEncrypted);
            if (!secret) {
                return res.status(500).json({ error: res.locals.t?.('auth.totpConfigError') || 'TOTP configuration error' });
            }
            const validToken = await totpService.verifyToken({ secret, token: totpToken });
            if (!validToken) {
                return res.status(401).json({ error: res.locals.t?.('auth.invalidCurrentTotp') || 'Invalid TOTP code' });
            }
        }

        // Whitelist: only versions returned by the GitHub release feed may pass.
        const known = await updateService.isKnownRelease(version);
        if (!known) {
            return res.status(400).json({ error: res.locals.t?.('settings.updateUnknownVersion') || 'Unknown version' });
        }

        // Kick off the flow (optional backup + updater trigger) in the
        // background and answer immediately: a mongodump can run for minutes,
        // far beyond sane HTTP/proxy timeouts. Progress is polled via
        // update-status. A backup failure aborts the flow before the updater
        // is ever contacted.
        const flow = updateService.startUpdateFlow(version, { backup: wantBackup });

        logger.warn(`[Panel] Update to ${version} triggered by admin: ${req.session.adminUsername} (IP: ${req.ip})`);

        res.status(202).json({ accepted: true, version, flow });
    } catch (error) {
        logger.error('[Panel] apply-update error:', error.message);
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

module.exports = router;
