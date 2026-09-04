/**
 * Hysteria 2 / Xray config generator
 */

const yaml = require('yaml');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const appConfig = require('../../config');

// Canonical on-node path for the Xray access log when the opt-in access-logs
// module is enabled. The cc-agent tails exactly this file.
const XRAY_ACCESS_LOG_PATH = '/var/log/xray/access.log';

// Build the Xray `log` section. When per-node access logging is enabled we write
// an explicit access-file path; otherwise we explicitly disable it with "none"
// (an empty/absent value would send access lines to stdout/journald noise).
// The error log is deliberately NOT set: leaving it absent keeps warnings and
// errors flowing to stdout -> journald, which admins rely on for diagnostics
// (`journalctl -u xray`). Never silence it.
function buildXrayLogSection(node) {
    const enabled = !!(node && node.xray && node.xray.accessLogs && node.xray.accessLogs.enabled);
    return {
        loglevel: 'warning',
        access: enabled ? XRAY_ACCESS_LOG_PATH : 'none',
    };
}

// ─── Panel TLS certificate inlining (Marzban-style) ──────────────────────────
//
// When a Xray node is configured with tlsSource==='panel', we read the panel's
// LE certificate from disk on every config generation and inline the PEM blocks
// as `certificate[]`/`key[]` arrays into `tlsSettings.certificates[0]`. This
// keeps remote nodes free of any local cert files: the cert lives only on the
// panel, gets shipped inside config.json over SSH, and is automatically rotated
// whenever Caddy/Greenlock writes a new fullchain.
//
// We cache by mtime to avoid re-reading the file once per node when generating
// configs for many nodes in the same sync cycle. The cache TTL is bounded so a
// stalled mtime check (e.g. mounted FS oddity) cannot pin a stale value forever.
const _panelCertCache = {
    cert: null,
    key: null,
    mtimeMs: 0,
    cachedAt: 0,
    sourcePath: '',
};
const PANEL_CERT_CACHE_TTL_MS = 30_000;

function _panelCertCandidates(domain) {
    const safe = String(domain || '').trim();
    if (!safe) return [];
    return [
        // Caddy (Docker/production)
        {
            cert: path.join('/caddy_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory', safe, `${safe}.crt`),
            key: path.join('/caddy_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory', safe, `${safe}.key`),
        },
        // Greenlock (standalone dev)
        {
            cert: path.join(__dirname, '../../greenlock.d/live', safe, 'fullchain.pem'),
            key: path.join(__dirname, '../../greenlock.d/live', safe, 'privkey.pem'),
        },
    ];
}

/**
 * Convert a PEM-string into the array-of-lines shape Xray expects in
 * `tlsSettings.certificates[].certificate` / `.key`. Strips empty lines and
 * trailing whitespace; the result is a tight JSON array.
 *
 * @param {string} pem
 * @returns {string[]}
 */
function parsePemBlock(pem) {
    return String(pem || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.trimEnd())
        .filter(line => line.length > 0);
}

/**
 * Read panel certificate/key (Caddy or Greenlock) and return the PEM split
 * into Xray inline arrays, with a small in-process cache keyed on mtime.
 * Returns null when no cert is available — the caller decides the fallback.
 *
 * Performance: a single fs.statSync per call (microseconds). The PEM is only
 * re-read from disk when the file's mtime changed since the last call, so
 * generating configs for N nodes does at most one read per cert rotation.
 *
 * @returns {{ certificate: string[], key: string[], domain: string, mtimeMs: number } | null}
 */
function buildPanelInlineCertificate() {
    const domain = appConfig?.PANEL_DOMAIN || '';
    if (!domain) return null;

    const candidates = _panelCertCandidates(domain);
    let chosen = null;
    let mtimeMs = 0;
    for (const cand of candidates) {
        try {
            const certStat = fs.statSync(cand.cert);
            const keyStat = fs.statSync(cand.key);
            chosen = cand;
            mtimeMs = Math.max(certStat.mtimeMs || 0, keyStat.mtimeMs || 0);
            break;
        } catch (_) {
            // Try next candidate
        }
    }
    if (!chosen) {
        if (_panelCertCache.cert) {
            // Cert source disappeared (mount glitch?). Surface a warning but
            // do not return stale PEM — config without certs is safer.
            logger.warn(`[configGenerator] Panel certificate path missing for ${domain}; cleared inline cache`);
            _panelCertCache.cert = null;
            _panelCertCache.key = null;
            _panelCertCache.mtimeMs = 0;
            _panelCertCache.cachedAt = 0;
            _panelCertCache.sourcePath = '';
        }
        return null;
    }

    const now = Date.now();
    const fresh = _panelCertCache.cert &&
        _panelCertCache.sourcePath === chosen.cert &&
        _panelCertCache.mtimeMs === mtimeMs &&
        (now - _panelCertCache.cachedAt) < PANEL_CERT_CACHE_TTL_MS;
    if (fresh) {
        return {
            certificate: _panelCertCache.cert,
            key: _panelCertCache.key,
            domain,
            mtimeMs,
        };
    }

    try {
        const certPem = fs.readFileSync(chosen.cert, 'utf8');
        const keyPem = fs.readFileSync(chosen.key, 'utf8');
        const certificate = parsePemBlock(certPem);
        const key = parsePemBlock(keyPem);
        if (certificate.length === 0 || key.length === 0) {
            logger.warn(`[configGenerator] Panel cert/key looks empty (${chosen.cert})`);
            return null;
        }
        _panelCertCache.cert = certificate;
        _panelCertCache.key = key;
        _panelCertCache.mtimeMs = mtimeMs;
        _panelCertCache.cachedAt = now;
        _panelCertCache.sourcePath = chosen.cert;
        return { certificate, key, domain, mtimeMs };
    } catch (err) {
        logger.error(`[configGenerator] Failed to read panel certificate at ${chosen.cert}: ${err.message}`);
        return null;
    }
}

/**
 * Forget the cached panel certificate. Called by the cert-rotation watcher
 * after detecting a new mtime so the next config build performs a fresh read.
 */
function invalidatePanelCertCache() {
    _panelCertCache.cert = null;
    _panelCertCache.key = null;
    _panelCertCache.mtimeMs = 0;
    _panelCertCache.cachedAt = 0;
    _panelCertCache.sourcePath = '';
}

/**
 * Parse a host:port string, handling IPv6 brackets (e.g. [::1]:8080).
 * @param {string} addr
 * @param {number} defaultPort
 * @returns {{ host: string, port: number }}
 */
/**
 * Build Xray outbound user object based on protocol.
 * VLESS uses `encryption`, VMess uses `security` + `alterId`.
 */
function buildOutboundUser(uuid, protocol) {
    if (protocol === 'vmess') {
        return { id: uuid, alterId: 0, security: 'auto' };
    }
    return { id: uuid, encryption: 'none' };
}

function parseHostPort(addr, defaultPort) {
    // [IPv6]:port
    if (addr.startsWith('[')) {
        const closeBracket = addr.indexOf(']');
        if (closeBracket !== -1) {
            const host = addr.slice(1, closeBracket);
            const rest = addr.slice(closeBracket + 1);
            const port = rest.startsWith(':') ? parseInt(rest.slice(1)) : defaultPort;
            return { host, port: port || defaultPort };
        }
    }
    // Bare IPv6 without port (multiple colons = IPv6, no way to distinguish port)
    const colonCount = (addr.match(/:/g) || []).length;
    if (colonCount > 1) {
        return { host: addr, port: defaultPort };
    }
    // IPv4 or hostname:port
    const lastColon = addr.lastIndexOf(':');
    if (lastColon <= 0) return { host: addr, port: defaultPort };
    const host = addr.slice(0, lastColon);
    const port = parseInt(addr.slice(lastColon + 1));
    return { host, port: port || defaultPort };
}

