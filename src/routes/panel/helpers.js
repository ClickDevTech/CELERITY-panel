/**
 * Shared helpers for panel routes.
 * Form parsers, SSH utils, render engine, middleware, TOTP utilities.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const ejs = require('ejs');
const { Client: SSHClient } = require('ssh2');

const cryptoService = require('../../services/cryptoService');
const totpService = require('../../services/totpService');
const config = require('../../../config');
const logger = require('../../utils/logger');
const { parseDurationSeconds } = require('../../utils/helpers');
const { isServerlessNode } = require('../../utils/nodeTypes');
const {
    XHTTP_DATA_PLACEMENT_VALUES,
    XHTTP_METHOD_VALUES,
    XHTTP_PADDING_METHOD_VALUES,
    XHTTP_PADDING_PLACEMENT_VALUES,
    XHTTP_PLACEMENT_VALUES,
    XHTTP_SESSION_TABLE_VALUES,
    sanitizeXhttpRange,
    validateXhttpInbound,
} = require('../../utils/xhttpOptions');
const { formatTraffic } = require('../../utils/formatTraffic');
const {
    normalizeFingerprint,
    normalizeFingerprintPool,
} = require('../../utils/fingerprints');
const { version: appVersion } = require('../../../package.json');

// Compiled template cache (production only)
const templateCache = new Map();

// Multer for backup file uploads
const backupUpload = multer({
    dest: '/tmp/backup-uploads/',
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.tar.gz') || file.originalname.endsWith('.tgz')) {
            cb(null, true);
        } else {
            cb(new Error('Only .tar.gz or .tgz files are allowed'));
        }
    }
});

// ─── SSH Helpers ─────────────────────────────────────────────────────────────

function buildSshKeyFilename(node) {
    const safe = (value, fallback) => {
        const normalized = String(value || '')
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        return normalized || fallback;
    };

    return `${safe(node.name, 'node')}-${safe(node.ip, 'unknown')}.key`;
}

function connectNodeSSH(node) {
    return new Promise((resolve, reject) => {
        const client = new SSHClient();
        const connConfig = {
            host: node.ip,
            port: node.ssh?.port || 22,
            username: node.ssh?.username || 'root',
            readyTimeout: 20000,
        };
        if (node.ssh?.privateKey) {
            connConfig.privateKey = cryptoService.decryptPrivateKey(node.ssh.privateKey);
        } else if (node.ssh?.password) {
            connConfig.password = cryptoService.decryptSafe(node.ssh.password);
        } else {
            return reject(new Error('SSH credentials not configured'));
        }
        client.on('ready', () => resolve(client));
        client.on('error', (err) => reject(err));
        client.connect(connConfig);
    });
}

// ─── Form Parsers ────────────────────────────────────────────────────────────

// Whitelists used by parseXrayFormFields/parseExtraInbounds.
// Any value outside the whitelist is replaced with the default to keep the
// stored config strictly within the schema enum (defense-in-depth).
const XRAY_TRANSPORT_VALUES = ['tcp', 'ws', 'grpc', 'xhttp'];
const XRAY_SECURITY_VALUES = ['reality', 'tls', 'none'];
const XRAY_XHTTP_MODE_VALUES = ['auto', 'packet-up', 'stream-up', 'stream-one'];
const XRAY_TLS_SOURCE_VALUES = ['panel', 'acme', 'manual', 'self-signed'];
const XRAY_XHTTP_METHOD_VALUES = XHTTP_METHOD_VALUES;
const XRAY_XHTTP_DATA_PLACEMENT_VALUES = XHTTP_DATA_PLACEMENT_VALUES;
const XRAY_XHTTP_PLACEMENT_VALUES = XHTTP_PLACEMENT_VALUES;
const XRAY_XHTTP_PADDING_PLACEMENT_VALUES = XHTTP_PADDING_PLACEMENT_VALUES;

const ACME_EMAIL_RE = /^(?=.{3,254}$)[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

// VLESS fallbacks[].dest: port | host:port | [v6]:port | unix:/path
const FALLBACK_DEST_RE = /^(?:\d{1,5}|[A-Za-z0-9._\-]{1,253}:\d{1,5}|\[[0-9A-Fa-f:]{2,45}\]:\d{1,5}|unix:\/[^\0\s]{1,250})$/;
// Sentinel value rendered into the manualKey textarea when an existing key is
// already stored in the database, so the operator can edit other fields without
// the actual private key reaching the browser. When the form is submitted with
// this exact value, the route must keep the previously stored manualKey.
const MANUAL_KEY_PLACEHOLDER = '***SET***';

// Loose hostname check used for tlsSource==='manual' — accepts standard DNS
// labels, dotted FQDNs and lowercase ASCII. Avoids ReDoS by limiting length.
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function _pickEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function _splitCsv(raw, { keepEmpty = false } = {}) {
    if (raw === undefined || raw === null) return null;
    const list = String(raw).split(',').map(s => s.trim());
    return keepEmpty ? list : list.filter(Boolean);
}

const _sanitizeXhttpRange = sanitizeXhttpRange;

/**
 * Parse the `xray.extraInbounds[]` array out of parallel form arrays
 * (xray_extra_id[], xray_extra_port[], xray_extra_*[]). Each index across the
 * arrays describes a single inbound. Indices with a missing/invalid port are
 * dropped. Returns [] when no extra inbounds were submitted.
 */
