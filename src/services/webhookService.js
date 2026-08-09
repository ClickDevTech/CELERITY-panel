/**
 * Webhook service
 *
 * Sends event notifications to a configured URL.
 * Delivery is fire-and-forget (async, non-blocking, 5s timeout).
 *
 * Each request is signed with HMAC-SHA256:
 *   X-Webhook-Signature: sha256=<hmac>
 *   X-Webhook-Event:     <event>
 *   X-Webhook-Timestamp: <unix seconds>
 *
 * Verification (receiver side):
 *   expected = HMAC-SHA256(secret, timestamp + "." + rawBody)
 *   compare with X-Webhook-Signature header value (after "sha256=")
 */

const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');
const cryptoService = require('./cryptoService');

const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * All supported event names
 */
const EVENTS = {
    USER_CREATED: 'user.created',
    USER_UPDATED: 'user.updated',
    USER_DELETED: 'user.deleted',
    USER_ENABLED: 'user.enabled',
    USER_DISABLED: 'user.disabled',
    USER_TRAFFIC_EXCEEDED: 'user.traffic_exceeded',
    USER_EXPIRED: 'user.expired',
    /** First time a new HWID registers for this user (subscription fetch). */
    USER_DEVICE_ADDED: 'user.device_added',
    /** Emitted once per panel process per user when HWID limit blocks subscription. */
    USER_DEVICE_LIMIT_REACHED: 'user.device_limit_reached',
    /** User connected from more unique IPs than the configured threshold (access logs). */
    USER_IP_LIMIT_EXCEEDED: 'user.ip_limit_exceeded',
    NODE_ONLINE: 'node.online',
    NODE_OFFLINE: 'node.offline',
    NODE_ERROR: 'node.error',
    SYNC_COMPLETED: 'sync.completed',
    /** Panel host free disk space dropped below the warning threshold. */
    HOST_DISK_LOW: 'host.disk_low',
    /** Panel host free disk space dropped below the critical threshold. */
    HOST_DISK_CRITICAL: 'host.disk_critical',
    /** Panel host free disk space recovered above the warning threshold. */
    HOST_DISK_RECOVERED: 'host.disk_recovered',
    /** External diagnostic probe stopped reporting. */
    PROBE_OFFLINE: 'probe.offline',
    /** A probe could not reach a node inbound; payload carries the failure code. */
    PROBE_NODE_UNREACHABLE: 'probe.node_unreachable',
    /** A checklist resource became unreachable through a node (geo-block, blacklist). */
    PROBE_TARGET_UNREACHABLE: 'probe.target_unreachable',
};

/** Dedup device-limit webhooks (in-memory; resets on restart). */
const _deviceLimitNotified = new Set();

/**
 * Compute HMAC-SHA256 signature
 */
function sign(secret, timestamp, body) {
    const payload = `${timestamp}.${body}`;
    return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Load webhook settings (uses helpers to get cached settings)
 */
async function getWebhookSettings() {
    const { getSettings } = require('../utils/helpers');
    const settings = await getSettings();
    return settings?.webhook || null;
}

/**
 * Send an event to the configured webhook URL.
 * Non-blocking — errors are only logged.
 *
 * @param {string} event  - One of EVENTS.*
 * @param {object} data   - Event payload
 */
async function send(event, data) {
    let webhookSettings;
    try {
        webhookSettings = await getWebhookSettings();
    } catch (err) {
        logger.error(`[Webhook] Failed to load settings: ${err.message}`);
        return;
    }

    if (!webhookSettings || !webhookSettings.enabled || !webhookSettings.url) return;

    // Filter by configured events (empty = all)
    const allowedEvents = webhookSettings.events || [];
    if (allowedEvents.length > 0 && !allowedEvents.includes(event)) return;

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        data,
    });

    const secret = cryptoService.decryptSafe(webhookSettings.secret) || '';
    const signature = sign(secret, timestamp, payload);

    try {
        await axios.post(webhookSettings.url, payload, {
            timeout: WEBHOOK_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Event': event,
                'X-Webhook-Timestamp': timestamp,
                'X-Webhook-Signature': signature,
                'User-Agent': 'C3-Celerity-Webhook/1.0',
            },
        });
        logger.debug(`[Webhook] Sent ${event} to ${webhookSettings.url}`);
    } catch (err) {
        const status = err.response?.status;
        logger.warn(`[Webhook] Delivery failed for ${event}: ${status ? `HTTP ${status}` : err.message}`);
    }
}

/**
 * Fire-and-forget wrapper — never throws, never awaits
 */
function emit(event, data) {
    send(event, data).catch(() => {});
}

/**
 * Emit user.device_limit_reached at most once per userId until process restart
 * or until clearDeviceLimitNotified(userId) is called.
 * @param {string} userId
 * @param {object} data
 */
function emitDeviceLimitReachedOnce(userId, data) {
    if (_deviceLimitNotified.has(userId)) return;
    _deviceLimitNotified.add(userId);
    emit(EVENTS.USER_DEVICE_LIMIT_REACHED, { userId, ...data });
}