/**
 * Generate YAML config for Hysteria 2 node
 * @param {Object} node - Node configuration
 * @param {string} authUrl - Auth API URL
 * @param {Object} options - Additional options
 * @param {boolean} options.authInsecure - Allow self-signed certs for auth API (default: true)
 * @param {boolean} options.useTlsFiles - Force using TLS files instead of ACME (for same-VPS setup)
 */
function generateNodeConfig(node, authUrl, options = {}) {
    const { authInsecure = true, useTlsFiles = false } = options;
    
    const config = {
        listen: `:${node.port}`,

        auth: {
            type: 'http',
            http: {
                url: authUrl,
                insecure: authInsecure,
            },
        },
        masquerade: buildMasqueradeConfig(node),
    };
    
    if (node.domain && !useTlsFiles) {
        // ACME - SNI must match domain (sniGuard: dns-san by default)
        config.acme = buildAcmeConfig(node);
    } else {
        // TLS with certificate files (self-signed or copied from panel)
        config.tls = {
            cert: node.paths?.cert || '/etc/hysteria/cert.pem',
            key: node.paths?.key || '/etc/hysteria/key.pem',
        };
        // If custom SNI is set, disable sniGuard to allow domain fronting
        if (node.sni) {
            config.tls.sniGuard = 'disable';
        }
    }
    
    if (node.obfs?.type && node.obfs?.password) {
        config.obfs = {
            type: node.obfs.type,
            [node.obfs.type]: { password: node.obfs.password },
        };
    }

    config.sniff = buildSniffConfig(node);
    config.quic = buildQuicConfig(node);

    if (node.bandwidth?.up || node.bandwidth?.down) {
        config.bandwidth = {};
        if (node.bandwidth.up) config.bandwidth.up = node.bandwidth.up;
        if (node.bandwidth.down) config.bandwidth.down = node.bandwidth.down;
    }

    config.ignoreClientBandwidth = !!node.ignoreClientBandwidth;

    if (node.speedTest) {
        config.speedTest = true;
    }

    if (node.disableUDP) {
        config.disableUDP = true;
    }

    if (node.udpIdleTimeout) {
        config.udpIdleTimeout = node.udpIdleTimeout;
    }

    const resolverConfig = buildResolverConfig(node);
    if (resolverConfig) {
        config.resolver = resolverConfig;
    }

    if (node.statsPort && node.statsSecret) {
        config.trafficStats = {
            listen: `:${node.statsPort}`,
            secret: node.statsSecret,
        };
    }
    
    applyOutboundsAndAcl(config, node);
    
    return yaml.stringify(config);
}

function buildAcmeConfig(node) {
    const acme = node.acme || {};
    const cfg = {
        domains: [node.domain],
        email: acme.email || ('acme@' + node.domain),
        ca: acme.ca || 'letsencrypt',
        listenHost: acme.listenHost || '0.0.0.0',
    };

    const type = (acme.type || '').trim();
    if (['http', 'tls'].includes(type)) {
        cfg.type = type;
    }

    if (type === 'http' && Number(acme.httpAltPort) > 0) {
        cfg.http = { altPort: Number(acme.httpAltPort) };
    }
    if (type === 'tls' && Number(acme.tlsAltPort) > 0) {
        cfg.tls = { altPort: Number(acme.tlsAltPort) };
    }
    if (type === 'dns' && acme.dnsName) {
        cfg.type = 'dns';
        cfg.dns = { name: acme.dnsName };
        if (acme.dnsConfig && typeof acme.dnsConfig === 'object' && Object.keys(acme.dnsConfig).length > 0) {
            cfg.dns.config = acme.dnsConfig;
        }
    }

    return cfg;
}

function buildMasqueradeConfig(node) {
    const masq = node.masquerade || {};
    const type = masq.type === 'string' ? 'string' : 'proxy';
    const cfg = { type };

    if (type === 'string') {
        const statusCodeRaw = Number(masq.string?.statusCode) || 503;
        const statusCode = Math.min(599, Math.max(100, statusCodeRaw));
        const content = String(masq.string?.content || 'Service Unavailable').replace(/\r\n?/g, '\n');
        cfg.string = {
            content,
            statusCode,
        };
        if (masq.string?.headers && typeof masq.string.headers === 'object' && Object.keys(masq.string.headers).length > 0) {
            cfg.string.headers = masq.string.headers;
        } else {
            cfg.string.headers = { 'content-type': 'text/plain' };
        }
    } else {
        cfg.proxy = {
            url: masq.proxy?.url || 'https://www.google.com',
            rewriteHost: masq.proxy?.rewriteHost !== false,
        };
        if (masq.proxy?.insecure) cfg.proxy.insecure = true;
    }

    if (masq.listenHTTP) cfg.listenHTTP = masq.listenHTTP;
    if (masq.listenHTTPS) cfg.listenHTTPS = masq.listenHTTPS;
    if (masq.forceHTTPS) cfg.forceHTTPS = true;

    return cfg;
}

function buildSniffConfig(node) {
    const sniff = node.sniff || {};
    return {
        enable: sniff.enable !== false,
        timeout: sniff.timeout || '2s',
        rewriteDomain: !!sniff.rewriteDomain,
        tcpPorts: sniff.tcpPorts || '80,443,8000-9000',
        udpPorts: sniff.udpPorts || '443,80,53',
    };
}

function safePositiveInteger(raw, fallback) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) return fallback;
    return value;
}

function buildQuicConfig(node) {
    const quic = node.quic || {};
    const initStreamReceiveWindow = safePositiveInteger(quic.initStreamReceiveWindow, 8388608);
    const maxStreamReceiveWindow = safePositiveInteger(quic.maxStreamReceiveWindow, 8388608);
    const initConnReceiveWindow = safePositiveInteger(quic.initConnReceiveWindow, 20971520);
    const maxConnReceiveWindow = safePositiveInteger(quic.maxConnReceiveWindow, 20971520);

    return {
        initStreamReceiveWindow,
        maxStreamReceiveWindow: Math.max(maxStreamReceiveWindow, initStreamReceiveWindow),
        initConnReceiveWindow,
        maxConnReceiveWindow: Math.max(maxConnReceiveWindow, initConnReceiveWindow),
        maxIdleTimeout: quic.maxIdleTimeout || '60s',
        maxIncomingStreams: safePositiveInteger(quic.maxIncomingStreams, 256),
        disablePathMTUDiscovery: !!quic.disablePathMTUDiscovery,
    };
}

function buildResolverConfig(node) {
    const resolver = node.resolver || {};
    if (!resolver.enabled) return null;

    const type = resolver.type || 'udp';
    const cfg = { type };

    if (type === 'udp') {
        cfg.udp = {
            addr: resolver.udpAddr || '8.8.4.4:53',
            timeout: resolver.udpTimeout || '4s',
        };
    } else if (type === 'tcp') {
        cfg.tcp = {
            addr: resolver.tcpAddr || '8.8.8.8:53',
            timeout: resolver.tcpTimeout || '4s',
        };
    } else if (type === 'tls') {
        cfg.tls = {
            addr: resolver.tlsAddr || '1.1.1.1:853',
            timeout: resolver.tlsTimeout || '10s',
            sni: resolver.tlsSni || 'cloudflare-dns.com',
            insecure: !!resolver.tlsInsecure,
        };
    } else if (type === 'https') {
        cfg.https = {
            addr: resolver.httpsAddr || '1.1.1.1:443',
            timeout: resolver.httpsTimeout || '10s',
            sni: resolver.httpsSni || 'cloudflare-dns.com',
            insecure: !!resolver.httpsInsecure,
        };
    }

    return cfg;
}