function parseExtraInbounds(body) {
    const ids = body.xray_extra_id;
    if (!ids) return [];
    const idArr = Array.isArray(ids) ? ids : [ids];
    if (idArr.length === 0) return [];

    const arr = (key) => {
        const v = body[key];
        if (v === undefined) return [];
        return Array.isArray(v) ? v : [v];
    };
    const ports = arr('xray_extra_port');
    const listens = arr('xray_extra_listen');
    const labels = arr('xray_extra_label');
    // Unchecked checkboxes are not submitted, so we identify "uniqueName" rows
    // by the inbound id used as the checkbox value (kept stable on the form).
    const uniqueNameIds = new Set(arr('xray_extra_uniqueName').map(v => String(v || '')));
    const tags = arr('xray_extra_inboundTag');
    const transports = arr('xray_extra_transport');
    const securities = arr('xray_extra_security');
    const flows = arr('xray_extra_flow');
    const fingerprints = arr('xray_extra_fingerprint');
    const fingerprintPools = arr('xray_extra_fingerprintPool');
    const alpns = arr('xray_extra_alpn');
    const realityDests = arr('xray_extra_realityDest');
    const realitySnis = arr('xray_extra_realitySni');
    const realityPriv = arr('xray_extra_realityPrivateKey');
    const realityPub = arr('xray_extra_realityPublicKey');
    const realityShortIds = arr('xray_extra_realityShortIds');
    const realitySpiderX = arr('xray_extra_realitySpiderX');
    const wsPaths = arr('xray_extra_wsPath');
    const wsHosts = arr('xray_extra_wsHost');
    const grpcServiceNames = arr('xray_extra_grpcServiceName');
    const xhttpPaths = arr('xray_extra_xhttpPath');
    const xhttpHosts = arr('xray_extra_xhttpHost');
    const xhttpModes = arr('xray_extra_xhttpMode');
    const xhttpXPaddingBytes = arr('xray_extra_xhttpXPaddingBytes');
    const xhttpScMaxEachPostBytes = arr('xray_extra_xhttpScMaxEachPostBytes');
    // Same checkbox trick as uniqueName above — the value is the row's id.
    const xhttpNoGrpcHeaderIds = new Set(arr('xray_extra_xhttpNoGrpcHeader').map(v => String(v || '')));
    const xhttpXmuxMaxConcurrency = arr('xray_extra_xhttpXmuxMaxConcurrency');
    const xhttpXmuxHMaxRequestTimes = arr('xray_extra_xhttpXmuxHMaxRequestTimes');
    const xhttpXmuxHMaxReusableSecs = arr('xray_extra_xhttpXmuxHMaxReusableSecs');
    const xhttpUplinkHTTPMethods = arr('xray_extra_xhttpUplinkHTTPMethod');
    const xhttpUplinkDataPlacements = arr('xray_extra_xhttpUplinkDataPlacement');
    const xhttpUplinkDataKeys = arr('xray_extra_xhttpUplinkDataKey');
    const xhttpUplinkChunkSizes = arr('xray_extra_xhttpUplinkChunkSize');
    const xhttpScMinPostsIntervalMs = arr('xray_extra_xhttpScMinPostsIntervalMs');
    const xhttpServerMaxHeaderBytes = arr('xray_extra_xhttpServerMaxHeaderBytes');
    const xhttpXPaddingObfsModeIds = new Set(arr('xray_extra_xhttpXPaddingObfsMode').map(v => String(v || '')));
    const xhttpXPaddingKeys = arr('xray_extra_xhttpXPaddingKey');
    const xhttpXPaddingHeaders = arr('xray_extra_xhttpXPaddingHeader');
    const xhttpXPaddingPlacements = arr('xray_extra_xhttpXPaddingPlacement');
    const xhttpXPaddingMethods = arr('xray_extra_xhttpXPaddingMethod');
    const xhttpSessionPlacements = arr('xray_extra_xhttpSessionPlacement');
    const xhttpSessionKeys = arr('xray_extra_xhttpSessionKey');
    const xhttpSessionIDTables = arr('xray_extra_xhttpSessionIDTable');
    const xhttpSessionIDLengths = arr('xray_extra_xhttpSessionIDLength');
    const xhttpSeqPlacements = arr('xray_extra_xhttpSeqPlacement');
    const xhttpSeqKeys = arr('xray_extra_xhttpSeqKey');
    const fallbackDests = arr('xray_extra_fallbackDest');

    const result = [];
    for (let i = 0; i < idArr.length; i++) {
        const port = parseInt(ports[i], 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            // Mismatched parallel arrays or browser-side `required` bypass.
            // Drop silently from the model but warn in the log so admins can
            // diagnose disappearing rows.
            logger.warn(`[parseExtraInbounds] Dropping row #${i + 1}: invalid or missing port (raw=${JSON.stringify(ports[i])})`);
            continue;
        }

        const transport = _pickEnum(transports[i], XRAY_TRANSPORT_VALUES, 'tcp');
        const security = _pickEnum(securities[i], XRAY_SECURITY_VALUES, 'reality');

        const id = String(idArr[i] || '').trim() || `extra-${i + 1}`;
        const inbound = {
            id,
            label: String(labels[i] || '').trim().slice(0, 64),
            uniqueName: uniqueNameIds.has(id),
            port,
            listen: String(listens[i] || '').trim() || '0.0.0.0',
            inboundTag: String(tags[i] || '').trim() || `vless-extra-${i + 1}`,
            transport,
            security,
            flow: String(flows[i] !== undefined ? flows[i] : 'xtls-rprx-vision'),
            fingerprint: normalizeFingerprint(fingerprints[i]),
            fingerprintPool: normalizeFingerprintPool(fingerprintPools[i]),
            alpn: alpns[i] !== undefined ? (_splitCsv(alpns[i]) || []) : [],
            realityDest: String(realityDests[i] || 'www.google.com:443'),
            realitySni: realitySnis[i] !== undefined
                ? (_splitCsv(realitySnis[i]) || ['www.google.com'])
                : ['www.google.com'],
            realityPrivateKey: String(realityPriv[i] || ''),
            realityPublicKey: String(realityPub[i] || ''),
            realityShortIds: realityShortIds[i] !== undefined
                ? (_splitCsv(realityShortIds[i], { keepEmpty: true }) || [''])
                : [''],
            realitySpiderX: String(realitySpiderX[i] || ''),
            wsPath: String(wsPaths[i] || '/'),
            wsHost: String(wsHosts[i] || ''),
            grpcServiceName: String(grpcServiceNames[i] || 'grpc'),
            xhttpPath: String(xhttpPaths[i] || '/'),
            xhttpHost: String(xhttpHosts[i] || ''),
            xhttpMode: _pickEnum(xhttpModes[i], XRAY_XHTTP_MODE_VALUES, 'auto'),
            xhttpXPaddingBytes: _sanitizeXhttpRange(xhttpXPaddingBytes[i]),
            xhttpScMaxEachPostBytes: _sanitizeXhttpRange(xhttpScMaxEachPostBytes[i]),
            xhttpNoGrpcHeader: xhttpNoGrpcHeaderIds.has(id),
            xhttpXmuxMaxConcurrency: _sanitizeXhttpRange(xhttpXmuxMaxConcurrency[i]),
            xhttpXmuxHMaxRequestTimes: _sanitizeXhttpRange(xhttpXmuxHMaxRequestTimes[i]),
            xhttpXmuxHMaxReusableSecs: _sanitizeXhttpRange(xhttpXmuxHMaxReusableSecs[i]),
            xhttpUplinkHTTPMethod: _pickEnum(xhttpUplinkHTTPMethods[i], XRAY_XHTTP_METHOD_VALUES, ''),
            xhttpUplinkDataPlacement: _pickEnum(xhttpUplinkDataPlacements[i], XRAY_XHTTP_DATA_PLACEMENT_VALUES, ''),
            xhttpUplinkDataKey: String(xhttpUplinkDataKeys[i] || '').trim().slice(0, 64),
            xhttpUplinkChunkSize: _sanitizeXhttpRange(xhttpUplinkChunkSizes[i]),
            xhttpScMinPostsIntervalMs: _sanitizeXhttpRange(xhttpScMinPostsIntervalMs[i]),
            xhttpServerMaxHeaderBytes: Math.min(Math.max(parseInt(xhttpServerMaxHeaderBytes[i], 10) || 0, 0), 1048576),
            xhttpXPaddingObfsMode: xhttpXPaddingObfsModeIds.has(id),
            xhttpXPaddingKey: String(xhttpXPaddingKeys[i] || '').trim().slice(0, 64),
            xhttpXPaddingHeader: String(xhttpXPaddingHeaders[i] || '').trim().slice(0, 64),
            xhttpXPaddingPlacement: _pickEnum(xhttpXPaddingPlacements[i], XRAY_XHTTP_PADDING_PLACEMENT_VALUES, ''),
            xhttpXPaddingMethod: _pickEnum(xhttpXPaddingMethods[i], XHTTP_PADDING_METHOD_VALUES, ''),
            xhttpSessionPlacement: _pickEnum(xhttpSessionPlacements[i], XRAY_XHTTP_PLACEMENT_VALUES, ''),
            xhttpSessionKey: String(xhttpSessionKeys[i] || '').trim().slice(0, 64),
            xhttpSessionIDTable: _pickEnum(xhttpSessionIDTables[i], XHTTP_SESSION_TABLE_VALUES, ''),
            xhttpSessionIDLength: _sanitizeXhttpRange(xhttpSessionIDLengths[i]),
            xhttpSeqPlacement: _pickEnum(xhttpSeqPlacements[i], XRAY_XHTTP_PLACEMENT_VALUES, ''),
            xhttpSeqKey: String(xhttpSeqKeys[i] || '').trim().slice(0, 64),
            fallbackDest: String(fallbackDests[i] || '').trim().slice(0, 253),
        };
        // Empty short-id list is invalid for Reality; restore the empty marker.
        if (inbound.realityShortIds.length === 0) inbound.realityShortIds = [''];
        result.push(inbound);
    }
    return result;
}

