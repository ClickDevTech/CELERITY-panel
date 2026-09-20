'use strict';

// Caddyfile for the front: a decoy site on `/`, the fronted inbounds proxied
// by path to loopback. Pure string building; the provisioner ships the result.

const appConfig = require('../../../config');
const {
    buildFrontRoutes,
    frontPublicHost,
    XRAY_FRONT_ALPN,
} = require('../../utils/xrayFront');

const CADDY_BIN = '/usr/bin/caddy';
const CADDYFILE_PATH = '/etc/caddy/Caddyfile';
const CADDY_TLS_DIR = '/etc/caddy/tls';
const CADDY_CERT_PATH = `${CADDY_TLS_DIR}/cert.pem`;
const CADDY_KEY_PATH = `${CADDY_TLS_DIR}/key.pem`;
const SITE_ROOT = '/var/lib/celerity-front/site';
const FRONT_SMOKE_HEADER = 'X-Celerity-Front-Smoke';
const FRONT_SMOKE_VALUE = 'route';

// Quoting is not enough: Caddy placeholders and quotes break out of a token.
const UNSAFE_TOKEN_RE = /["'{}\\\s]/;

function assertSafeToken(value, what) {
    const token = String(value ?? '');
    if (!token || UNSAFE_TOKEN_RE.test(token)) {
        const err = new Error(`FRONT_CONFIG_INVALID: unsupported characters in ${what}: "${token}"`);
        err.code = 'FRONT_CONFIG_INVALID';
        throw err;
    }
    return token;
}

function frontSiteHost(node) {
    return frontPublicHost(node);
}

function resolveAcmeEmail(node) {
    return String(node?.xray?.acmeEmail || '').trim()
        || String(appConfig?.ACME_EMAIL || '').trim();
}

function buildTlsDirective(node, {
    certPath = CADDY_CERT_PATH,
    keyPath = CADDY_KEY_PATH,
} = {}) {
    const tlsSource = node?.xray?.tlsSource || 'panel';
    // Both, so each transport can negotiate the version it needs. Clients are
    // told which one to offer (see frontClientAlpn).
    const alpnLine = `\t\talpn ${XRAY_FRONT_ALPN.map(v => `"${v}"`).join(' ')}`;
    // acme lets Caddy manage the certificate; panel and manual ship PEM files.
    const head = tlsSource === 'acme'
        ? 'tls {'
        : `tls ${certPath} ${keyPath} {`;
    return [`\t${head}`, alpnLine, '\t}'].join('\n');
}

function buildRouteBlock(route, index) {
    const matcher = `@front${index}`;
    const smokeMatcher = `@front${index}Smoke`;
    const paths = route.paths.map(p => `"${assertSafeToken(p, 'inbound path')}"`).join(' ');
    const upstream = route.h2c ? `h2c://${route.upstream}` : route.upstream;
    const upstreamHost = route.upstreamHost
        ? assertSafeToken(route.upstreamHost, 'upstream host')
        : '';
    const lines = [
        `\t${matcher} path ${paths}`,
        `\t${smokeMatcher} {`,
        '\t\tremote_ip 127.0.0.1',
        `\t\theader ${FRONT_SMOKE_HEADER} ${FRONT_SMOKE_VALUE}`,
        '\t}',
        `\thandle ${matcher} {`,
        `\t\trespond ${smokeMatcher} 204`,
    ];
    if (route.transport === 'grpc') {
        // Xray's gRPC inbound reads the client IP from X-Real-IP; ws and xhttp
        // take it from the X-Forwarded-For Caddy sets on its own.
        lines.push(`\t\treverse_proxy ${upstream} {`);
        lines.push('\t\t\theader_up X-Real-IP {remote_host}');
        lines.push('\t\t}');
    } else if (upstreamHost) {
        lines.push(`\t\treverse_proxy ${upstream} {`);
        lines.push(`\t\t\theader_up Host ${upstreamHost}`);
        lines.push('\t\t}');
    } else {
        lines.push(`\t\treverse_proxy ${upstream}`);
    }
    lines.push('\t}');
    return lines.join('\n');
}

// Throws FRONT_CONFIG_INVALID when the front is not renderable.
function buildCaddyfile(node, {
    certPath = CADDY_CERT_PATH,
    keyPath = CADDY_KEY_PATH,
    siteRoot = SITE_ROOT,
} = {}) {
    const xray = node?.xray || {};
    const front = xray.front || {};
    if (!front.enabled) {
        const err = new Error('FRONT_CONFIG_INVALID: front is not enabled');
        err.code = 'FRONT_CONFIG_INVALID';
        throw err;
    }

    const host = assertSafeToken(frontSiteHost(node), 'front domain');
    const port = front.publicPort || 443;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        const err = new Error(`FRONT_CONFIG_INVALID: bad public port ${port}`);
        err.code = 'FRONT_CONFIG_INVALID';
        throw err;
    }

    const routes = buildFrontRoutes(xray, node?.port);
    if (routes.length === 0) {
        const err = new Error('FRONT_CONFIG_INVALID: no frontable inbound selected');
        err.code = 'FRONT_CONFIG_INVALID';
        throw err;
    }
    // A route on the site root would leave no decoy to serve.
    if (routes.some(route => route.paths.includes('/*'))) {
        const err = new Error('FRONT_CONFIG_INVALID: a fronted inbound uses the site root');
        err.code = 'FRONT_CONFIG_INVALID';
        throw err;
    }

    const global = ['{', '\tadmin off'];
    if ((xray.tlsSource || 'panel') === 'acme') {
        const email = resolveAcmeEmail(node);
        if (!email) {
            const err = new Error('FRONT_CONFIG_INVALID: acme TLS needs an email');
            err.code = 'FRONT_CONFIG_INVALID';
            throw err;
        }
        global.push(`\temail ${assertSafeToken(email, 'ACME email')}`);
    }
    // No h3: UDP/443 stays free for Hysteria, so it must not be advertised.
    global.push('\tservers {', '\t\tprotocols h1 h2', '\t}', '}');

    const body = [
        `https://${host}:${port} {`,
        buildTlsDirective(node, { certPath, keyPath }),
        '',
        ...routes.flatMap((route, index) => [buildRouteBlock(route, index), '']),
        // Everything else is the decoy site.
        '\thandle {',
        `\t\troot * ${siteRoot}`,
        '\t\tfile_server',
        '\t}',
        '}',
    ];

    return `${global.join('\n')}\n\n${body.join('\n')}\n`;
}

module.exports = {
    CADDY_BIN,
    CADDYFILE_PATH,
    CADDY_TLS_DIR,
    CADDY_CERT_PATH,
    CADDY_KEY_PATH,
    SITE_ROOT,
    FRONT_SMOKE_HEADER,
    FRONT_SMOKE_VALUE,
    frontSiteHost,
    resolveAcmeEmail,
    buildCaddyfile,
};