/**
 * Apply outbounds and ACL rules from node settings to config object
 * @param {Object} config - Hysteria config object (mutated in place)
 * @param {Object} node - Node with outbounds and aclRules fields
 */
function applyOutboundsAndAcl(config, node) {
    const customOutbounds = node.outbounds || [];
    const customAclRules = node.aclRules || [];
    const aclOptions = node.acl || {};
    const aclEnabled = aclOptions.enabled !== false;
    
    // In Hysteria 2, valid outbound types are: direct, socks5, http
    // 'block' type is not a real outbound — 'reject' is a built-in ACL action
    const realOutbounds = customOutbounds.filter(ob => ob.type !== 'block');
    
    if (realOutbounds.length > 0) {
        config.outbounds = realOutbounds.map(ob => {
            const entry = { name: ob.name, type: ob.type };
            if (ob.type === 'socks5') {
                // SOCKS5 format: { addr, username?, password? }
                const proxyConfig = { addr: ob.addr };
                if (ob.username) proxyConfig.username = ob.username;
                if (ob.password) proxyConfig.password = ob.password;
                entry.socks5 = proxyConfig;
            } else if (ob.type === 'http') {
                // HTTP format: { url, insecure? }
                // url can include auth: http://user:pass@host:port
                let url = ob.addr;
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = 'http://' + url;
                }
                if (ob.username && ob.password) {
                    // Insert auth into URL: http://user:pass@host:port
                    const urlObj = new URL(url);
                    urlObj.username = ob.username;
                    urlObj.password = ob.password;
                    url = urlObj.toString();
                }
                entry.http = { url };
                if (ob.insecure) entry.http.insecure = true;
            } else if (ob.type === 'direct') {
                const direct = ob.direct || {};
                const directCfg = {};
                if (direct.mode) directCfg.mode = direct.mode;
                if (direct.bindIPv4) directCfg.bindIPv4 = direct.bindIPv4;
                if (direct.bindIPv6) directCfg.bindIPv6 = direct.bindIPv6;
                if (direct.bindDevice) directCfg.bindDevice = direct.bindDevice;
                if (direct.fastOpen) directCfg.fastOpen = true;
                if (Object.keys(directCfg).length > 0) {
                    entry.direct = directCfg;
                }
            }
            return entry;
        });
    }
    
    if (!aclEnabled) {
        return;
    }

    const aclType = aclOptions.type === 'file' ? 'file' : 'inline';
    let aclConfig;

    if (aclType === 'file' && aclOptions.file) {
        aclConfig = { file: aclOptions.file };
    } else if (customAclRules.length > 0) {
        // 'block' is not a valid ACL action in Hysteria 2 — replace with 'reject'
        const normalizedRules = customAclRules.map(r => r.replace(/\bblock\(/g, 'reject('));
        aclConfig = { inline: normalizedRules };
    } else {
        // Legacy safe defaults when ACL is enabled but no explicit source is provided.
        aclConfig = {
            inline: [
                'reject(geoip:cn)',
                'reject(geoip:private)',
            ],
        };
    }

    if (aclOptions.geoip) aclConfig.geoip = aclOptions.geoip;
    if (aclOptions.geosite) aclConfig.geosite = aclOptions.geosite;
    if (aclOptions.geoUpdateInterval) aclConfig.geoUpdateInterval = aclOptions.geoUpdateInterval;
    config.acl = aclConfig;
}

/**
 * Generate config with ACME (Let's Encrypt)
 * @param {Object} node - Node configuration
 * @param {string} authUrl - Auth API URL
 * @param {string} domain - ACME domain
 * @param {string} email - ACME email
 * @param {Object} options - Additional options
 * @param {boolean} options.authInsecure - Allow self-signed certs for auth API (default: true)
 */
function generateNodeConfigACME(node, authUrl, domain, email, options = {}) {
    const hydrated = {
        ...node,
        domain,
        acme: {
            ...(node.acme || {}),
            email: email || node.acme?.email,
        },
    };
    return generateNodeConfig(hydrated, authUrl, { ...options, useTlsFiles: false });
}

/**
 * Generate systemd service file for Hysteria
 */
function generateSystemdService() {
    return `[Unit]
Description=Hysteria 2 Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hysteria server -c /etc/hysteria/config.yaml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`;
}

// ==================== XRAY ====================

/**
 * Validate an XHTTP range value ("100-1000", or a bare "500" meaning 500-500).
 * Anything else is dropped: Xray refuses to start on a malformed range, which
 * would take the whole node down rather than just ignore one knob.
 */
function _xhttpRange(value) {
    const v = String(value || '').trim();
    return /^\d{1,10}(-\d{1,10})?$/.test(v) ? v : null;
}

// Xray's own fallbacks when the client sends no XHTTP tuning (splithttp
// config.go): padding length 100-1000, one upload chunk up to 1 MB.
const XHTTP_DEFAULT_PADDING = [100, 1000];
const XHTTP_DEFAULT_MAX_EACH_POST = 1000000;

/**
 * Widen a padding range so it also covers Xray's client-side default.
 *
 * The inbound rejects a request whose padding length falls outside this range
 * (400 Bad Request), and not every client learns the configured value: Clash
 * has no field for it, and older apps ignore the URI hints. Accepting the union
 * keeps those clients working while configured ones still pad as instructed —
 * the range only gates what the server tolerates, never what it sends.
 *
 * @param {string} range  validated "min-max" or bare number
 * @returns {string}
 */
function _xhttpPaddingSuperset(range) {
    const [from, to = from] = range.split('-').map(Number);
    const min = Math.min(from, XHTTP_DEFAULT_PADDING[0]);
    const max = Math.max(to, XHTTP_DEFAULT_PADDING[1]);
    return `${min}-${max}`;
}

/**
 * Raise an upload-chunk limit to at least Xray's client-side default.
 *
 * Same reasoning as padding, but the failure is worse: the inbound silently
 * drops every post larger than its limit, so a client left on the 1 MB default
 * would stall instead of erroring. Operators can only widen the limit here;
 * narrowing it would break exactly those clients.
 *
 * @param {string} range  validated "min-max" or bare number
 * @returns {string}
 */
function _xhttpMaxEachPostSuperset(range) {
    const to = Number(range.split('-').pop());
    return String(Math.max(to, XHTTP_DEFAULT_MAX_EACH_POST));
}

/**
 * Build Xray streamSettings from a per-inbound config object.
 * The shape matches both the flat `node.xray` (main inbound) and the items of
 * `node.xray.extraInbounds[]`. TLS certificate paths fall back to
 * `node.paths.{cert,key}` and TLS serverName falls back to `node.domain || node.sni`.
 *
 * @param {Object} inbound - Per-inbound config (transport, security, reality*, ws*, grpc*, xhttp*, alpn)
 * @param {Object} [node] - Owning node for certificate paths and TLS serverName fallback
 * @returns {Object} streamSettings
 */