function parseXrayFormFields(body) {
    const xray = {};

    if (body['xray.listen'] !== undefined) {
        xray.listen = String(body['xray.listen'] || '').trim() || '0.0.0.0';
    }
    if (body['xray.transport']) {
        xray.transport = _pickEnum(body['xray.transport'], XRAY_TRANSPORT_VALUES, 'tcp');
    }
    if (body['xray.security']) {
        xray.security = _pickEnum(body['xray.security'], XRAY_SECURITY_VALUES, 'reality');
    }
    if (body['xray.flow'] !== undefined) xray.flow = body['xray.flow'];
    if (body['xray.fingerprint']) {
        xray.fingerprint = normalizeFingerprint(body['xray.fingerprint']);
    }
    if (body['xray.fingerprintPool'] !== undefined) {
        xray.fingerprintPool = normalizeFingerprintPool(body['xray.fingerprintPool']);
    }

    if (body['xray.alpn'] !== undefined) {
        const alpnStr = body['xray.alpn'].trim();
        xray.alpn = alpnStr ? alpnStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    }

    if (body['xray.realityDest']) xray.realityDest = body['xray.realityDest'];
    if (body['xray.realityPrivateKey'] !== undefined) xray.realityPrivateKey = body['xray.realityPrivateKey'];
    if (body['xray.realityPublicKey'] !== undefined) xray.realityPublicKey = body['xray.realityPublicKey'];
    if (body['xray.realitySpiderX'] !== undefined) xray.realitySpiderX = body['xray.realitySpiderX'];

    if (body['xray.realitySni']) {
        xray.realitySni = body['xray.realitySni']
            .split(',').map(s => s.trim()).filter(Boolean);
    }
    if (body['xray.realityShortIds'] !== undefined) {
        xray.realityShortIds = body['xray.realityShortIds']
            .split(',').map(s => s.trim());
        if (xray.realityShortIds.length === 0) xray.realityShortIds = [''];
    }

    if (body['xray.wsPath'] !== undefined) xray.wsPath = body['xray.wsPath'];
    if (body['xray.wsHost'] !== undefined) xray.wsHost = body['xray.wsHost'];
    if (body['xray.grpcServiceName']) xray.grpcServiceName = body['xray.grpcServiceName'];
    if (body['xray.xhttpPath'] !== undefined) xray.xhttpPath = body['xray.xhttpPath'];
    if (body['xray.xhttpHost'] !== undefined) xray.xhttpHost = body['xray.xhttpHost'];
    if (body['xray.xhttpMode']) {
        xray.xhttpMode = _pickEnum(body['xray.xhttpMode'], XRAY_XHTTP_MODE_VALUES, 'auto');
    }
    if (body['xray.xhttpXPaddingBytes'] !== undefined) {
        xray.xhttpXPaddingBytes = _sanitizeXhttpRange(body['xray.xhttpXPaddingBytes']);
    }
    if (body['xray.xhttpScMaxEachPostBytes'] !== undefined) {
        xray.xhttpScMaxEachPostBytes = _sanitizeXhttpRange(body['xray.xhttpScMaxEachPostBytes']);
    }
    xray.xhttpNoGrpcHeader = body['xray.xhttpNoGrpcHeader'] === 'on';
    if (body['xray.xhttpXmuxMaxConcurrency'] !== undefined) {
        xray.xhttpXmuxMaxConcurrency = _sanitizeXhttpRange(body['xray.xhttpXmuxMaxConcurrency']);
    }
    if (body['xray.xhttpXmuxHMaxRequestTimes'] !== undefined) {
        xray.xhttpXmuxHMaxRequestTimes = _sanitizeXhttpRange(body['xray.xhttpXmuxHMaxRequestTimes']);
    }
    if (body['xray.xhttpXmuxHMaxReusableSecs'] !== undefined) {
        xray.xhttpXmuxHMaxReusableSecs = _sanitizeXhttpRange(body['xray.xhttpXmuxHMaxReusableSecs']);
    }
    xray.xhttpUplinkHTTPMethod = _pickEnum(body['xray.xhttpUplinkHTTPMethod'], XRAY_XHTTP_METHOD_VALUES, '');
    xray.xhttpUplinkDataPlacement = _pickEnum(body['xray.xhttpUplinkDataPlacement'], XRAY_XHTTP_DATA_PLACEMENT_VALUES, '');
    xray.xhttpUplinkDataKey = String(body['xray.xhttpUplinkDataKey'] || '').trim().slice(0, 64);
    xray.xhttpUplinkChunkSize = _sanitizeXhttpRange(body['xray.xhttpUplinkChunkSize']);
    xray.xhttpScMinPostsIntervalMs = _sanitizeXhttpRange(body['xray.xhttpScMinPostsIntervalMs']);
    xray.xhttpServerMaxHeaderBytes = Math.min(
        Math.max(parseInt(body['xray.xhttpServerMaxHeaderBytes'], 10) || 0, 0),
        1048576
    );
    xray.xhttpXPaddingObfsMode = body['xray.xhttpXPaddingObfsMode'] === 'on';
    xray.xhttpXPaddingKey = String(body['xray.xhttpXPaddingKey'] || '').trim().slice(0, 64);
    xray.xhttpXPaddingHeader = String(body['xray.xhttpXPaddingHeader'] || '').trim().slice(0, 64);
    xray.xhttpXPaddingPlacement = _pickEnum(body['xray.xhttpXPaddingPlacement'], XRAY_XHTTP_PADDING_PLACEMENT_VALUES, '');
    xray.xhttpXPaddingMethod = _pickEnum(body['xray.xhttpXPaddingMethod'], XHTTP_PADDING_METHOD_VALUES, '');
    xray.xhttpSessionPlacement = _pickEnum(body['xray.xhttpSessionPlacement'], XRAY_XHTTP_PLACEMENT_VALUES, '');
    xray.xhttpSessionKey = String(body['xray.xhttpSessionKey'] || '').trim().slice(0, 64);
    xray.xhttpSessionIDTable = _pickEnum(body['xray.xhttpSessionIDTable'], XHTTP_SESSION_TABLE_VALUES, '');
    xray.xhttpSessionIDLength = _sanitizeXhttpRange(body['xray.xhttpSessionIDLength']);
    xray.xhttpSeqPlacement = _pickEnum(body['xray.xhttpSeqPlacement'], XRAY_XHTTP_PLACEMENT_VALUES, '');
    xray.xhttpSeqKey = String(body['xray.xhttpSeqKey'] || '').trim().slice(0, 64);
    if (body['xray.apiPort']) xray.apiPort = parseInt(body['xray.apiPort']) || 61000;

    if (body['xray.fallbackDest'] !== undefined) {
        xray.fallbackDest = String(body['xray.fallbackDest']).trim().slice(0, 253);
    }

    // TLS source / manual cert+key (only meaningful when security==='tls').
    // Parsed unconditionally so toggling security back to tls preserves prior
    // operator input, and dropped server-side via validation when irrelevant.
    if (body['xray.tlsSource']) {
        xray.tlsSource = _pickEnum(body['xray.tlsSource'], XRAY_TLS_SOURCE_VALUES, 'panel');
    }
    if (body['xray.manualCert'] !== undefined) {
        // Normalize CRLF, drop a trailing newline; keep PEM block as-is.
        xray.manualCert = String(body['xray.manualCert']).replace(/\r\n?/g, '\n').trim();
    }
    if (body['xray.manualKey'] !== undefined) {
        // Submission may contain MANUAL_KEY_PLACEHOLDER when the operator did
        // not retype the key. The route layer is responsible for replacing
        // this sentinel with the previously stored value before persisting.
        xray.manualKey = String(body['xray.manualKey']).replace(/\r\n?/g, '\n').trim();
    }
    if (body['xray.acmeEmail'] !== undefined) {
        // Empty = fall back to panel-wide ACME_EMAIL at install time.
        xray.acmeEmail = String(body['xray.acmeEmail']).trim().slice(0, 254);
    }

    // Always parse extra inbounds — pass [] explicitly when none submitted so
    // the route can persist a "delete-all" intent. Callers that do not want to
    // touch extras can just delete the field from the result.
    xray.extraInbounds = parseExtraInbounds(body);

    return xray;
}

/**
 * Server-side validation for the parsed xray block. Mirrors the client-side
 * checks (see views/partials/node-form/scripts.ejs) to provide a fail-safe
 * defense layer (Rule #2). Returns the first error message or null when valid.
 *
 * Validates:
 *  - Main and extra inbound listen values are IPv4 or IPv6 literals
 *  - Each extra inbound port is a valid number in 1..65535
 *  - Ports are unique across: node.port, xray.apiPort, xray.agentPort, extras
 *  - Inbound tags are non-empty, alphanumeric/dash/underscore, unique,
 *    and do not collide with the main inbound tag
 *
 * @param {Object} xray - Parsed xray sub-object (already through parseXrayFormFields)
 * @param {Object} node - The node form payload (for `port`); xray fields take
 *                       precedence when both are provided.
 * @returns {string|null}
 */
