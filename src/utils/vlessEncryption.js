'use strict';

/**
 * VLESS Encryption (Xray-core `mlkem768x25519plus`) for client-facing inbounds.
 *
 * The panel owns the key material: the server key is generated here, stored
 * encrypted with the panel ENCRYPTION_KEY and never leaves the panel except
 * inside the node config. The client key is derived from it and published in
 * subscriptions. Strings follow the `xray vlessenc` layout:
 *   server: mlkem768x25519plus.<mode>.<ticket>.<serverKey>
 *   client: mlkem768x25519plus.<mode>.0rtt.<clientKey>
 */

const crypto = require('crypto');
const cryptoService = require('../services/cryptoService');

const PREFIX = 'mlkem768x25519plus';
// First release with the current string format (v25.9.5 dropped server-side "1rtt").
const MIN_XRAY_VERSION = '25.9.5';
const MAIN_INBOUND_ID = 'main';

const AUTH_VALUES = ['x25519', 'mlkem768'];
const MODE_VALUES = ['native', 'xorpub', 'random'];
const DEFAULT_AUTH = 'x25519';
const DEFAULT_MODE = 'native';
const DEFAULT_TICKET = '600s';
const MAX_TICKET_SECONDS = 86400;

// Raw key sizes Xray accepts: x25519 private/public, ML-KEM-768 seed (d||z)/encapsulation key.
const KEY_BYTES = {
    x25519: { server: 32, client: 32 },
    mlkem768: { server: 64, client: 1184 },
};

const KEY_FIELDS = ['vlessEncryptionPrivateKey', 'vlessEncryptionPublicKey'];
const FIELDS = ['vlessEncryption', 'vlessEncryptionAuth', 'vlessEncryptionMode', 'vlessEncryptionTicket', ...KEY_FIELDS];

let mlKemModule = null;
async function loadMlKem() {
    // ESM-only package, loaded on first ML-KEM key generation only.
    if (!mlKemModule) mlKemModule = await import('@noble/post-quantum/ml-kem.js');
    return mlKemModule.ml_kem768;
}

function pickEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

/**
 * Normalize a ticket lifetime: "0s" (0-RTT disabled), "Ns" or "A-Bs".
 * @returns {string|null} canonical value, DEFAULT_TICKET for empty input, null when invalid
 */
function normalizeTicket(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return DEFAULT_TICKET;
    const match = /^(\d{1,5})(?:-(\d{1,5}))?s$/.exec(raw);
    if (!match) return null;
    const from = Number(match[1]);
    if (match[2] === undefined) {
        return from <= MAX_TICKET_SECONDS ? `${from}s` : null;
    }
    const to = Number(match[2]);
    if (from < 1 || to < from || to > MAX_TICKET_SECONDS) return null;
    return `${from}-${to}s`;
}

function isRawKey(value, bytes) {
    const str = String(value || '');
    if (!/^[A-Za-z0-9_-]+$/.test(str)) return false;
    const buf = Buffer.from(str, 'base64url');
    return buf.length === bytes && buf.toString('base64url') === str;
}

function decryptServerKey(stored, auth) {
    if (!stored || !KEY_BYTES[auth]) return null;
    let plain;
    try {
        plain = cryptoService.decrypt(stored);
    } catch (_) {
        return null;
    }
    return isRawKey(plain, KEY_BYTES[auth].server) ? plain : null;
}

async function deriveClientKey(auth, serverKey) {
    if (auth === 'mlkem768') {
        const mlKem = await loadMlKem();
        const seed = Buffer.from(serverKey, 'base64url');
        try {
            return Buffer.from(mlKem.keygen(seed).publicKey).toString('base64url');
        } finally {
            seed.fill(0);
        }
    }
    return cryptoService.deriveX25519PublicKey(serverKey);
}

async function generateKeys(auth) {
    if (auth === 'mlkem768') {
        const seed = crypto.randomBytes(KEY_BYTES.mlkem768.server);
        try {
            const serverKey = seed.toString('base64url');
            return { serverKey, clientKey: await deriveClientKey(auth, serverKey) };
        } finally {
            seed.fill(0);
        }
    }
    const { privateKey, publicKey } = cryptoService.generateX25519KeysLocal();
    return { serverKey: privateKey, clientKey: publicKey };
}

/**
 * Normalize VLESS Encryption fields of one inbound and settle its keys.
 * Mutates `next`. Keys sent by the caller are always discarded: the previous
 * key is kept while auth is unchanged, otherwise a fresh one is generated.
 *
 * @param {Object} next - Inbound about to be persisted (main xray object or an extra)
 * @param {Object} [prev] - Same inbound as currently stored
 * @param {Object} [opts]
 * @param {boolean} [opts.regenerate] - Drop the stored key
 * @param {string} [opts.label] - Prefix for error messages
 * @returns {Promise<string|null>} error message or null
 */