function buildXrayStreamSettings(inbound, node = {}) {
    const transport = inbound.transport || 'tcp';
    const security = inbound.security || 'reality';

    // Xray-core 25.x+ renamed 'splithttp' to 'xhttp' (REALITY since 26.x
    // accepts only RAW/XHTTP/gRPC — the legacy splithttp keyword is rejected).
    const streamSettings = { network: transport };

    if (security === 'reality') {
        streamSettings.security = 'reality';
        streamSettings.realitySettings = {
            dest: inbound.realityDest || 'www.google.com:443',
            serverNames: inbound.realitySni && inbound.realitySni.length > 0
                ? inbound.realitySni
                : ['www.google.com'],
            privateKey: inbound.realityPrivateKey || '',
            shortIds: inbound.realityShortIds && inbound.realityShortIds.length > 0
                ? inbound.realityShortIds
                : [''],
        };
        // spiderX is a client-side hint (only consumed by REALITY's UClient on
        // failed verification). Emit the field only when explicitly set so an
        // empty value doesn't pin all nodes to the predictable "/" default.
        if (inbound.realitySpiderX) {
            streamSettings.realitySettings.spiderX = inbound.realitySpiderX;
        }
    } else if (security === 'tls') {
        // tlsSource lives on the node (not per-inbound) so extra inbounds inherit
        // the same certificate strategy as the main one — matches Marzban's
        // per-node provisioning model.
        const tlsSource = (node?.xray?.tlsSource) || 'panel';
        let certificates;
        let serverName;
        if (tlsSource === 'panel') {
            const panelCert = buildPanelInlineCertificate();
            serverName = appConfig?.PANEL_DOMAIN || node.domain || node.sni || '';
            if (panelCert) {
                certificates = [{
                    ocspStapling: 3600,
                    certificate: panelCert.certificate,
                    key: panelCert.key,
                }];
            } else {
                const reason = (appConfig?.PANEL_DOMAIN || '').trim()
                    ? `panel certificate file unreadable for ${appConfig.PANEL_DOMAIN}`
                    : 'PANEL_DOMAIN env var is not set';
                const err = new Error(`PANEL_CERT_UNAVAILABLE: ${reason}`);
                err.code = 'PANEL_CERT_UNAVAILABLE';
                throw err;
            }
        } else if (tlsSource === 'manual') {
            serverName = node.domain || node.sni || '';
            const certificate = parsePemBlock(node?.xray?.manualCert);
            const key = parsePemBlock(node?.xray?.manualKey);
            if (certificate.length === 0 || key.length === 0) {
                const err = new Error(`MANUAL_CERT_UNAVAILABLE: manual TLS PEM missing for node ${node?.name || node?.ip || ''}`);
                err.code = 'MANUAL_CERT_UNAVAILABLE';
                throw err;
            }
            certificates = [{
                ocspStapling: 3600,
                certificate,
                key,
            }];
        } else {
            // acme + self-signed — cert files live on the node at fixed paths.
            // node.paths is Hysteria-only, do not reuse here. Default catch-all.
            serverName = node.domain || node.sni || '';
            certificates = [{
                certificateFile: '/usr/local/etc/xray/cert.pem',
                keyFile: '/usr/local/etc/xray/key.pem',
            }];
        }
        streamSettings.security = 'tls';
        streamSettings.tlsSettings = {
            serverName,
            minVersion: '1.2',
            certificates,
        };
        const alpn = (inbound.alpn && inbound.alpn.length > 0) ? inbound.alpn : ['h2', 'http/1.1'];
        streamSettings.tlsSettings.alpn = alpn;
    } else {
        streamSettings.security = 'none';
    }

    if (transport === 'ws') {
        streamSettings.wsSettings = {
            path: inbound.wsPath || '/',
            headers: inbound.wsHost ? { Host: inbound.wsHost } : {},
        };
    } else if (transport === 'grpc') {
        streamSettings.grpcSettings = {
            serviceName: inbound.grpcServiceName || 'grpc',
        };
    } else if (transport === 'xhttp') {
        streamSettings.xhttpSettings = {
            path: inbound.xhttpPath || '/',
            host: inbound.xhttpHost || '',
            mode: inbound.xhttpMode || 'auto',
        };
        // Server side of the client `extra` block. Only the knobs the inbound
        // acts on: xmux and noGRPCHeader are client-only in Xray, so emitting
        // them here would be noise. Ranges are validated before use — a bad
        // value would make the node's Xray refuse to start — and then widened
        // to a superset of the client defaults so clients that never received
        // the tuning are still accepted.
        const extra = {};
        const padding = _xhttpRange(inbound.xhttpXPaddingBytes);
        const maxEachPost = _xhttpRange(inbound.xhttpScMaxEachPostBytes);
        if (padding) extra.xPaddingBytes = _xhttpPaddingSuperset(padding);
        if (maxEachPost) extra.scMaxEachPostBytes = _xhttpMaxEachPostSuperset(maxEachPost);
        if (Object.keys(extra).length > 0) {
            streamSettings.xhttpSettings.extra = extra;
        }
    }

    return streamSettings;
}

/**
 * Build a VLESS clients array for a given inbound. Flow is added only when the
 * combination supports it (tcp + reality/tls); otherwise it must be empty,
 * because Xray rejects non-empty flow on incompatible transports.
 */
function buildXrayClients(users, inbound) {
    const security = inbound.security || 'reality';
    const transport = inbound.transport || 'tcp';
    const useFlow = (security === 'reality' || security === 'tls') && transport === 'tcp';
    return (users || []).map(u => {
        const client = {
            id: u.xrayUuid,
            email: u.userId,
            level: 0,
        };
        if (useFlow) {
            client.flow = inbound.flow || 'xtls-rprx-vision';
        }
        return client;
    });
}

/**
 * Build a VLESS inbound entry from a per-inbound config. Used both for the
 * main inbound and each item in `extraInbounds[]`.
 */
function buildVlessInbound(inbound, users, node) {
    const settings = {
        clients: buildXrayClients(users, inbound),
        decryption: 'none',
    };

    // VLESS fallbacks: TCP+TLS only per Xray spec.
    const fallbackDest = (inbound.fallbackDest || '').trim();
    if (fallbackDest && inbound.transport === 'tcp' && inbound.security === 'tls') {
        settings.fallbacks = [{ dest: fallbackDest }];
    }

    return {
        listen: inbound.listen || '0.0.0.0',
        port: inbound.port || 443,
        protocol: 'vless',
        tag: inbound.inboundTag,
        settings,
        streamSettings: buildXrayStreamSettings(inbound, node),
        sniffing: {
            enabled: true,
            destOverride: ['http', 'tls', 'quic'],
            routeOnly: true,
        },
    };
}

/**
 * Generate Xray JSON config for a node with all its users
 * @param {Object} node - Node document (with xray sub-object)
 * @param {Array} users - Array of user documents (with xrayUuid)
 * @returns {string} JSON string
 */