function validateXrayFormFields(xray, node) {
    const mainListen = String(xray?.listen || '0.0.0.0').trim();
    if (!net.isIP(mainListen)) {
        return 'Main inbound: listen must be a valid IPv4 or IPv6 address.';
    }

    // TLS-source-specific validation is independent of extra inbounds, run
    // it first so the early-return below does not mask manual-PEM mistakes.
    const tlsSecurity = (xray?.security === 'tls');
    if (tlsSecurity && xray?.tlsSource === 'acme') {
        const domain = String(node?.domain || '').trim().toLowerCase();
        if (!domain) {
            return 'ACME mode requires a domain — fill in the Domain field in the Network section.';
        }
        if (!HOSTNAME_RE.test(domain)) {
            return 'ACME mode: domain looks invalid (expected an FQDN like node1.example.com).';
        }
        const email = String(xray?.acmeEmail || '').trim();
        if (email && !ACME_EMAIL_RE.test(email)) {
            return 'ACME mode: email looks invalid (expected admin@example.com).';
        }
    }
    if (tlsSecurity && xray?.tlsSource === 'manual') {
        const domain = String(node?.domain || '').trim().toLowerCase();
        if (!domain) {
            return 'Manual TLS requires a domain — fill in the Domain field in the Network section.';
        }
        if (!HOSTNAME_RE.test(domain)) {
            return 'Manual TLS: domain looks invalid (expected an FQDN like example.com).';
        }
        const certPem = String(xray.manualCert || '');
        const keyPem = String(xray.manualKey || '');
        if (!certPem || !/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(certPem)) {
            return 'Manual TLS: certificate PEM is missing or malformed (expected -----BEGIN CERTIFICATE----- block).';
        }
        // The key is allowed to be the placeholder during edits — the route
        // restores the previous DB value before validation runs in that case.
        // Backreference forces matching prefixes between BEGIN and END markers.
        if (!keyPem || keyPem === MANUAL_KEY_PLACEHOLDER ||
            !/-----BEGIN (RSA |EC |ECDSA |)PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/.test(keyPem)) {
            return 'Manual TLS: private key PEM is missing or malformed.';
        }
        // Authoritative cert/key match check using node:crypto. Wrap in
        // try/catch — never let a malformed PEM crash the request thread.
        try {
            // eslint-disable-next-line no-new
            new crypto.X509Certificate(certPem);
        } catch (err) {
            // Do NOT surface stack/raw err.message verbatim (may include PEM
            // fragments). Log the digest for debugging instead.
            const digest = crypto.createHash('sha256').update(certPem).digest('hex').slice(0, 8);
            logger.warn(`[validateXrayFormFields] Invalid certificate PEM (sha256=${digest}): ${err.code || 'parse error'}`);
            return 'Manual TLS: certificate PEM could not be parsed.';
        }
        try {
            const keyObj = crypto.createPrivateKey(keyPem);
            const cert = new crypto.X509Certificate(certPem);
            // Prefer cert.checkPrivateKey (Node ≥18.7); fall back to comparing
            // the SubjectPublicKeyInfo DER of cert.publicKey vs the public key
            // derived from keyObj.
            let matches;
            if (typeof cert.checkPrivateKey === 'function') {
                matches = cert.checkPrivateKey(keyObj);
            } else {
                const certPubDer = cert.publicKey.export({ type: 'spki', format: 'der' });
                const derivedPubDer = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'der' });
                matches = Buffer.isBuffer(certPubDer)
                    && Buffer.isBuffer(derivedPubDer)
                    && certPubDer.equals(derivedPubDer);
            }
            if (!matches) {
                return 'Manual TLS: certificate and private key do not match.';
            }
        } catch (err) {
            const digest = crypto.createHash('sha256').update(keyPem).digest('hex').slice(0, 8);
            logger.warn(`[validateXrayFormFields] Invalid private key PEM (sha256=${digest}): ${err.code || 'parse error'}`);
            return 'Manual TLS: private key PEM could not be parsed.';
        }
    }

    const validateFallbackDest = (value, label) => {
        const v = String(value || '').trim();
        if (!v) return null;
        if (!FALLBACK_DEST_RE.test(v)) {
            return `${label}: fallback dest "${v}" is invalid (expected port / host:port / [v6]:port / unix:/path).`;
        }
        return null;
    };
    const mainFallbackErr = validateFallbackDest(xray?.fallbackDest, 'Main inbound');
    if (mainFallbackErr) return mainFallbackErr;

    const mainXhttpErr = validateXhttpInbound(xray, 'Main inbound');
    if (mainXhttpErr) return mainXhttpErr;

    if (!xray || !Array.isArray(xray.extraInbounds) || xray.extraInbounds.length === 0) {
        return null;
    }

    const mainPort = parseInt(node?.port, 10);
    const apiPort = parseInt(xray.apiPort, 10);
    const agentPort = parseInt(xray.agentPort, 10);
    const reservedPorts = new Map();
    if (Number.isInteger(mainPort)) reservedPorts.set(mainPort, 'main inbound');
    if (Number.isInteger(apiPort)) reservedPorts.set(apiPort, 'API');
    if (Number.isInteger(agentPort)) reservedPorts.set(agentPort, 'agent');

    const mainTag = (xray.inboundTag || 'vless-in').trim();
    const seenTags = new Map();
    seenTags.set(mainTag, 'main inbound');

    const tagPattern = /^[A-Za-z0-9_-]{1,64}$/;

    for (let i = 0; i < xray.extraInbounds.length; i++) {
        const inbound = xray.extraInbounds[i];
        const idx = i + 1;

        if (!net.isIP(String(inbound.listen || '0.0.0.0').trim())) {
            return `Extra inbound #${idx}: listen must be a valid IPv4 or IPv6 address.`;
        }
        if (!Number.isInteger(inbound.port) || inbound.port < 1 || inbound.port > 65535) {
            return `Extra inbound #${idx}: invalid port (must be 1..65535)`;
        }
        if (reservedPorts.has(inbound.port)) {
            return `Extra inbound #${idx}: port ${inbound.port} is already used by ${reservedPorts.get(inbound.port)}`;
        }
        reservedPorts.set(inbound.port, `extra inbound #${idx}`);

        const tag = (inbound.inboundTag || '').trim();
        if (!tagPattern.test(tag)) {
            return `Extra inbound #${idx}: tag must match [A-Za-z0-9_-]{1,64}`;
        }
        if (seenTags.has(tag)) {
            return `Extra inbound #${idx}: tag "${tag}" is already used by ${seenTags.get(tag)}`;
        }
        seenTags.set(tag, `extra inbound #${idx}`);

        if (!XRAY_TRANSPORT_VALUES.includes(inbound.transport)) {
            return `Extra inbound #${idx}: invalid transport`;
        }
        if (!XRAY_SECURITY_VALUES.includes(inbound.security)) {
            return `Extra inbound #${idx}: invalid security`;
        }
        const extraFallbackErr = validateFallbackDest(inbound.fallbackDest, `Extra inbound #${idx}`);
        if (extraFallbackErr) return extraFallbackErr;
        const extraXhttpErr = validateXhttpInbound(inbound, `Extra inbound #${idx}`);
        if (extraXhttpErr) return extraXhttpErr;
        // Reality private key is auto-generated server-side when missing
        // (see ensureExtraInboundReality in panel/nodes.js), so we do NOT
        // reject submissions with empty privateKey here.
    }

    return null;
}

/**
 * Replace the manualKey sentinel with the previously stored private key
 * before validation/persist. Operators editing an existing node see the
 * placeholder ***SET*** in the textarea instead of the real PEM, so the key
 * never round-trips through the browser. When they hit Save without changing
 * the field, the placeholder lands here and we restore the prior value.
 *
 * Pure function: returns a new xray object, never mutates inputs.
 *
 * @param {Object} parsedXray  - Result of parseXrayFormFields() (caller's pick)
 * @param {Object} existingXray - Current xray subdoc fetched WITH manualKey
 * @returns {Object} parsedXray with manualKey resolved
 */
function resolveManualKeyPlaceholder(parsedXray, existingXray) {
    if (!parsedXray) return parsedXray;
    if (parsedXray.manualKey === MANUAL_KEY_PLACEHOLDER) {
        return { ...parsedXray, manualKey: (existingXray && existingXray.manualKey) || '' };
    }
    return parsedXray;
}

/**
 * Strip secret material from an xray object before sending it to the browser
 * (form render). Returns a deep-ish copy — leaves nested arrays/objects alone
 * since none of the other fields are sensitive.
 *
 * @param {Object|null|undefined} xray - Mongoose subdoc or plain object
 * @returns {Object|null}
 */
function sanitizeXrayForRender(xray) {
    if (!xray) return xray;
    const plain = (typeof xray.toObject === 'function') ? xray.toObject() : { ...xray };
    if (plain.manualKey) {
        plain.manualKeySet = true;
        plain.manualKey = MANUAL_KEY_PLACEHOLDER;
    } else {
        plain.manualKeySet = false;
        plain.manualKey = '';
    }
    return plain;
}

/**
 * Fill in missing Reality keys for extra inbounds before persisting them.
 * Mutates each inbound in place. Used by the create/edit node routes so
 * admins can add Reality extras without manually clicking "Generate keys".
 *
 * @param {Object} xray - Parsed xray object (with extraInbounds[])
 */
function ensureExtraInboundRealityKeys(xray) {
    if (!xray || !Array.isArray(xray.extraInbounds)) return;
    for (const inbound of xray.extraInbounds) {
        if (inbound.security === 'reality' && !inbound.realityPrivateKey) {
            const keys = cryptoService.generateX25519KeysLocal();
            inbound.realityPrivateKey = keys.privateKey;
            inbound.realityPublicKey = keys.publicKey;
        }
    }
}

function parseBool(body, key, defaultValue = false) {
    if (body[key] === undefined) return defaultValue;
    const v = Array.isArray(body[key]) ? body[key][body[key].length - 1] : body[key];
    return v === 'on' || v === 'true' || v === true || v === '1';
}

function parseHeaderMap(raw, fallback = {}) {
    const text = (raw || '').trim();
    if (!text) return fallback;
    const result = {};
    text.split('\n').forEach(line => {
        const row = line.trim();
        if (!row) return;
        const idx = row.indexOf(':');
        if (idx <= 0) return;
        const key = row.slice(0, idx).trim().toLowerCase();
        const value = row.slice(idx + 1).trim();
        if (!key) return;
        result[key] = value;
    });
    return Object.keys(result).length > 0 ? result : fallback;
}

function parseJSONObjectWithStatus(raw, fallback = {}) {
    const text = (raw || '').trim();
    if (!text) {
        return { value: fallback, valid: true };
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { value: fallback, valid: false };
        }
        return { value: parsed, valid: true };
    } catch (_) {
        return { value: fallback, valid: false };
    }
}

function parseIntegerOrDefault(raw, defaultValue) {
    const value = parseInt(raw, 10);
    return Number.isFinite(value) ? value : defaultValue;
}

function normalizeTextareaNewlines(value) {
    return String(value || '').replace(/\r\n?/g, '\n');
}

const DEFAULT_INLINE_ACL_RULES = [
    'reject(geoip:cn)',
    'reject(geoip:private)',
];

