const assert = require('assert');

const {
    buildNodeUiMeta,
} = require('../src/utils/nodeUi');

const labels = {
    certPanel: 'Panel',
    certAcme: 'ACME',
    certManual: 'PEM',
    certSelfSigned: 'Self-signed',
    certFiles: 'Files',
    securityNone: 'No TLS',
    transportTitle: 'Transport',
    securityTitle: 'Security',
    certificateTitle: 'Certificate',
    virtualTransport: 'Virtual',
};

function meta(node) {
    return buildNodeUiMeta(node, {
        panelDomain: 'panel.example.com',
        labels,
    });
}

{
    const result = meta({
        type: 'xray',
        domain: 'old-node.example.com',
        xray: {
            transport: 'tcp',
            security: 'tls',
            tlsSource: 'panel',
        },
    });

    assert.strictEqual(
        result.displayDomain,
        '',
        'Xray panel-domain TLS must not display a stale node domain'
    );
    assert(result.badges.some(badge => badge.kind === 'certificate' && badge.label === 'Panel'));
    assert(result.badges.some(badge => badge.kind === 'transport' && badge.label === 'TCP'));
    assert(result.badges.some(badge => badge.kind === 'security' && badge.label === 'TLS'));
}

{
    const result = meta({
        type: 'xray',
        domain: 'node.example.com',
        xray: {
            transport: 'grpc',
            security: 'tls',
            tlsSource: 'acme',
        },
    });

    assert.strictEqual(
        result.displayDomain,
        'node.example.com',
        'Xray ACME TLS should still display the active node domain'
    );
    assert(result.badges.some(badge => badge.kind === 'certificate' && badge.label === 'ACME'));
    assert(result.badges.some(badge => badge.kind === 'transport' && badge.label === 'gRPC'));
}

{
    const result = meta({
        type: 'xray',
        domain: 'unused.example.com',
        xray: {
            transport: 'tcp',
            security: 'reality',
            tlsSource: 'panel',
        },
    });

    assert.strictEqual(
        result.displayDomain,
        '',
        'Xray REALITY should not display a leftover certificate domain'
    );
    assert(result.badges.some(badge => badge.kind === 'security' && badge.label === 'REALITY'));
    assert(!result.badges.some(badge => badge.kind === 'certificate'));
}

{
    const result = meta({
        type: 'xray',
        domain: 'stale.example.com',
        xray: {
            transport: 'tcp',
            security: 'reality',
            tlsSource: 'panel',
            extraInbounds: [
                { transport: 'ws', security: 'tls' },
                { transport: 'grpc', security: 'tls' },
            ],
        },
    });

    assert.strictEqual(result.displayDomain, '');
    assert(result.badges.some(badge => badge.kind === 'transport' && badge.label === 'TCP +2'));
    assert(result.badges.some(badge => badge.kind === 'security' && badge.label === 'REALITY/TLS'));
    assert(result.badges.some(badge => badge.kind === 'certificate' && badge.label === 'Panel'));
}

{
    const result = meta({
        type: 'hysteria',
        domain: 'hy.example.com',
        useTlsFiles: false,
    });

    assert.strictEqual(result.displayDomain, 'hy.example.com');
    assert(result.badges.some(badge => badge.kind === 'transport' && badge.label === 'QUIC'));
    assert(result.badges.some(badge => badge.kind === 'certificate' && badge.label === 'ACME'));
}

{
    const result = meta({
        type: 'cdn',
        cdn: {
            domain: 'cdn.example.com',
            security: 'tls',
        },
    });
    assert.strictEqual(result.displayDomain, 'cdn.example.com');
    assert(result.badges.some(badge => badge.kind === 'transport' && badge.label === 'CDN'));
    assert(result.badges.some(badge => badge.kind === 'security' && badge.label === 'TLS'));
}

console.log('node UI metadata tests passed');