function generateXrayConfig(node, users) {
    const xray = node.xray || {};
    const apiPort = xray.apiPort || 61000;
    const mainInboundTag = xray.inboundTag || 'vless-in';

    // Main inbound is described by the flat xray.* fields plus node.port.
    const mainInbound = {
        listen: xray.listen || '0.0.0.0',
        port: node.port || 443,
        inboundTag: mainInboundTag,
        transport: xray.transport,
        security: xray.security,
        flow: xray.flow,
        alpn: xray.alpn,
        realityDest: xray.realityDest,
        realitySni: xray.realitySni,
        realityPrivateKey: xray.realityPrivateKey,
        realityShortIds: xray.realityShortIds,
        realitySpiderX: xray.realitySpiderX,
        wsPath: xray.wsPath,
        wsHost: xray.wsHost,
        grpcServiceName: xray.grpcServiceName,
        xhttpPath: xray.xhttpPath,
        xhttpHost: xray.xhttpHost,
        xhttpMode: xray.xhttpMode,
        xhttpXPaddingBytes: xray.xhttpXPaddingBytes,
        xhttpScMaxEachPostBytes: xray.xhttpScMaxEachPostBytes,
        fallbackDest: xray.fallbackDest,
    };

    const extraInbounds = Array.isArray(xray.extraInbounds) ? xray.extraInbounds : [];

    const config = {
        log: buildXrayLogSection(node),
        api: {
            services: ['HandlerService', 'StatsService'],
            tag: 'API',
        },
        stats: {},
        policy: {
            levels: {
                '0': {
                    statsUserUplink: true,
                    statsUserDownlink: true,
                },
            },
            system: {
                statsInboundUplink: true,
                statsInboundDownlink: true,
                statsOutboundUplink: true,
                statsOutboundDownlink: true,
            },
        },
        inbounds: [
            // gRPC API inbound (local only, for user management)
            {
                listen: '127.0.0.1',
                port: apiPort,
                protocol: 'dokodemo-door',
                settings: { address: '127.0.0.1' },
                tag: 'API_INBOUND',
            },
            buildVlessInbound(mainInbound, users, node),
            ...extraInbounds.map(extra => buildVlessInbound(extra, users, node)),
        ],
        outbounds: [
            { protocol: 'freedom', tag: 'direct' },
            { protocol: 'blackhole', tag: 'block' },
        ],
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: [
                {
                    inboundTag: ['API_INBOUND'],
                    outboundTag: 'API',
                    type: 'field',
                },
                // geoip:private is added last via ensurePrivateIpBlock() after
                // all cascade rules are applied, so cascade tunnels to LAN IPs work
            ],
        },
    };

    // Apply custom outbounds (socks5/http proxies) from node settings
    const customOutbounds = node.outbounds || [];
    for (const ob of customOutbounds) {
        if (ob.type === 'socks5' || ob.type === 'socks') {
            const { host, port } = parseHostPort(ob.addr || '127.0.0.1:1080', 1080);
            const outbound = {
                tag: ob.name || `socks-${host}`,
                protocol: 'socks',
                settings: {
                    servers: [{
                        address: host,
                        port,
                    }],
                },
            };
            if (ob.username && ob.password) {
                outbound.settings.servers[0].users = [{
                    user: ob.username,
                    pass: ob.password,
                }];
            }
            config.outbounds.push(outbound);
        } else if (ob.type === 'http') {
            const { host, port } = parseHostPort(ob.addr || '127.0.0.1:8080', 8080);
            const outbound = {
                tag: ob.name || `http-${host}`,
                protocol: 'http',
                settings: {
                    servers: [{
                        address: host,
                        port,
                    }],
                },
            };
            if (ob.username && ob.password) {
                outbound.settings.servers[0].users = [{
                    user: ob.username,
                    pass: ob.password,
                }];
            }
            config.outbounds.push(outbound);
        }
    }

    // Apply ACL rules as routing rules.
    //
    // Accepted action grammar: <action>(<target>) where action is one of the
    // built-ins (reject / direct / proxy) OR the name of a custom outbound
    // declared above (e.g. `ukr(all)` -> route to the `ukr` SOCKS5/HTTP
    // outbound). The `proxy` keyword is kept for backward compatibility and
    // resolves to the first custom outbound. Target `all` becomes a catch-all
    // field-rule with no domain/ip filter, matching every connection from the
    // VLESS inbounds (issue #75).
    const customOutboundNames = new Set(customOutbounds.map(o => o && o.name).filter(Boolean));
    // Xray rejects condition-less routing rules, so scope `all` to VLESS inbounds.
    const vlessInboundTags = [mainInboundTag, ...extraInbounds.map(e => e && e.inboundTag).filter(Boolean)];
    const aclRules = node.aclRules || [];
    for (const rule of aclRules) {
        const match = rule.match(/^([\w\-]+)\((.+)\)$/);
        if (!match) {
            if (rule.trim()) logger.warn(`[Xray ACL] Skipping unparsable rule: "${rule}"`);
            continue;
        }
        const [, action, target] = match;

        let outboundTag;
        if (action === 'reject') {
            outboundTag = 'block';
        } else if (action === 'direct') {
            outboundTag = 'direct';
        } else if (action === 'proxy') {
            outboundTag = customOutbounds[0]?.name;
        } else if (customOutboundNames.has(action)) {
            outboundTag = action;
        }

        if (!outboundTag) {
            logger.warn(`[Xray ACL] Skipping rule with unknown action "${action}": "${rule}"`);
            continue;
        }

        const routingRule = { type: 'field', outboundTag };
        if (target !== 'all') {
            if (target.startsWith('geoip:')) {
                routingRule.ip = [target];
            } else if (target.startsWith('geosite:')) {
                routingRule.domain = [target];
            } else {
                routingRule.domain = [`full:${target}`];
            }
        } else {
            routingRule.inboundTag = vlessInboundTags;
            routingRule.ruleTag = 'acl-catch-all';
        }

        config.routing.rules.push(routingRule);
    }

    // geoip:private block is added later by ensurePrivateIpBlock() after cascade rules

    return JSON.stringify(config, null, 2);
}

/**
 * Generate systemd service file for Xray
 */
function generateXraySystemdService() {
    return `[Unit]
Description=Xray Service
After=network.target nss-lookup.target

[Service]
User=nobody
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Type=simple
# Creates /var/log/xray owned by the service user, so the optional access-log
# module can write there without manual permission fixes.
LogsDirectory=xray
ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray/config.json
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`;
}

// ==================== XRAY CASCADE (Reverse Proxy) ====================

/**
 * Apply reverse-portal configuration to an existing Xray config object.
 * Adds portal entries, bridge-connector inbounds, and routing rules for
 * every active CascadeLink where this node is the Portal (entry).
 *
 * @param {Object} config - Parsed Xray config object (mutated in place)
 * @param {Array} portalLinks - CascadeLink documents where this node is portalNode
 * @param {string|string[]} clientInboundTags - Tag(s) of the client-facing inbound(s).
 *        A string is accepted for backward compatibility; multiple tags route
 *        traffic from any of the listed inbounds (main + extras) into the cascade.
 */
function applyReversePortal(config, portalLinks, clientInboundTags) {
    if (!portalLinks || portalLinks.length === 0) return;
    const tags = normalizeInboundTags(clientInboundTags);

    config.reverse = config.reverse || {};
    config.reverse.portals = config.reverse.portals || [];
    config.inbounds = config.inbounds || [];
    config.routing = config.routing || { rules: [] };
    config.routing.rules = config.routing.rules || [];

    const geoLinks = [];
    const defaultLinks = [];

    for (const link of portalLinks) {
        const linkIdShort = String(link._id).slice(-8);
        const portalTag = `portal-${linkIdShort}`;
        const connectorTag = `bridge-conn-${linkIdShort}`;

        config.reverse.portals.push({
            tag: portalTag,
            domain: link.tunnelDomain || 'reverse.tunnel.internal',
        });

        const protocol = link.tunnelProtocol || 'vless';
        const settings = { clients: [{ id: link.tunnelUuid }] };
        if (protocol === 'vless') settings.decryption = 'none';

        const inbound = {
            tag: connectorTag,
            listen: '0.0.0.0',
            port: link.tunnelPort || 10086,
            protocol,
            settings,
            streamSettings: buildCascadeTunnelStreamSettings(link, { server: true }),
        };

        config.inbounds.push(inbound);

        config.routing.rules.push({
            type: 'field',
            inboundTag: [connectorTag],
            domain: [`full:${link.tunnelDomain || 'reverse.tunnel.internal'}`],
            outboundTag: portalTag,
        });

        // Geo routing only takes effect when at least one tag is set;
        // otherwise fall back to default so client traffic still gets a route.
        const hasGeoTags = link.geoRouting?.enabled &&
            ((link.geoRouting.domains?.length > 0) || (link.geoRouting.geoip?.length > 0));
        if (hasGeoTags) {
            geoLinks.push({ link, portalTag });
        } else {
            defaultLinks.push({ link, portalTag });
        }
    }

    if (tags.length === 0) return;

    // Geo-specific routing rules (checked first — order matters in Xray)
    for (const { link, portalTag } of geoLinks) {
        if (link.geoRouting.domains?.length > 0) {
            config.routing.rules.push({
                type: 'field',
                inboundTag: tags,
                domain: link.geoRouting.domains.map(d =>
                    d.includes(':') ? d : `geosite:${d}`
                ),
                outboundTag: portalTag,
            });
        }
        if (link.geoRouting.geoip?.length > 0) {
            config.routing.rules.push({
                type: 'field',
                inboundTag: tags,
                ip: link.geoRouting.geoip.map(g =>
                    g.includes(':') ? g : `geoip:${g}`
                ),
                outboundTag: portalTag,
            });
        }
    }

    // Default (non-geo) links: use balancer when multiple, direct tag when single
    const defaultTags = defaultLinks.map(d => d.portalTag);
    if (defaultTags.length > 1) {
        config.routing.balancers = config.routing.balancers || [];
        config.routing.balancers.push({
            tag: 'cascade-balancer',
            selector: defaultTags,
            strategy: { type: 'random' },
            fallbackTag: 'direct',
        });
        config.routing.rules.push({
            type: 'field',
            inboundTag: tags,
            balancerTag: 'cascade-balancer',
        });
    } else if (defaultTags.length === 1) {
        config.routing.rules.push({
            type: 'field',
            inboundTag: tags,
            outboundTag: defaultTags[0],
        });
    }
}