function parseAclRulesInput(raw) {
    return String(raw || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
}

// Mirrors the outboundSchema enum: `block` is an ACL action, not an outbound,
// and letting it through would fail validation on HyNode.create().
const OUTBOUND_TYPES = ['direct', 'socks5', 'http'];
const OUTBOUND_MAX = 20;

/**
 * Parse repeated `outbound_*` inputs from the Outbounds page or the Xray
 * create form. Rows without a name or with an unknown type are dropped.
 * @param {object} body - Express request body
 * @returns {Array<object>}
 */
function parseOutboundsFormFields(body) {
    if (!body || !body.outbound_name) return [];

    const asArray = value => (Array.isArray(value) ? value : [value]);
    const names = asArray(body.outbound_name);
    const types = asArray(body.outbound_type);
    const addrs = asArray(body.outbound_addr || '');
    const usernames = asArray(body.outbound_username || '');
    const passwords = asArray(body.outbound_password || '');

    const outbounds = [];
    for (let i = 0; i < names.length && outbounds.length < OUTBOUND_MAX; i++) {
        const name = String(names[i] || '').trim();
        const type = String(types[i] || '').trim();

        if (!name || !OUTBOUND_TYPES.includes(type)) continue;

        outbounds.push({
            name,
            type,
            addr: String(addrs[i] || '').trim(),
            username: String(usernames[i] || '').trim(),
            password: String(passwords[i] || '').trim(),
        });
    }

    return outbounds;
}

function getHysteriaAclInlineState(node) {
    if (!node || node.type === 'xray' || isServerlessNode(node)) {
        return { editable: true, reason: '' };
    }
    const aclEnabled = node.acl?.enabled !== false;
    const aclType = node.acl?.type || 'inline';
    if (!aclEnabled) return { editable: false, reason: 'disabled' };
    if (aclType === 'file') return { editable: false, reason: 'file' };
    return { editable: true, reason: '' };
}

function parseHysteriaFormFields(body) {
    const hasDomain = !!String(body.domain || '').trim();
    const acmeAdvancedEnabled = parseBool(body, 'acme.advanced.enabled', false) && hasDomain;
    const bandwidthEnabled = parseBool(body, 'bandwidth.enabled', false);
    const udpOptionsEnabled = parseBool(body, 'udp.options.enabled', false);
    const sniffEnabled = parseBool(body, 'sniff.enabled', false);
    const quicEnabled = parseBool(body, 'quic.enabled', false);
    const resolverEnabled = parseBool(body, 'resolver.enabled', false);
    const aclEnabled = parseBool(body, 'acl.enabled', true);
    const aclType = body['acl.type'] === 'file' ? 'file' : 'inline';
    const aclInlineRules = parseAclRulesInput(body['acl.inlineRules'] || body.aclRules);
    const aclRules = aclEnabled && aclType === 'inline'
        ? (aclInlineRules.length > 0 ? aclInlineRules : DEFAULT_INLINE_ACL_RULES.slice())
        : aclInlineRules;

    const acmeDnsConfigParsed = acmeAdvancedEnabled
        ? parseJSONObjectWithStatus(body['acme.dns.config'], {})
        : { value: {}, valid: true };
    const masqueradeType = body['masquerade.type'] === 'string' ? 'string' : 'proxy';

    const masquerade = {
        type: masqueradeType,
        proxy: {
            url: (body['masquerade.proxy.url'] || '').trim() || 'https://www.google.com',
            rewriteHost: parseBool(body, 'masquerade.proxy.rewriteHost', false),
            insecure: parseBool(body, 'masquerade.proxy.insecure', false),
        },
        string: {
            content: normalizeTextareaNewlines(body['masquerade.string.content'] || 'Service Unavailable'),
            headers: parseHeaderMap(body['masquerade.string.headers'], { 'content-type': 'text/plain' }),
            statusCode: parseInt(body['masquerade.string.statusCode'], 10) || 503,
        },
        listenHTTP: (body['masquerade.listenHTTP'] || '').trim(),
        listenHTTPS: (body['masquerade.listenHTTPS'] || '').trim(),
        forceHTTPS: parseBool(body, 'masquerade.forceHTTPS', false),
    };

    return {
        hopInterval: (body.hopInterval || '').trim(),
        acme: {
            email: hasDomain ? (body['acme.email'] || '').trim() : '',
            ca: hasDomain ? ((body['acme.ca'] || 'letsencrypt').trim() || 'letsencrypt') : '',
            listenHost: acmeAdvancedEnabled ? ((body['acme.listenHost'] || '').trim()) : '',
            type: acmeAdvancedEnabled ? (body['acme.type'] || '').trim() : '',
            httpAltPort: acmeAdvancedEnabled ? parseIntegerOrDefault(body['acme.httpAltPort'], 0) : 0,
            tlsAltPort: acmeAdvancedEnabled ? parseIntegerOrDefault(body['acme.tlsAltPort'], 0) : 0,
            dnsName: acmeAdvancedEnabled ? (body['acme.dns.name'] || '').trim() : '',
            dnsConfig: acmeAdvancedEnabled ? acmeDnsConfigParsed.value : {},
        },
        acmeDnsConfigValid: acmeDnsConfigParsed.valid,
        bandwidth: {
            up: bandwidthEnabled ? (body['bandwidth.up'] || '').trim() : '',
            down: bandwidthEnabled ? (body['bandwidth.down'] || '').trim() : '',
        },
        ignoreClientBandwidth: bandwidthEnabled ? parseBool(body, 'ignoreClientBandwidth', false) : false,
        speedTest: parseBool(body, 'speedTest', false),
        disableUDP: udpOptionsEnabled ? parseBool(body, 'disableUDP', false) : false,
        udpIdleTimeout: udpOptionsEnabled ? (body['udpIdleTimeout'] || '').trim() : '',
        sniff: {
            enabled: sniffEnabled,
            enable: parseBool(body, 'sniff.enable', true),
            timeout: sniffEnabled ? ((body['sniff.timeout'] || '2s').trim() || '2s') : '2s',
            rewriteDomain: sniffEnabled ? parseBool(body, 'sniff.rewriteDomain', false) : false,
            tcpPorts: sniffEnabled ? ((body['sniff.tcpPorts'] || '80,443,8000-9000').trim() || '80,443,8000-9000') : '80,443,8000-9000',
            udpPorts: sniffEnabled ? ((body['sniff.udpPorts'] || '443,80,53').trim() || '443,80,53') : '443,80,53',
        },
        quic: {
            enabled: quicEnabled,
            initStreamReceiveWindow: quicEnabled ? parseIntegerOrDefault(body['quic.initStreamReceiveWindow'], 8388608) : 8388608,
            maxStreamReceiveWindow: quicEnabled ? parseIntegerOrDefault(body['quic.maxStreamReceiveWindow'], 8388608) : 8388608,
            initConnReceiveWindow: quicEnabled ? parseIntegerOrDefault(body['quic.initConnReceiveWindow'], 20971520) : 20971520,
            maxConnReceiveWindow: quicEnabled ? parseIntegerOrDefault(body['quic.maxConnReceiveWindow'], 20971520) : 20971520,
            maxIdleTimeout: quicEnabled ? ((body['quic.maxIdleTimeout'] || '60s').trim() || '60s') : '60s',
            maxIncomingStreams: quicEnabled ? parseIntegerOrDefault(body['quic.maxIncomingStreams'], 256) : 256,
            disablePathMTUDiscovery: quicEnabled ? parseBool(body, 'quic.disablePathMTUDiscovery', false) : false,
        },
        resolver: {
            enabled: resolverEnabled,
            type: resolverEnabled ? ((body['resolver.type'] || 'udp').trim() || 'udp') : 'udp',
            udpAddr: resolverEnabled ? ((body['resolver.udp.addr'] || '8.8.4.4:53').trim() || '8.8.4.4:53') : '8.8.4.4:53',
            udpTimeout: resolverEnabled ? ((body['resolver.udp.timeout'] || '4s').trim() || '4s') : '4s',
            tcpAddr: resolverEnabled ? ((body['resolver.tcp.addr'] || '8.8.8.8:53').trim() || '8.8.8.8:53') : '8.8.8.8:53',
            tcpTimeout: resolverEnabled ? ((body['resolver.tcp.timeout'] || '4s').trim() || '4s') : '4s',
            tlsAddr: resolverEnabled ? ((body['resolver.tls.addr'] || '1.1.1.1:853').trim() || '1.1.1.1:853') : '1.1.1.1:853',
            tlsTimeout: resolverEnabled ? ((body['resolver.tls.timeout'] || '10s').trim() || '10s') : '10s',
            tlsSni: resolverEnabled ? ((body['resolver.tls.sni'] || 'cloudflare-dns.com').trim() || 'cloudflare-dns.com') : 'cloudflare-dns.com',
            tlsInsecure: resolverEnabled ? parseBool(body, 'resolver.tls.insecure', false) : false,
            httpsAddr: resolverEnabled ? ((body['resolver.https.addr'] || '1.1.1.1:443').trim() || '1.1.1.1:443') : '1.1.1.1:443',
            httpsTimeout: resolverEnabled ? ((body['resolver.https.timeout'] || '10s').trim() || '10s') : '10s',
            httpsSni: resolverEnabled ? ((body['resolver.https.sni'] || 'cloudflare-dns.com').trim() || 'cloudflare-dns.com') : 'cloudflare-dns.com',
            httpsInsecure: resolverEnabled ? parseBool(body, 'resolver.https.insecure', false) : false,
        },
        masquerade,
        acl: {
            enabled: aclEnabled,
            type: aclEnabled ? aclType : 'inline',
            file: aclEnabled ? (body['acl.file'] || '').trim() : '',
            geoip: aclEnabled ? (body['acl.geoip'] || '').trim() : '',
            geosite: aclEnabled ? (body['acl.geosite'] || '').trim() : '',
            geoUpdateInterval: aclEnabled ? (body['acl.geoUpdateInterval'] || '').trim() : '',
        },
        aclRules,
        useTlsFiles: parseBool(body, 'useTlsFiles', false),
    };
}

function isValidPortList(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return false;
    if (value === 'all') return true;

    const parts = value.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return false;

    for (const part of parts) {
        if (/^\d+$/.test(part)) {
            const port = Number(part);
            if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
            continue;
        }

        const match = part.match(/^(\d+)-(\d+)$/);
        if (!match) return false;

        const start = Number(match[1]);
        const end = Number(match[2]);
        if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
        if (start < 1 || start > 65535 || end < 1 || end > 65535 || start > end) return false;
    }

    return true;
}

function isValidBandwidth(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return true;
    if (value === '0' || value === '0.0') return true;
    const match = value.match(/^(\d+(\.\d+)?)\s*([a-z]+)$/);
    if (!match) return false;
    const unit = match[3];
    return ['b', 'bps', 'kbps', 'kb', 'k', 'mbps', 'mb', 'm', 'gbps', 'gb', 'g', 'tbps', 'tb', 't'].includes(unit);
}

function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

function validateHysteriaFormFields(fields) {
    if (fields.hopInterval) {
        const sec = parseDurationSeconds(fields.hopInterval);
        if (!Number.isFinite(sec) || sec <= 0) {
            return 'Invalid hopInterval format (example: 30s, 1m)';
        }
        if (sec < 5) {
            return 'Invalid hopInterval: must be at least 5s';
        }
    }

    const acmeType = (fields.acme?.type || '').trim();
    if (acmeType && !['http', 'tls', 'dns'].includes(acmeType)) {
        return 'Invalid ACME challenge type';
    }
    if (acmeType === 'dns' && fields.acmeDnsConfigValid === false) {
        return 'ACME DNS config must be a valid JSON object';
    }
    if (acmeType === 'dns' && !fields.acme?.dnsName) {
        return 'ACME DNS mode requires provider name (acme.dns.name)';
    }
    if (fields.acme?.httpAltPort && (fields.acme.httpAltPort < 1 || fields.acme.httpAltPort > 65535)) {
        return 'ACME HTTP altPort must be between 1 and 65535';
    }
    if (fields.acme?.tlsAltPort && (fields.acme.tlsAltPort < 1 || fields.acme.tlsAltPort > 65535)) {
        return 'ACME TLS altPort must be between 1 and 65535';
    }

    if (fields.acl?.enabled && fields.acl?.type === 'file' && !fields.acl?.file) {
        return 'ACL file mode requires acl.file path';
    }

    if (fields.bandwidth?.up && !isValidBandwidth(fields.bandwidth.up)) {
        return 'Invalid bandwidth.up format (example: 100 mbps)';
    }
    if (fields.bandwidth?.down && !isValidBandwidth(fields.bandwidth.down)) {
        return 'Invalid bandwidth.down format (example: 100 mbps)';
    }

    if (fields.udpIdleTimeout) {
        const sec = parseDurationSeconds(fields.udpIdleTimeout);
        if (!Number.isFinite(sec) || sec <= 0) {
            return 'Invalid udpIdleTimeout format (example: 60s, 1m)';
        }
    }

    if (fields.sniff?.enabled) {
        const sniffTimeout = parseDurationSeconds(fields.sniff?.timeout);
        if (!Number.isFinite(sniffTimeout) || sniffTimeout <= 0) {
            return 'Invalid sniff.timeout format (example: 2s, 1m)';
        }
        if (!isValidPortList(fields.sniff?.tcpPorts)) {
            return 'Invalid sniff.tcpPorts format (example: 80,443,8000-9000 or all)';
        }
        if (!isValidPortList(fields.sniff?.udpPorts)) {
            return 'Invalid sniff.udpPorts format (example: 443,80,53 or all)';
        }
    }

    const quic = fields.quic || {};
    if (quic.enabled) {
        if (!isPositiveInteger(quic.initStreamReceiveWindow)) return 'quic.initStreamReceiveWindow must be a positive integer';
        if (!isPositiveInteger(quic.maxStreamReceiveWindow)) return 'quic.maxStreamReceiveWindow must be a positive integer';
        if (!isPositiveInteger(quic.initConnReceiveWindow)) return 'quic.initConnReceiveWindow must be a positive integer';
        if (!isPositiveInteger(quic.maxConnReceiveWindow)) return 'quic.maxConnReceiveWindow must be a positive integer';
        if (!isPositiveInteger(quic.maxIncomingStreams)) return 'quic.maxIncomingStreams must be a positive integer';
        const quicIdle = parseDurationSeconds(quic.maxIdleTimeout);
        if (!Number.isFinite(quicIdle) || quicIdle <= 0) return 'Invalid quic.maxIdleTimeout format (example: 60s, 1m)';
        if (quic.maxStreamReceiveWindow < quic.initStreamReceiveWindow) return 'quic.maxStreamReceiveWindow must be >= quic.initStreamReceiveWindow';
        if (quic.maxConnReceiveWindow < quic.initConnReceiveWindow) return 'quic.maxConnReceiveWindow must be >= quic.initConnReceiveWindow';
    }

    if (fields.resolver?.enabled) {
        const resolverType = fields.resolver.type || 'udp';
        if (!['udp', 'tcp', 'tls', 'https'].includes(resolverType)) return 'Invalid resolver.type';
        let timeoutRaw = '';
        if (resolverType === 'udp') timeoutRaw = fields.resolver.udpTimeout;
        if (resolverType === 'tcp') timeoutRaw = fields.resolver.tcpTimeout;
        if (resolverType === 'tls') timeoutRaw = fields.resolver.tlsTimeout;
        if (resolverType === 'https') timeoutRaw = fields.resolver.httpsTimeout;
        const timeoutSec = parseDurationSeconds(timeoutRaw);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return `Invalid resolver.${resolverType}.timeout format`;
    }

    if (fields.masquerade?.type === 'string') {
        const sc = Number(fields.masquerade?.string?.statusCode);
        if (!Number.isFinite(sc) || sc < 100 || sc > 599) return 'Masquerade string statusCode must be between 100 and 599';
    } else {
        const proxyUrl = fields.masquerade?.proxy?.url || '';
        try {
            const parsed = new URL(proxyUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) return 'Masquerade proxy.url must use http:// or https://';
        } catch (_) {
            return 'Masquerade proxy.url is not a valid URL';
        }
    }

    return '';
}

// ─── IP Whitelist ────────────────────────────────────────────────────────────

function parseIpWhitelist() {
    const whitelist = config.PANEL_IP_WHITELIST || '';
    if (!whitelist.trim()) return null;
    return whitelist.split(',').map(ip => ip.trim()).filter(Boolean);
}

function isIpAllowed(clientIp, whitelist) {
    if (!whitelist || whitelist.length === 0) return true;
    const normalizedIp = clientIp.replace(/^::ffff:/, '');
    for (const entry of whitelist) {
        if (entry.includes('/')) {
            if (isIpInCidr(normalizedIp, entry)) return true;
        } else {
            if (normalizedIp === entry) return true;
        }
    }
    return false;
}

function isIpInCidr(ip, cidr) {
    const [range, bits] = cidr.split('/');
    const mask = parseInt(bits);
    const ipNum = ipToNum(ip);
    const rangeNum = ipToNum(range);
    if (ipNum === null || rangeNum === null) return false;
    const maskBits = ~((1 << (32 - mask)) - 1);
    return (ipNum & maskBits) === (rangeNum & maskBits);
}

function ipToNum(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    return parts.reduce((acc, part) => (acc << 8) + parseInt(part), 0) >>> 0;
}

const checkIpWhitelist = (req, res, next) => {
    const whitelist = parseIpWhitelist();
    if (!whitelist) return next();
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp = forwardedFor
        ? forwardedFor.split(',')[0].trim()
        : (req.ip || req.connection.remoteAddress || '');
    if (!isIpAllowed(clientIp, whitelist)) {
        logger.warn(`[Panel] Access denied for IP: ${clientIp}`);
        // Generic response — do not leak that an IP whitelist exists.
        return res.status(403).type('text/plain').send('Forbidden');
    }
    next();
};

// ─── Auth Middleware ──────────────────────────────────────────────────────────

const requireAuth = (req, res, next) => {
    if (!req.session || !req.session.authenticated) {
        return res.redirect('/panel/login');
    }
    next();
};

// ─── Render Engine ───────────────────────────────────────────────────────────

const render = (res, template, data = {}) => {
    const isProduction = process.env.NODE_ENV === 'production';
    let compiledTemplate = templateCache.get(template);

    if (!compiledTemplate || !isProduction) {
        const templatePath = path.join(__dirname, '../../../views', template + '.ejs');
        const templateContent = fs.readFileSync(templatePath, 'utf8');
        compiledTemplate = ejs.compile(templateContent, { filename: templatePath });
        if (isProduction) {
            templateCache.set(template, compiledTemplate);
        }
    }

    const i18nVars = {
        t: res.locals.t,
        lang: res.locals.lang,
        supportedLangs: res.locals.supportedLangs,
        languageOptions: res.locals.languageOptions,
        dateLocale: res.locals.dateLocale,
        locales: res.locals.locales,
    };

    // Feature flags live in res.locals, which the layout can read but an inner
    // template cannot: EJS only sees what is passed to compile(). Exposing them
    // here keeps partials from silently rendering nothing.
    const featureFlags = {
        accessLogsEnabled: res.locals.accessLogsEnabled === true,
        probesEnabled: res.locals.probesEnabled === true,
    };

    const viewVars = {
        ...featureFlags,
        ...data,
        ...i18nVars,
        baseUrl: config.BASE_URL,
        config,
        appVersion,
        formatTraffic,
    };

    const content = compiledTemplate(viewVars);

    res.render('layout', {
        ...viewVars,
        content,
    });
};

// ─── TOTP Shared Utilities ───────────────────────────────────────────────────

const PANEL_TOTP_PENDING_TTL_MS = 10 * 60 * 1000;
const SETTINGS_TOTP_ACTIONS = new Set([
    'password_change',
    'totp_enable_enroll',
    'totp_rotate_verify_current',
    'totp_rotate_enroll',
    'totp_disable_verify_current',
]);

function clearPanelTotpPending(req) {
    if (req.session) delete req.session.panelTotpPending;
}

function clearPanelLoginTotpLockout(req) {
    if (req.session) delete req.session.panelLoginTotpLockout;
}

function normalizePanelLoginTotpLockoutTime(resetTime) {
    if (!resetTime) return null;
    if (resetTime instanceof Date) {
        const value = resetTime.getTime();
        return Number.isFinite(value) ? value : null;
    }
    const value = Number(resetTime);
    return Number.isFinite(value) ? value : null;
}

function setPanelLoginTotpLockout(req, resetTime) {
    if (!req.session) return null;
    const blockedUntil = normalizePanelLoginTotpLockoutTime(resetTime);
    if (!blockedUntil || blockedUntil <= Date.now()) {
        clearPanelLoginTotpLockout(req);
        return null;
    }
    req.session.panelLoginTotpLockout = { blockedUntil };
    return req.session.panelLoginTotpLockout;
}

function getPanelLoginTotpLockout(req) {
    const lockout = req.session?.panelLoginTotpLockout;
    if (!lockout || typeof lockout !== 'object') return null;
    const blockedUntil = Number(lockout.blockedUntil);
    if (!Number.isFinite(blockedUntil)) {
        clearPanelLoginTotpLockout(req);
        return null;
    }
    if (blockedUntil <= Date.now()) {
        clearPanelLoginTotpLockout(req);
        return null;
    }
    return { blockedUntil };
}

function renderPanelLoginPage(req, res, { error = null, status = 200 } = {}) {
    const lockout = getPanelLoginTotpLockout(req);
    const t = typeof res.locals.t === 'function' ? res.locals.t : null;
    return res.status(status).render('login', {
        error,
        lockoutActive: Boolean(lockout),
        lockoutUntil: lockout?.blockedUntil || null,
        lockoutIso: lockout ? new Date(lockout.blockedUntil).toISOString() : null,
        lockoutReason: lockout ? (t ? t('auth.totpLoginLockoutMessage') : 'Login is temporarily blocked due to too many invalid verification attempts.') : null,
    });
}

function getPanelTotpPending(req, { clearInvalid = true } = {}) {
    const pending = req.session?.panelTotpPending;
    if (!pending || typeof pending !== 'object') return null;

    const invalidate = () => {
        if (clearInvalid) clearPanelTotpPending(req);
        return null;
    };

    if (!pending.type || !pending.createdAt || (Date.now() - pending.createdAt) >= PANEL_TOTP_PENDING_TTL_MS) return invalidate();
    if (!pending.username || typeof pending.username !== 'string') return invalidate();

    if (pending.type === 'setup') {
        if (!pending.passwordHash || !pending.secretEncrypted) return invalidate();
        return pending;
    }
    if (pending.type === 'login') {
        if (!pending.secretEncrypted) return invalidate();
        return pending;
    }
    if (pending.type !== 'settings') return invalidate();

    if (!pending.action || !SETTINGS_TOTP_ACTIONS.has(pending.action)) return invalidate();
    if (!req.session?.authenticated || req.session.adminUsername !== pending.username) return invalidate();
    if (!pending.returnTo || typeof pending.returnTo !== 'string') return invalidate();

    if (pending.action === 'password_change' && !pending.payload?.newPasswordHash) return invalidate();
    if ((pending.action === 'totp_rotate_verify_current' || pending.action === 'totp_disable_verify_current') && !pending.payload?.currentSecretEncrypted) return invalidate();
    if ((pending.action === 'totp_enable_enroll' || pending.action === 'totp_rotate_enroll') && !pending.secretEncrypted) return invalidate();

    return pending;
}

async function renderPanelTotpPage(res, pending, error = null) {
    const t = typeof res.locals.t === 'function' ? res.locals.t : null;

    if (pending.type === 'login') {
        return res.render('totp-verify', {
            mode: 'login', error,
            formAction: '/panel/totp',
            title: t ? t('auth.totpTitle') : 'Two-factor verification',
            description: t ? t('auth.totpLoginDescription') : 'Enter the code from your authenticator app to finish login.',
            buttonText: t ? t('auth.totpVerifyButton') : 'Verify',
        });
    }

    if (pending.type === 'setup') {
        const secret = totpService.decryptSecret(pending.secretEncrypted);
        const otpauthUrl = totpService.buildOtpAuthUrl({ secret, username: pending.username });
        const qrDataUrl = await totpService.generateQrDataUrl(otpauthUrl);
        return res.render('totp-verify', {
            mode: 'setup', error,
            formAction: '/panel/totp',
            title: t ? t('auth.totpSetupTitle') : 'Set up two-factor authentication',
            description: t ? t('auth.totpSetupDescription') : 'Scan the QR code and enter the 6-digit code from your authenticator app.',
            buttonText: t ? t('auth.totpVerifyButton') : 'Verify',
            username: pending.username, secret, qrDataUrl, showEnrollment: true,
        });
    }

    const isEnrollment = pending.action === 'totp_enable_enroll' || pending.action === 'totp_rotate_enroll';
    const titleByAction = {
        password_change: t ? t('auth.totpPasswordChangeTitle') : 'Confirm password change',
        totp_disable_verify_current: t ? t('auth.totpDisableTitle') : 'Confirm TOTP disable',
        totp_rotate_verify_current: t ? t('auth.totpRotateCurrentTitle') : 'Confirm current TOTP code',
        totp_enable_enroll: t ? t('auth.totpSettingsTitle') : 'Confirm TOTP setup',
        totp_rotate_enroll: t ? t('auth.totpSettingsTitle') : 'Confirm TOTP setup',
    };
    const descriptionByAction = {
        password_change: t ? t('auth.totpPasswordChangeDescription') : 'Enter your current TOTP code to apply the new password.',
        totp_disable_verify_current: t ? t('auth.totpDisableDescription') : 'Enter your current TOTP code to disable two-factor authentication.',
        totp_rotate_verify_current: t ? t('auth.totpRotateCurrentDescription') : 'Enter your current TOTP code to continue secret rotation.',
        totp_enable_enroll: t ? t('settings.totpEnableVerifyDescription') : 'Scan the QR code and enter the code from your authenticator app to finish enabling TOTP.',
        totp_rotate_enroll: t ? t('settings.totpRotateVerifyDescription') : 'Scan the new QR code and enter the code from your new device to complete secret rotation.',
    };
    const buttonByAction = {
        password_change: t ? t('auth.totpApplyPasswordButton') : 'Apply password change',
        totp_disable_verify_current: t ? t('auth.totpDisableButton') : 'Disable TOTP',
        totp_rotate_verify_current: t ? t('auth.totpContinueButton') : 'Continue',
        totp_enable_enroll: t ? t('auth.totpVerifyButton') : 'Verify',
        totp_rotate_enroll: t ? t('auth.totpVerifyButton') : 'Verify',
    };

    const payload = {
        mode: 'settings', error,
        formAction: '/panel/totp',
        title: titleByAction[pending.action] || (t ? t('auth.totpSettingsTitle') : 'Confirm TOTP setup'),
        description: descriptionByAction[pending.action] || (t ? t('auth.totpSetupDescription') : 'Scan the QR code and enter the 6-digit code from your authenticator app.'),
        buttonText: buttonByAction[pending.action] || (t ? t('auth.totpVerifyButton') : 'Verify'),
        cancelHref: pending.returnTo,
        showEnrollment: isEnrollment,
        username: pending.username,
    };

    if (!isEnrollment) return res.render('totp-verify', payload);

    const secret = totpService.decryptSecret(pending.secretEncrypted);
    const otpauthUrl = totpService.buildOtpAuthUrl({ secret, username: pending.username });
    const qrDataUrl = await totpService.generateQrDataUrl(otpauthUrl);

    return res.render('totp-verify', { ...payload, secret, qrDataUrl });
}

function redirectSettingsSecurity(res, { message = null, error = null } = {}) {
    const params = new URLSearchParams({ tab: 'security' });
    if (message) params.set('message', message);
    if (error) params.set('error', error);
    return res.redirect(`/panel/settings?${params.toString()}`);
}

// ─── Rate Limiters ───────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn(`[Panel] Rate limit exceeded for IP: ${req.ip}`);
        const lockout = getPanelLoginTotpLockout(req);
        if (lockout) return renderPanelLoginPage(req, res, { status: 429 });
        const message = res.locals.t?.('auth.tooManyAttempts') || 'Too many login attempts. Try again in 15 minutes.';
        return renderPanelLoginPage(req, res, { error: message, status: 429 });
    },
});

const totpVerifyLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    handler: async (req, res) => {
        logger.warn(`[Panel] TOTP verify rate limit exceeded (IP: ${req.ip})`);
        const message = res.locals.t?.('auth.tooManyTotpAttempts') || 'Too many verification attempts. Try again later.';
        const pending = getPanelTotpPending(req, { clearInvalid: false });
        if (pending?.type === 'login') {
            setPanelLoginTotpLockout(req, req.rateLimit?.resetTime);
            clearPanelTotpPending(req);
            return res.redirect('/panel/login');
        }
        if (pending?.type === 'settings') return redirectSettingsSecurity(res, { error: message });
        if (pending) return renderPanelTotpPage(res, pending, message);
        if (req.session?.authenticated) return redirectSettingsSecurity(res, { error: message });
        return res.redirect('/panel/login');
    },
});

const generateSshKeyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
});

const sniScanLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        res.status(429).json({ error: res.locals.t?.('common.tooManyScanRequests') || 'Too many scan requests. Try again in a minute.' });
    },
});

// ─── Onboarding Middleware ────────────────────────────────────────────────────

// In-memory cache for deployment.completed — avoids a Mongo round-trip on every request.
// Reset whenever the wizard marks onboarding as completed.
let _onboardingCompleted = null;

function invalidateOnboardingCache() {
    _onboardingCompleted = null;
}

