const TRANSPORTS = {
    tcp: { short: 'TCP', long: 'TCP' },
    ws: { short: 'WS', long: 'WebSocket' },
    grpc: { short: 'gRPC', long: 'gRPC' },
    xhttp: { short: 'XHTTP', long: 'XHTTP' },
};

function text(value) {
    return String(value || '').trim();
}

function label(labels, key, fallback) {
    const value = labels && labels[key];
    return text(value) || fallback;
}

function unique(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const normalized = text(value).toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function formatCodes(codes, defs) {
    if (codes.length === 0) return { label: '', title: '' };
    const parts = codes.map(code => defs[code]?.short || code.toUpperCase());
    const titleParts = codes.map(code => defs[code]?.long || defs[code]?.short || code.toUpperCase());
    return {
        label: parts.length <= 2 ? parts.join('/') : `${parts[0]} +${parts.length - 1}`,
        title: titleParts.join(', '),
    };
}

function badge(kind, icon, value, titlePrefix, tone, detail = '') {
    const title = detail ? `${titlePrefix}: ${value} (${detail})` : `${titlePrefix}: ${value}`;
    return {
        kind,
        icon,
        label: value,
        title,
        className: `node-meta-badge node-meta-${kind} node-meta-${tone}`,
    };
}

function collectXrayInbounds(xray) {
    const inbounds = [xray || {}];
    if (Array.isArray(xray?.extraInbounds)) {
        for (const inbound of xray.extraInbounds) {
            if (inbound) inbounds.push(inbound);
        }
    }
    return inbounds;
}

function buildCertificateBadge(source, node, options, title) {
    const labels = options.labels || {};
    const panelDomain = text(options.panelDomain);
    const nodeDomain = text(node?.domain);
    const sourceLabels = {
        panel: label(labels, 'certPanel', 'Panel'),
        acme: label(labels, 'certAcme', 'ACME'),
        manual: label(labels, 'certManual', 'PEM'),
        'self-signed': label(labels, 'certSelfSigned', 'Self-signed'),
        files: label(labels, 'certFiles', 'Files'),
    };

    const normalized = sourceLabels[source] ? source : 'panel';
    const detail = normalized === 'panel'
        ? panelDomain
        : (normalized === 'acme' || normalized === 'manual' ? nodeDomain : '');

    return badge('certificate', 'ti ti-certificate', sourceLabels[normalized], title, normalized, detail);
}

function buildXrayMeta(node, options) {
    const labels = options.labels || {};
    const xray = node?.xray || {};
    const inbounds = collectXrayInbounds(xray);
    const transports = unique(inbounds.map(inbound => inbound.transport || 'tcp'));
    const securities = unique(inbounds.map(inbound => inbound.security || 'reality'));
    const hasTls = securities.includes('tls');
    const tlsSource = text(xray.tlsSource) || 'panel';
    const displayDomain = hasTls && (tlsSource === 'acme' || tlsSource === 'manual')
        ? text(node?.domain)
        : '';

    const securityDefs = {
        reality: { short: 'REALITY', long: 'REALITY' },
        tls: { short: 'TLS', long: 'TLS' },
        none: {
            short: label(labels, 'securityNone', 'No TLS'),
            long: label(labels, 'securityNone', 'No TLS'),
        },
    };

    const transport = formatCodes(transports, TRANSPORTS);
    const security = formatCodes(securities, securityDefs);
    const badges = [];
    if (transport.label) {
        badges.push(badge(
            'transport',
            'ti ti-route',
            transport.label,
            label(labels, 'transportTitle', 'Transport'),
            'transport',
            transport.title
        ));
    }
    if (security.label) {
        const tone = securities.includes('reality') ? 'reality' : (securities.includes('tls') ? 'tls' : 'none');
        badges.push(badge(
            'security',
            'ti ti-shield-lock',
            security.label,
            label(labels, 'securityTitle', 'Security'),
            tone,
            security.title
        ));
    }
    if (hasTls) {
        badges.push(buildCertificateBadge(tlsSource, node, options, label(labels, 'certificateTitle', 'Certificate')));
    }

    return { displayDomain, badges };
}

function buildHysteriaMeta(node, options) {
    const labels = options.labels || {};
    const nodeDomain = text(node?.domain);
    const certSource = nodeDomain && !node?.useTlsFiles
        ? 'acme'
        : (node?.useTlsFiles ? 'files' : 'self-signed');

    return {
        displayDomain: nodeDomain,
        badges: [
            badge(
                'transport',
                'ti ti-route',
                'QUIC',
                label(labels, 'transportTitle', 'Transport'),
                'transport',
                'QUIC'
            ),
            badge(
                'security',
                'ti ti-shield-lock',
                'TLS',
                label(labels, 'securityTitle', 'Security'),
                'tls',
                'TLS'
            ),
            buildCertificateBadge(certSource, node, options, label(labels, 'certificateTitle', 'Certificate')),
        ],
    };
}

function buildVirtualMeta(options) {
    const labels = options.labels || {};
    return {
        displayDomain: '',
        badges: [
            badge(
                'transport',
                'ti ti-route',
                label(labels, 'virtualTransport', 'Virtual'),
                label(labels, 'transportTitle', 'Transport'),
                'virtual'
            ),
        ],
    };
}

function buildCdnMeta(node, options) {
    const labels = options.labels || {};
    return {
        displayDomain: text(node?.cdn?.domain),
        badges: [
            badge(
                'transport',
                'ti ti-cloud-network',
                'CDN',
                label(labels, 'transportTitle', 'Transport'),
                'cdn'
            ),
            badge(
                'security',
                'ti ti-shield-lock',
                String(node?.cdn?.security || 'tls').toUpperCase(),
                label(labels, 'securityTitle', 'Security'),
                node?.cdn?.security || 'tls'
            ),
        ],
    };
}

function buildNodeUiMeta(node, options = {}) {
    if (!node) return { displayDomain: '', badges: [] };
    if (node.type === 'virtual') return buildVirtualMeta(options);
    if (node.type === 'cdn') return buildCdnMeta(node, options);
    if (node.type === 'xray') return buildXrayMeta(node, options);
    return buildHysteriaMeta(node, options);
}

module.exports = {
    buildNodeUiMeta,
};