/**
 * Normalize a single tag string or array of tags into a deduplicated array of
 * non-empty strings. Used by cascade entry points so callers can pass either
 * the legacy single tag or the new multi-tag array (main + extras).
 */
function normalizeInboundTags(input) {
    if (!input) return [];
    const arr = Array.isArray(input) ? input : [input];
    const seen = new Set();
    const out = [];
    for (const t of arr) {
        if (typeof t !== 'string') continue;
        const trimmed = t.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

/**
 * Generate a standalone Xray JSON config for a Bridge (exit) node.
 * The Bridge initiates a reverse tunnel to the Portal node and releases traffic
 * to the internet via a freedom outbound.
 *
 * @param {Object} link - CascadeLink document
 * @param {Object} portalNode - HyNode document of the portal node
 * @returns {string} JSON string ready to write to config.json
 */
function generateBridgeConfig(link, portalNode) {
    const tunnelDomain = link.tunnelDomain || 'reverse.tunnel.internal';
    const protocol = link.tunnelProtocol || 'vless';
    const linkIdShort = String(link._id).slice(-8);

    const tunnelOutbound = {
        tag: 'tunnel',
        protocol,
        settings: {
            vnext: [{
                address: portalNode.ip,
                port: link.tunnelPort || 10086,
                users: [buildOutboundUser(link.tunnelUuid, protocol)],
            }],
        },
        streamSettings: buildCascadeTunnelStreamSettings(link),
    };
    if (link.muxEnabled) {
        tunnelOutbound.mux = { enabled: true, concurrency: link.muxConcurrency || 8 };
    }

    const config = {
        log: {
            loglevel: 'warning',
        },
        reverse: {
            bridges: [{
                tag: 'bridge',
                domain: tunnelDomain,
            }],
        },
        outbounds: [
            tunnelOutbound,
            {
                tag: 'freedom',
                protocol: 'freedom',
                settings: { domainStrategy: 'UseIPv4' },
            },
            {
                tag: 'blackhole',
                protocol: 'blackhole',
            },
        ],
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: [
                {
                    type: 'field',
                    domain: [`full:${tunnelDomain}`],
                    outboundTag: 'tunnel',
                },
                {
                    type: 'field',
                    inboundTag: ['bridge'],
                    outboundTag: 'freedom',
                },
                {
                    type: 'field',
                    ip: ['geoip:private'],
                    outboundTag: 'blackhole',
                },
            ],
        },
    };

    return JSON.stringify(config, null, 2);
}

/**
 * Generate Xray JSON config for a Relay (intermediate hop) node.
 * The Relay connects upstream to a Portal AND accepts downstream connections from Bridges,
 * forwarding traffic through the chain instead of releasing to internet.
 *
 * @param {Object} upstreamLink - CascadeLink where this node is bridgeNode (connects TO portal)
 * @param {Object} upstreamPortal - HyNode of the upstream portal
 * @param {Array} downstreamLinks - CascadeLinks where this node is portalNode (accepts FROM bridges)
 * @returns {string} JSON string ready to write to config.json
 */
function generateRelayConfig(upstreamLink, upstreamPortal, downstreamLinks) {
    const upDomain = upstreamLink.tunnelDomain || 'reverse.tunnel.internal';
    const upProtocol = upstreamLink.tunnelProtocol || 'vless';
    const upLinkId = String(upstreamLink._id).slice(-8);

    const tunnelUpOutbound = {
        tag: 'tunnel-up',
        protocol: upProtocol,
        settings: {
            vnext: [{
                address: upstreamPortal.ip,
                port: upstreamLink.tunnelPort || 10086,
                users: [buildOutboundUser(upstreamLink.tunnelUuid, upProtocol)],
            }],
        },
        streamSettings: buildCascadeTunnelStreamSettings(upstreamLink),
    };
    if (upstreamLink.muxEnabled) {
        tunnelUpOutbound.mux = { enabled: true, concurrency: upstreamLink.muxConcurrency || 8 };
    }

    const config = {
        log: { loglevel: 'warning' },
        reverse: {
            bridges: [{
                tag: 'bridge-up',
                domain: upDomain,
            }],
            portals: [],
        },
        inbounds: [],
        outbounds: [
            tunnelUpOutbound,
            {
                tag: 'blackhole',
                protocol: 'blackhole',
            },
        ],
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: [], // Rules will be added in correct order below
        },
    };

    // FIRST: Add connector rules for each downstream link (must be checked BEFORE tunnel-up rule)
    for (const downLink of downstreamLinks) {
        const downLinkId = String(downLink._id).slice(-8);
        const downDomain = downLink.tunnelDomain || 'reverse.tunnel.internal';
        const downProtocol = downLink.tunnelProtocol || 'vless';
        const portalTag = `portal-down-${downLinkId}`;
        const connectorTag = `conn-down-${downLinkId}`;

        config.reverse.portals.push({
            tag: portalTag,
            domain: downDomain,
        });

        const downSettings = { clients: [{ id: downLink.tunnelUuid }] };
        if (downProtocol === 'vless') downSettings.decryption = 'none';

        config.inbounds.push({
            tag: connectorTag,
            listen: '0.0.0.0',
            port: downLink.tunnelPort || 10086,
            protocol: downProtocol,
            settings: downSettings,
            streamSettings: buildCascadeTunnelStreamSettings(downLink, { server: true }),
        });

        // Rule: connector + domain → portal (handshake)
        config.routing.rules.push({
            type: 'field',
            inboundTag: [connectorTag],
            domain: [`full:${downDomain}`],
            outboundTag: portalTag,
        });
    }

    // SECOND: Add tunnel-up rule for upstream bridge handshake (after connector rules)
    config.routing.rules.push({
        type: 'field',
        domain: [`full:${upDomain}`],
        outboundTag: 'tunnel-up',
    });

    // THIRD: Route traffic from upstream bridge to downstream portal(s)
    if (downstreamLinks.length > 1) {
        const downTags = downstreamLinks.map(l => `portal-down-${String(l._id).slice(-8)}`);
        config.routing.balancers = config.routing.balancers || [];
        config.routing.balancers.push({
            tag: 'down-balancer',
            selector: downTags,
            strategy: { type: 'random' },
        });
        config.routing.rules.push({
            type: 'field',
            inboundTag: ['bridge-up'],
            balancerTag: 'down-balancer',
        });
    } else if (downstreamLinks.length === 1) {
        const firstPortalTag = `portal-down-${String(downstreamLinks[0]._id).slice(-8)}`;
        config.routing.rules.push({
            type: 'field',
            inboundTag: ['bridge-up'],
            outboundTag: firstPortalTag,
        });
    }

    // LAST: Blackhole for private IPs
    config.routing.rules.push({
        type: 'field',
        ip: ['geoip:private'],
        outboundTag: 'blackhole',
    });

    return JSON.stringify(config, null, 2);
}