const requireOnboarding = async (req, res, next) => {
    try {
        // Skip wizard-related paths so they are never redirected
        if (req.path.startsWith('/wizard')) return next();

        if (_onboardingCompleted === null) {
            const Settings = require('../../models/settingsModel');
            const settings = await Settings.get();
            _onboardingCompleted = settings.deployment?.completed === true;
        }

        if (_onboardingCompleted) return next();

        return res.redirect('/panel/wizard');
    } catch (err) {
        // On error, let the request through — fail-safe
        logger.warn(`[Onboarding] Middleware error, allowing request: ${err.message}`);
        return next();
    }
};

// Only the Xray create form carries outbounds over to a clone. A Hysteria
// clone starts without them, so a rule routing to a custom outbound would be
// pushed to a node where that outbound does not exist — Hysteria rejects such
// a config on load, while Xray only skips the rule. Keep built-in actions.
const CLONEABLE_ACL_ACTIONS = new Set(['reject', 'direct']);

function cloneableAclRules(rules) {
    if (!Array.isArray(rules)) return [];
    return rules.filter((rule) => {
        const action = String(rule || '').trim().match(/^([\w-]+)\(/);
        return !!action && CLONEABLE_ACL_ACTIONS.has(action[1]);
    });
}

/**
 * Build a create-form prefill from an existing node (issue #117 clone).
 * Copies protocol/config fields and strips identity, SSH, runtime, and secrets.
 * @param {object} source - lean HyNode document
 * @returns {object|null}
 */
function buildClonedNodePrefill(source) {
    if (!source || typeof source !== 'object') return null;

    const isXray = source.type === 'xray';
    const freshKeys = cryptoService.generateX25519KeysLocal();
    const xray = { ...(source.xray || {}) };
    delete xray.agentToken;
    delete xray.accessLogs;
    delete xray.manualCert;
    delete xray.manualKey;
    xray.realityPrivateKey = freshKeys.privateKey;
    xray.realityPublicKey = freshKeys.publicKey;
    if (Array.isArray(xray.extraInbounds)) {
        xray.extraInbounds = xray.extraInbounds.map((inbound) => {
            const copy = { ...inbound, id: crypto.randomUUID() };
            if (copy.realityPrivateKey || copy.realityPublicKey || copy.security === 'reality') {
                const extraKeys = cryptoService.generateX25519KeysLocal();
                copy.realityPrivateKey = extraKeys.privateKey;
                copy.realityPublicKey = extraKeys.publicKey;
            }
            return copy;
        });
    }

    const name = String(source.name || 'node').trim() || 'node';
    return {
        type: source.type || 'hysteria',
        name: `${name} (copy)`,
        flag: source.flag || '',
        comment: source.comment || '',
        country: source.country || '',
        ip: '',
        // Host identity stays empty: a second node answering on the same domain
        // fights over the ACME certificate and the subscription links.
        domain: '',
        sni: source.sni || '',
        port: source.port,
        portRange: source.portRange,
        hopInterval: source.hopInterval,
        portConfigs: Array.isArray(source.portConfigs) ? source.portConfigs : [],
        obfs: source.obfs,
        acme: source.acme,
        masquerade: source.masquerade,
        bandwidth: source.bandwidth,
        ignoreClientBandwidth: source.ignoreClientBandwidth,
        speedTest: source.speedTest,
        disableUDP: source.disableUDP,
        udpIdleTimeout: source.udpIdleTimeout,
        sniff: source.sniff,
        quic: source.quic,
        resolver: source.resolver,
        acl: source.acl,
        statsPort: source.statsPort,
        statsSecret: '',
        xray,
        virtual: source.virtual,
        cdn: source.cdn,
        groups: source.groups || [],
        ssh: { port: 22, username: 'root', privateKey: '', password: '' },
        paths: source.paths,
        outbounds: isXray && Array.isArray(source.outbounds) ? source.outbounds : [],
        aclRules: isXray
            ? (Array.isArray(source.aclRules) ? source.aclRules : [])
            : cloneableAclRules(source.aclRules),
        active: source.active !== false,
        rankingCoefficient: source.rankingCoefficient,
        settings: source.settings,
        customConfig: source.customConfig || '',
        useCustomConfig: !!source.useCustomConfig,
        useTlsFiles: !!source.useTlsFiles,
        initScript: source.initScript || '',
        cascadeRole: source.cascadeRole || 'standalone',
        maxOnlineUsers: source.maxOnlineUsers || 0,
    };
}

module.exports = {
    backupUpload,
    buildSshKeyFilename,
    connectNodeSSH,
    parseXrayFormFields,
    parseExtraInbounds,
    validateXrayFormFields,
    ensureExtraInboundRealityKeys,
    resolveManualKeyPlaceholder,
    sanitizeXrayForRender,
    MANUAL_KEY_PLACEHOLDER,
    XRAY_TLS_SOURCE_VALUES,
    XRAY_XHTTP_MODE_VALUES,
    parseBool,
    parseHeaderMap,
    parseHysteriaFormFields,
    parseAclRulesInput,
    parseOutboundsFormFields,
    getHysteriaAclInlineState,
    validateHysteriaFormFields,
    checkIpWhitelist,
    requireAuth,
    requireOnboarding,
    invalidateOnboardingCache,
    render,
    loginLimiter,
    totpVerifyLimiter,
    generateSshKeyLimiter,
    sniScanLimiter,
    clearPanelTotpPending,
    clearPanelLoginTotpLockout,
    setPanelLoginTotpLockout,
    getPanelLoginTotpLockout,
    renderPanelLoginPage,
    getPanelTotpPending,
    renderPanelTotpPage,
    redirectSettingsSecurity,
    SETTINGS_TOTP_ACTIONS,
    buildClonedNodePrefill,
};