/**
 * Reset the in-memory dedup flag so the next limit hit emits a fresh webhook.
 * Call after admin actions that can unblock the user (device unlink, raise limit,
 * disable HWID enforcement, user deletion).
 * @param {string} userId
 */
function clearDeviceLimitNotified(userId) {
    if (!userId) return;
    _deviceLimitNotified.delete(userId);
}

// Sample payload builders for each known event. Functions (not literals) so
// timestamps reflect the moment of the test, not module load time.
const _SAMPLE_BUILDERS = {
    'user.created': () => ({ userId: 'sample-user', username: 'sample', groups: [] }),
    'user.updated': () => ({ userId: 'sample-user', updates: { trafficLimit: 10737418240 } }),
    'user.deleted': () => ({ userId: 'sample-user' }),
    'user.enabled': () => ({ userId: 'sample-user' }),
    'user.disabled': () => ({ userId: 'sample-user' }),
    'user.traffic_exceeded': () => ({ userId: 'sample-user', usedBytes: 10737418240, limitBytes: 10737418240 }),
    'user.expired': () => ({ userId: 'sample-user', expireAt: new Date().toISOString() }),
    'user.device_added': () => ({ userId: 'sample-user', hwid: 'sample-hwid', userAgent: 'Sample/1.0' }),
    'user.device_limit_reached': () => ({ userId: 'sample-user', maxDevices: 2 }),
    'user.ip_limit_exceeded': () => ({ userId: 'sample-user', ips: 8, threshold: 5, windowMinutes: 60, ipList: ['1.2.3.4', '5.6.7.8'] }),
    'node.online': () => ({ nodeId: 'sample-node', name: 'Sample Node' }),
    'node.offline': () => ({ nodeId: 'sample-node', name: 'Sample Node', lastError: 'connection refused' }),
    'node.error': () => ({ nodeId: 'sample-node', name: 'Sample Node', error: 'sample error' }),
    'sync.completed': () => ({ ok: 1, failed: 0, totalUsers: 1 }),
    'host.disk_low': () => ({ path: '/', freeBytes: 2147483648, totalBytes: 53687091200, usedPct: 96, level: 'low' }),
    'host.disk_critical': () => ({ path: '/', freeBytes: 1073741824, totalBytes: 53687091200, usedPct: 98, level: 'critical' }),
    'host.disk_recovered': () => ({ path: '/', freeBytes: 10737418240, totalBytes: 53687091200, usedPct: 80, level: 'ok' }),
    'probe.offline': () => ({ probeId: 'sample-probe', probeName: 'Moscow', country: 'RU', asn: 'AS12345', lastSeenAt: new Date().toISOString() }),
    'probe.node_unreachable': () => ({ probeId: 'sample-probe', probeName: 'Moscow', country: 'RU', asn: 'AS12345', nodeId: 'sample-node', nodeName: 'Sample Node', inboundId: 'main', code: 'handshake_failed', message: 'tls handshake timeout' }),
    'probe.target_unreachable': () => ({ probeId: 'sample-probe', probeName: 'Moscow', country: 'RU', asn: 'AS12345', nodeId: 'sample-node', nodeName: 'Sample Node', targetId: 'openai', httpStatus: 403, message: 'blocked' }),
};

function _sampleDataFor(event) {
    const build = _SAMPLE_BUILDERS[event];
    return build ? build() : { message: 'Test webhook from C³ CELERITY' };
}

/**
 * Test webhook delivery (used by UI "Test" button).
 * Returns { success, status, error }
 *
 * @param {string} url    - Receiver URL
 * @param {string} secret - HMAC secret (plaintext)
 * @param {string} [event] - Optional event name; when set and known, the
 *        request mirrors the production payload (including X-Webhook-Event)
 *        so admins can validate the real shape per event.
 */
async function test(url, secret, event) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const isKnownEvent = !!(event && Object.values(EVENTS).includes(event));
    const eventName = isKnownEvent ? event : 'test';
    const data = isKnownEvent
        ? _sampleDataFor(event)
        : { message: 'Test webhook from C³ CELERITY' };

    const payload = JSON.stringify({
        event: eventName,
        timestamp: new Date().toISOString(),
        data,
    });

    const signature = sign(secret || '', timestamp, payload);

    try {
        const response = await axios.post(url, payload, {
            timeout: WEBHOOK_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Event': eventName,
                'X-Webhook-Timestamp': timestamp,
                'X-Webhook-Signature': signature,
                'User-Agent': 'C3-Celerity-Webhook/1.0',
            },
        });
        return { success: true, status: response.status };
    } catch (err) {
        return {
            success: false,
            status: err.response?.status || null,
            error: err.message,
        };
    }
}

module.exports = {
    emit,
    send,
    test,
    EVENTS,
    emitDeviceLimitReachedOnce,
    clearDeviceLimitNotified,
};