async function applyVlessEncryption(next, prev, { regenerate = false, label = 'Inbound' } = {}) {
    if (!next) return null;
    const stored = {
        enabled: prev?.vlessEncryption,
        auth: prev?.vlessEncryptionAuth,
        mode: prev?.vlessEncryptionMode,
        ticket: prev?.vlessEncryptionTicket,
        privateKey: prev?.vlessEncryptionPrivateKey,
        publicKey: prev?.vlessEncryptionPublicKey,
    };
    for (const field of KEY_FIELDS) delete next[field];

    const enabled = (next.vlessEncryption ?? stored.enabled) === true;
    const auth = pickEnum(next.vlessEncryptionAuth ?? stored.auth, AUTH_VALUES, DEFAULT_AUTH);
    const mode = pickEnum(next.vlessEncryptionMode ?? stored.mode, MODE_VALUES, DEFAULT_MODE);
    const ticket = normalizeTicket(next.vlessEncryptionTicket ?? stored.ticket);

    if (enabled && !ticket) {
        return `${label}: VLESS Encryption ticket must be 0s, Ns or A-Bs (up to ${MAX_TICKET_SECONDS}s).`;
    }
    if (enabled && (next.transport || 'tcp') === 'tcp' && next.security === 'tls'
        && String(next.fallbackDest || '').trim()) {
        return `${label}: Xray does not allow fallbacks together with VLESS Encryption — clear the fallback dest first.`;
    }

    next.vlessEncryption = enabled;
    next.vlessEncryptionAuth = auth;
    next.vlessEncryptionMode = mode;
    next.vlessEncryptionTicket = ticket || DEFAULT_TICKET;

    const storedAuth = pickEnum(stored.auth, AUTH_VALUES, DEFAULT_AUTH);
    const serverKey = !regenerate && auth === storedAuth
        ? decryptServerKey(stored.privateKey, auth)
        : null;

    if (serverKey) {
        next.vlessEncryptionPrivateKey = stored.privateKey;
        next.vlessEncryptionPublicKey = isRawKey(stored.publicKey, KEY_BYTES[auth].client)
            ? stored.publicKey
            : await deriveClientKey(auth, serverKey);
    } else if (enabled) {
        const keys = await generateKeys(auth);
        next.vlessEncryptionPrivateKey = cryptoService.encrypt(keys.serverKey);
        next.vlessEncryptionPublicKey = keys.clientKey;
    } else {
        next.vlessEncryptionPrivateKey = '';
        next.vlessEncryptionPublicKey = '';
    }
    return null;
}

/**
 * Apply VLESS Encryption to the main inbound and every extra inbound.
 * Extras are matched with their stored copy by id.
 *
 * @param {Object} nextXray - xray object about to be persisted
 * @param {Object} [prevXray] - currently stored xray object
 * @param {Iterable<string>} [regenerateIds] - 'main' and/or extra ids to rekey
 * @returns {Promise<string|null>} error message or null
 */
async function applyVlessEncryptionToXray(nextXray, prevXray, regenerateIds = []) {
    if (!nextXray) return null;
    const regenerate = new Set(Array.from(regenerateIds || [], id => String(id)));
    const mainError = await applyVlessEncryption(nextXray, prevXray, {
        regenerate: regenerate.has(MAIN_INBOUND_ID),
        label: 'Main inbound',
    });
    if (mainError) return mainError;

    const prevExtras = new Map((Array.isArray(prevXray?.extraInbounds) ? prevXray.extraInbounds : [])
        .map(inbound => [String(inbound?.id || ''), inbound]));
    const extras = Array.isArray(nextXray.extraInbounds) ? nextXray.extraInbounds : [];
    for (let i = 0; i < extras.length; i++) {
        const id = String(extras[i]?.id || '');
        const error = await applyVlessEncryption(extras[i], prevExtras.get(id), {
            regenerate: regenerate.has(id),
            label: `Extra inbound #${i + 1}`,
        });
        if (error) return error;
    }
    return null;
}

/**
 * Pull API-style `vlessEncryptionRegenerate: true` flags out of an xray patch.
 * @returns {string[]} 'main' and/or extra ids
 */
function takeRegenerateIds(xray) {
    const ids = [];
    if (!xray || typeof xray !== 'object') return ids;
    if (xray.vlessEncryptionRegenerate === true) ids.push(MAIN_INBOUND_ID);
    delete xray.vlessEncryptionRegenerate;
    for (const inbound of (Array.isArray(xray.extraInbounds) ? xray.extraInbounds : [])) {
        if (!inbound || typeof inbound !== 'object') continue;
        if (inbound.vlessEncryptionRegenerate === true && inbound.id) ids.push(String(inbound.id));
        delete inbound.vlessEncryptionRegenerate;
    }
    return ids;
}