/**
 * Build streamSettings for the cascade tunnel connection between Portal and Bridge.
 * Supports tcp/ws/grpc/xhttp transports and none/tls/reality security.
 * Note: Xray-core 25.x+ renamed splithttp to xhttp; old DB rows storing
 * 'splithttp' are normalized to 'xhttp' here for forward compatibility.
 *
 * @param {Object} link - CascadeLink document
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.server] - true to build server-side (inbound) settings
 * @returns {Object} streamSettings
 */
function buildCascadeTunnelStreamSettings(link, opts = {}) {
    const rawTransport = link.tunnelTransport || 'tcp';
    const transport = rawTransport === 'splithttp' ? 'xhttp' : rawTransport;
    const security = link.tunnelSecurity || 'none';
    const realityServerNames = link.realitySni?.length ? link.realitySni : ['www.google.com'];
    const realityServerName = realityServerNames[0] || 'www.google.com';

    const stream = {
        network: transport,
        security: security === 'reality' ? 'reality' : security,
    };

    if (security === 'tls') {
        // Inline panel cert when tlsServerName matches PANEL_DOMAIN; otherwise
        // fall back to file paths and keep allowInsecure on the client side.
        const panelDomain = (appConfig?.PANEL_DOMAIN || '').trim();
        const wantPanelCert = !!panelDomain && link.tlsServerName === panelDomain;

        if (opts.server) {
            let certificates;
            if (wantPanelCert) {
                const panelCert = buildPanelInlineCertificate();
                if (panelCert) {
                    certificates = [{
                        ocspStapling: 3600,
                        certificate: panelCert.certificate,
                        key: panelCert.key,
                    }];
                } else {
                    const err = new Error(`PANEL_CERT_UNAVAILABLE: cascade link "${link?.name || link?._id}" expects panel cert for ${panelDomain} but it is not readable on disk`);
                    err.code = 'PANEL_CERT_UNAVAILABLE';
                    throw err;
                }
            } else {
                logger.warn(`[configGenerator] Cascade TLS link "${link?.name || link?._id}" uses tlsServerName="${link.tlsServerName || ''}" — using file paths; ensure cert/key exist on the bridge node`);
                certificates = [{
                    certificateFile: '/usr/local/etc/xray/cert.pem',
                    keyFile: '/usr/local/etc/xray/key.pem',
                }];
            }
            stream.tlsSettings = {
                serverName: link.tlsServerName || panelDomain || '',
                minVersion: '1.2',
                certificates,
            };
        } else {
            stream.tlsSettings = {};
            if (link.tlsServerName) stream.tlsSettings.serverName = link.tlsServerName;
            if (!wantPanelCert) stream.tlsSettings.allowInsecure = true;
        }
    } else if (security === 'reality') {
        if (opts.server) {
            stream.realitySettings = {
                dest: link.realityDest || 'www.google.com:443',
                serverNames: realityServerNames,
                privateKey: link.realityPrivateKey || '',
                shortIds: link.realityShortIds?.length ? link.realityShortIds : [''],
            };
        } else {
            stream.realitySettings = {
                serverName: realityServerName,
                fingerprint: link.realityFingerprint || 'chrome',
                publicKey: link.realityPublicKey || '',
                shortId: (link.realityShortIds || []).find(id => id && id.length > 0) ||
                    ((link.realityShortIds && link.realityShortIds[0]) || ''),
            };
        }
    }

    if (transport === 'tcp') {
        stream.sockopt = {
            tcpFastOpen: link.tcpFastOpen !== false,
            tcpKeepAliveIdle: link.tcpKeepAlive || 100,
            tcpNoDelay: link.tcpNoDelay !== false,
        };
    } else if (transport === 'ws') {
        stream.wsSettings = {
            path: link.wsPath || '/cascade',
            headers: link.wsHost ? { Host: link.wsHost } : {},
        };
    } else if (transport === 'grpc') {
        stream.grpcSettings = {
            serviceName: link.grpcServiceName || 'cascade',
        };
    } else if (transport === 'xhttp') {
        stream.xhttpSettings = {
            path: link.xhttpPath || '/cascade',
            host: link.xhttpHost || '',
            mode: link.xhttpMode || 'auto',
        };
    }

    return stream;
}

// ==================== XRAY CASCADE (Forward Chain — proxySettings.tag) ====================

/**
 * Apply forward-chain outbounds to an existing Xray config object.
 *
 * Xray proxySettings semantics: if outbound A has proxySettings.tag = "B",
 * then A uses B as transport proxy — connect to B first, then through B
 * connect to A's destination. So for chain Portal -> Relay -> Bridge:
 *   - "to-bridge" (dest=bridge_ip, proxySettings.tag="to-relay")
 *   - "to-relay"  (dest=relay_ip, no proxySettings — direct connection)
 *   - Routing: client traffic -> "to-bridge" (the exit node outbound)
 *   - Flow: Portal -> Relay -> Bridge -> Internet
 *
 * Links must be passed in hop order, from the nearest downstream node to the
 * final exit node. The LAST outbound (exit/bridge) is the routing entry point.
 * Each outbound (except the first/nearest) has proxySettings.tag pointing to
 * the previous outbound (one hop closer to client).
 *
 * Forward chain is always a sequential chain, NOT parallel alternatives —
 * no balancer is used. For parallel exit paths, create separate chains.
 *
 * @param {Object} config - Parsed Xray config object (mutated in place)
 * @param {Array} forwardLinks - Ordered CascadeLink documents for the full
 *                               downstream path starting from this node.
 *                               Must have bridgeNode populated.
 * @param {string|string[]} clientInboundTags - Tag(s) of the client-facing inbound(s).
 *        See applyReversePortal for the same multi-tag semantics.
 */