function encryptionError(message) {
    const error = new Error(message);
    error.code = 'VLESS_ENCRYPTION_KEY_INVALID';
    return error;
}

/**
 * Server-side `decryption` value for a VLESS inbound.
 * Throws VLESS_ENCRYPTION_KEY_INVALID rather than silently falling back to
 * "none", which would desync the node from published subscriptions.
 */
function buildServerDecryption(inbound, { redactSecrets = false } = {}) {
    if (inbound?.vlessEncryption !== true) return 'none';
    const auth = pickEnum(inbound.vlessEncryptionAuth, AUTH_VALUES, null);
    const mode = pickEnum(inbound.vlessEncryptionMode, MODE_VALUES, null);
    const ticket = normalizeTicket(inbound.vlessEncryptionTicket);
    if (redactSecrets) return `${PREFIX}.${mode || DEFAULT_MODE}.${ticket || DEFAULT_TICKET}.<redacted>`;
    const serverKey = auth ? decryptServerKey(inbound.vlessEncryptionPrivateKey, auth) : null;
    if (!mode || !ticket || !serverKey) {
        throw encryptionError(`VLESS Encryption settings of inbound "${inbound.inboundTag || 'vless-in'}" are invalid — regenerate the key and save the node.`);
    }
    return `${PREFIX}.${mode}.${ticket}.${serverKey}`;
}

/**
 * Client-side `encryption` value, or null when the inbound is not encrypted
 * (or its stored client key is unusable).
 */
function buildClientEncryption(inbound) {
    if (inbound?.vlessEncryption !== true) return null;
    const auth = pickEnum(inbound.vlessEncryptionAuth, AUTH_VALUES, null);
    const mode = pickEnum(inbound.vlessEncryptionMode, MODE_VALUES, null);
    if (!auth || !mode || !isRawKey(inbound.vlessEncryptionPublicKey, KEY_BYTES[auth].client)) return null;
    return `${PREFIX}.${mode}.0rtt.${inbound.vlessEncryptionPublicKey}`;
}

function hasEnabledInbound(xray) {
    if (!xray) return false;
    if (xray.vlessEncryption === true) return true;
    return Array.isArray(xray.extraInbounds)
        && xray.extraInbounds.some(inbound => inbound?.vlessEncryption === true);
}

/**
 * Why `version` of Xray cannot serve the encrypted inbounds of `xray`, or null.
 * An unknown version passes: the sync-time `xray -test` still guards the node.
 */
function versionError(xray, version, nodeName = 'node') {
    if (!hasEnabledInbound(xray)) return null;
    const xrayVersionService = require('../services/xrayVersionService');
    const normalized = xrayVersionService.normalizeVersion(version || '');
    if (!normalized) return null;
    if (xrayVersionService.compareVersions(normalized, MIN_XRAY_VERSION) < 0) {
        return `VLESS Encryption requires Xray >= ${MIN_XRAY_VERSION}, ${nodeName} runs ${normalized}`;
    }
    return null;
}

/**
 * Drop VLESS Encryption keys from an xray object in place (clone prefill, render).
 */
function stripVlessEncryptionKeys(xray, { keepPublic = false } = {}) {
    if (!xray) return xray;
    const fields = keepPublic ? ['vlessEncryptionPrivateKey'] : KEY_FIELDS;
    for (const field of fields) delete xray[field];
    if (Array.isArray(xray.extraInbounds)) {
        xray.extraInbounds = xray.extraInbounds.map((inbound) => {
            const copy = { ...inbound };
            for (const field of fields) delete copy[field];
            return copy;
        });
    }
    return xray;
}

/**
 * Plain copy of a node document without the VLESS Encryption server keys,
 * for API responses.
 */
function redactNode(node) {
    if (!node) return node;
    const plain = typeof node.toObject === 'function' ? node.toObject() : { ...node };
    if (plain.xray) plain.xray = stripVlessEncryptionKeys({ ...plain.xray }, { keepPublic: true });
    return plain;
}

// Mongo projection that hides the server keys from API responses.
const PRIVATE_KEY_EXCLUDE = '-xray.vlessEncryptionPrivateKey -xray.extraInbounds.vlessEncryptionPrivateKey';

module.exports = {
    PREFIX,
    MIN_XRAY_VERSION,
    AUTH_VALUES,
    MODE_VALUES,
    DEFAULT_AUTH,
    DEFAULT_MODE,
    DEFAULT_TICKET,
    KEY_BYTES,
    FIELDS,
    PRIVATE_KEY_EXCLUDE,
    normalizeTicket,
    applyVlessEncryption,
    applyVlessEncryptionToXray,
    takeRegenerateIds,
    buildServerDecryption,
    buildClientEncryption,
    hasEnabledInbound,
    versionError,
    stripVlessEncryptionKeys,
    redactNode,
    deriveClientKey,
};