function applyForwardChain(config, forwardLinks, clientInboundTags) {
    if (!forwardLinks || forwardLinks.length === 0) return;
    const tags = normalizeInboundTags(clientInboundTags);

    config.outbounds = config.outbounds || [];
    config.routing = config.routing || { rules: [] };
    config.routing.rules = config.routing.rules || [];

    // Caller provides the full downstream path in hop order:
    // relay1, relay2, ..., exit-bridge.
    const sorted = [...forwardLinks];

    const outboundTags = [];
    for (let i = 0; i < sorted.length; i++) {
        const link = sorted[i];
        const bridgeNode = link.bridgeNode;
        const tag = `fwd-${String(link._id).slice(-8)}`;
        outboundTags.push(tag);

        const fwdProto = link.tunnelProtocol || 'vless';
        const outbound = {
            tag,
            protocol: fwdProto,
            settings: {
                vnext: [{
                    address: bridgeNode.ip || bridgeNode.domain || '',
                    port: link.tunnelPort || 10086,
                    users: [buildOutboundUser(link.tunnelUuid, fwdProto)],
                }],
            },
            streamSettings: buildCascadeTunnelStreamSettings(link),
        };

        if (link.muxEnabled) {
            outbound.mux = { enabled: true, concurrency: link.muxConcurrency || 8 };
        }

        // Each outbound (except the first/nearest) uses the previous one as a
        // transport-layer proxy. This is required for chained REALITY hops:
        // plain proxySettings.tag path in Xray's outbound handler only wraps
        // TLS, while transportLayer=true maps to sockopt.dialerProxy and lets
        // the current outbound apply its own stream security (including REALITY).
        if (i > 0) {
            outbound.proxySettings = { tag: outboundTags[i - 1], transportLayer: true };
        }

        config.outbounds.push(outbound);
    }

    if (tags.length === 0) return;

    // Routing entry point is the LAST outbound (exit/bridge node).
    // Traffic flows: client -> exit outbound -> (via proxySettings chain) -> internet
    const exitTag = outboundTags[outboundTags.length - 1];

    // Geo-specific routing for individual links in the chain
    // (only the exit link's geo-routing makes sense for a sequential chain)
    const exitLink = sorted[sorted.length - 1];
    const hasGeoTags = exitLink.geoRouting?.enabled &&
        ((exitLink.geoRouting.domains?.length > 0) || (exitLink.geoRouting.geoip?.length > 0));
    if (hasGeoTags) {
        if (exitLink.geoRouting.domains?.length > 0) {
            config.routing.rules.push({
                type: 'field',
                inboundTag: tags,
                domain: exitLink.geoRouting.domains.map(d =>
                    d.includes(':') ? d : `geosite:${d}`
                ),
                outboundTag: exitTag,
            });
        }
        if (exitLink.geoRouting.geoip?.length > 0) {
            config.routing.rules.push({
                type: 'field',
                inboundTag: tags,
                ip: exitLink.geoRouting.geoip.map(g =>
                    g.includes(':') ? g : `geoip:${g}`
                ),
                outboundTag: exitTag,
            });
        }
    } else {
        // Default: route all client traffic through the forward chain
        config.routing.rules.push({
            type: 'field',
            inboundTag: tags,
            outboundTag: exitTag,
        });
    }
}

/**
 * Generate a standalone Xray JSON config for a forward-chain hop node.
 * Accepts one or more links (for nodes that are bridge for multiple forward links).
 *
 * @param {Object|Array} linkOrLinks - CascadeLink document(s) (this node is bridgeNode)
 * @returns {string} JSON string ready to write to config.json
 */
function generateForwardHopConfig(linkOrLinks) {
    const links = Array.isArray(linkOrLinks) ? linkOrLinks : [linkOrLinks];

    const inbounds = links.map((link, idx) => {
        const hopProto = link.tunnelProtocol || 'vless';
        const hopSettings = { clients: [{ id: link.tunnelUuid }] };
        if (hopProto === 'vless') hopSettings.decryption = 'none';
        const linkIdShort = String(link._id).slice(-8);

        return {
            tag: `cascade-in-${linkIdShort}`,
            listen: '0.0.0.0',
            port: link.tunnelPort || 10086,
            protocol: hopProto,
            settings: hopSettings,
            streamSettings: buildCascadeTunnelStreamSettings(link, { server: true }),
            sniffing: {
                enabled: true,
                destOverride: ['http', 'tls', 'quic'],
                routeOnly: true,
            },
        };
    });

    const config = {
        log: { loglevel: 'warning' },
        inbounds,
        outbounds: [
            { tag: 'freedom', protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' } },
            { tag: 'blackhole', protocol: 'blackhole' },
        ],
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: [
                ...inbounds.map(ib => ({
                    type: 'field', inboundTag: [ib.tag], outboundTag: 'freedom',
                })),
                { type: 'field', ip: ['geoip:private'], outboundTag: 'blackhole' },
            ],
        },
    };

    return JSON.stringify(config, null, 2);
}

/**
 * Apply a forward-chain hop inbound to an existing Xray config.
 * Used when the hop node is also a standalone Xray server (has its own
 * client-facing inbound) and needs a cascade inbound added to its config.
 *
 * @param {Object} config - Parsed Xray config object (mutated in place)
 * @param {Array} hopLinks - CascadeLink documents where this node is bridgeNode (forward mode)
 */
function applyForwardHopInbound(config, hopLinks) {
    if (!hopLinks || hopLinks.length === 0) return;

    config.inbounds = config.inbounds || [];
    config.routing = config.routing || { rules: [] };
    config.routing.rules = config.routing.rules || [];

    for (const link of hopLinks) {
        const linkIdShort = String(link._id).slice(-8);
        const inboundTag = `fwd-hop-${linkIdShort}`;
        const hopProto = link.tunnelProtocol || 'vless';
        const hopSettings = { clients: [{ id: link.tunnelUuid }] };
        if (hopProto === 'vless') hopSettings.decryption = 'none';

        config.inbounds.push({
            tag: inboundTag,
            listen: '0.0.0.0',
            port: link.tunnelPort || 10086,
            protocol: hopProto,
            settings: hopSettings,
            streamSettings: buildCascadeTunnelStreamSettings(link, { server: true }),
            sniffing: {
                enabled: true,
                destOverride: ['http', 'tls', 'quic'],
                routeOnly: true,
            },
        });

        // proxySettings.tag builds the full chained path on the entry node.
        // Intermediate hops act as transport proxies and should forward the
        // decoded stream directly to the next target address.
        config.routing.rules.push({
            type: 'field',
            inboundTag: [inboundTag],
            outboundTag: 'direct',
        });
    }
}

/**
 * Generate systemd service unit for a bridge Xray instance.
 * Uses a separate config path to avoid conflicts with a standalone Xray install.
 */
/**
 * Ensure the geoip:private block rule is the LAST routing rule.
 * Must be called after all cascade rules (applyReversePortal, applyForwardChain,
 * applyForwardHopInbound) have been applied, so tunnel traffic to LAN IPs
 * is not blocked prematurely.
 *
 * @param {Object} config - Parsed Xray config object (mutated in place)
 */
function ensurePrivateIpBlock(config) {
    if (!config.routing) config.routing = { rules: [] };
    if (!config.routing.rules) config.routing.rules = [];

    config.routing.rules = config.routing.rules.filter(r =>
        !(r.type === 'field' && r.ip && r.ip.length === 1 && r.ip[0] === 'geoip:private')
    );

    const privateRule = {
        type: 'field',
        ip: ['geoip:private'],
        outboundTag: config.outbounds?.some(o => o.tag === 'block') ? 'block' : 'blackhole',
    };

    // Catch-all ACL rules (no ip/domain/inboundTag/protocol filters) must run
    // AFTER the private-network block, otherwise LAN traffic would leak
    // through a user-defined proxy like `ukr(all)` (issue #75).
    const isCatchAll = (r) => r && r.type === 'field' && (
        r.ruleTag === 'acl-catch-all'
        || (!r.ip && !r.domain && !r.inboundTag && !r.protocol
            && !r.port && !r.network && !r.source)
    );

    const tail = [];
    const head = [];
    for (const r of config.routing.rules) {
        if (isCatchAll(r)) tail.push(r);
        else head.push(r);
    }

    config.routing.rules = [...head, privateRule, ...tail];
}

function generateBridgeSystemdService() {
    return `[Unit]
Description=Xray Bridge (Cascade Tunnel)
After=network.target nss-lookup.target

[Service]
User=nobody
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Type=simple
ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray-bridge/config.json
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`;
}

module.exports = {
    generateNodeConfig,
    generateNodeConfigACME,
    generateSystemdService,
    applyOutboundsAndAcl,
    generateXrayConfig,
    buildXrayLogSection,
    XRAY_ACCESS_LOG_PATH,
    buildXrayStreamSettings,
    generateXraySystemdService,
    applyReversePortal,
    generateBridgeConfig,
    generateRelayConfig,
    buildCascadeTunnelStreamSettings,
    generateBridgeSystemdService,
    applyForwardChain,
    generateForwardHopConfig,
    applyForwardHopInbound,
    ensurePrivateIpBlock,
    parsePemBlock,
    buildPanelInlineCertificate,
    invalidatePanelCertCache,
};
