'use strict';

// VLESS Encryption: key material, node config, subscriptions, form input and
// version gating.

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

// Form parsing only; avoid loading the optional TOTP stack.
const totpServicePath = require.resolve('../src/services/totpService');
require.cache[totpServicePath] = { exports: {} };

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/');
}

// Subscription touches Mongo and Redis at require time.
function loadSubscription() {
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'qrcode') return {};
        if (normalizePath(parent?.filename).endsWith('/src/routes/subscription.js')) {
            if (request === '../../config') {
                return { BASE_URL: 'https://panel.example.com', PANEL_DOMAIN: 'panel.example.com' };
            }
            if (request === '../models/hyUserModel') return {};
            if (request === '../models/hyNodeModel') return {};
            if (request === '../services/cacheService') return {};
            if (request === '../utils/logger') {
                return { debug() {}, info() {}, warn() {}, error() {} };
            }
            if (request === '../services/cryptoService') return {};
            if (request === '../middleware/i18n') {
                return { getDateLocale: () => 'en-US', normalizeLanguage: v => v || 'en' };
            }
            if (request === '../services/uaStatsService') return { track() {} };
            if (request === '../utils/hwidHeaders') return { extractHwidHeaders: () => null };
            if (request === '../services/hwidDeviceService') return {};
            if (request === '../services/webhookService') return { EVENTS: {}, emit() {} };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../src/routes/subscription')];
        return require('../src/routes/subscription');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../src/routes/subscription')];
    }
}

const cryptoService = require('../src/services/cryptoService');
const HyNode = require('../src/models/hyNodeModel');
const configGenerator = require('../src/services/configGenerator');
const ve = require('../src/utils/vlessEncryption');
const {
    parseXrayFormFields,
    parseVlessEncryptionRegenerateIds,
    sanitizeXrayForRender,
    buildClonedNodePrefill,
} = require('../src/routes/panel/helpers');
const {
    getXrayPublishedInbounds,
    vlessURIForInbound,
    clashVlessProxyForInbound,
    singboxVlessOutboundForInbound,
    v2rayOutboundsForNode,
    singboxJSON,
    clashYAML,
} = loadSubscription();

const user = { userId: 'u1', password: 'p', xrayUuid: '11111111-1111-1111-1111-111111111111' };

function baseXray(overrides = {}) {
    return {
        transport: 'tcp',
        security: 'reality',
        flow: 'xtls-rprx-vision',
        inboundTag: 'vless-in',
        apiPort: 61000,
        realityDest: 'www.example.com:443',
        realitySni: ['www.example.com'],
        realityPrivateKey: 'reality-private',
        realityPublicKey: 'reality-public',
        realityShortIds: ['abcd'],
        extraInbounds: [],
        ...overrides,
    };
}

function makeNode(xray, overrides = {}) {
    return {
        _id: 'n1',
        name: 'Frankfurt',
        flag: '',
        type: 'xray',
        domain: 'de.example.com',
        ip: '203.0.113.10',
        port: 443,
        active: true,
        xray,
        ...overrides,
    };
}

(async () => {
    // ---- ML-KEM-768 key derivation matches FIPS 203 (NIST ACVP keyGen tcId 26)
    {
        const seed = Buffer.concat([
            Buffer.from('E582B7D75E6C80B05AE392A1FC9F7153B12390FD99930368CC67A768BAEBC8A0', 'hex'),
            Buffer.from('1CDACB8740C0B87C4A379575F187B367CBFA3B300BF591B109F79816E9CBE8F0', 'hex'),
        ]);
        const clientKey = await ve.deriveClientKey('mlkem768', seed.toString('base64url'));
        const ek = Buffer.from(clientKey, 'base64url');
        assert.strictEqual(ek.length, 1184);
        assert.strictEqual(
            crypto.createHash('sha256').update(ek).digest('hex'),
            '4158f6afb5e516c99f1da07da8c651348422b17c1f4e9a08ad73fb1f91249b3e'
        );
    }

    // ---- X25519 derivation agrees with generation
    {
        const { privateKey, publicKey } = cryptoService.generateX25519KeysLocal();
        assert.strictEqual(cryptoService.deriveX25519PublicKey(privateKey), publicKey);
        assert.throws(() => cryptoService.deriveX25519PublicKey('short'), /32 bytes/);
    }

    // ---- ticket normalization
    assert.strictEqual(ve.normalizeTicket(''), '600s');
    assert.strictEqual(ve.normalizeTicket(' 0S '), '0s');
    assert.strictEqual(ve.normalizeTicket('300-600s'), '300-600s');
    assert.strictEqual(ve.normalizeTicket('86400s'), '86400s');
    for (const bad of ['86401s', '0-600s', '600-300s', '600', '1rtt', '10m', '-1s', '1-2-3s']) {
        assert.strictEqual(ve.normalizeTicket(bad), null, bad);
    }

    // ---- defaults leave existing configs untouched
    {
        const node = new HyNode({ name: 'plain', type: 'xray', ip: '192.0.2.10', port: 443, xray: baseXray() });
        assert.strictEqual(node.validateSync(), undefined);
        assert.strictEqual(node.xray.vlessEncryption, false);
        const config = JSON.parse(configGenerator.generateXrayConfig(node.toObject(), []));
        const inbound = config.inbounds.find(i => i.tag === 'vless-in');
        assert.strictEqual(inbound.settings.decryption, 'none');

        const tlsNode = makeNode(baseXray({ security: 'tls', tlsSource: 'acme', flow: '', fallbackDest: '127.0.0.1:8080' }));
        const tlsConfig = JSON.parse(configGenerator.generateXrayConfig(tlsNode, []));
        const tlsInbound = tlsConfig.inbounds.find(i => i.tag === 'vless-in');
        assert.ok(Array.isArray(tlsInbound.settings.fallbacks), 'plain tcp+tls keeps its fallbacks');

        const published = getXrayPublishedInbounds(makeNode(baseXray()));
        assert.strictEqual(published[0].vlessEncryption, null);
        assert.ok(!vlessURIForInbound(user, makeNode(baseXray()), published[0]).includes('encryption=mlkem'));
    }

    // ---- enabling generates keys, encrypted at rest, caller keys ignored
    const enabled = baseXray({
        vlessEncryption: true,
        vlessEncryptionAuth: 'x25519',
        vlessEncryptionMode: 'xorpub',
        vlessEncryptionTicket: '300-600s',
        vlessEncryptionPrivateKey: 'attacker-chosen',
        vlessEncryptionPublicKey: 'attacker-chosen',
        extraInbounds: [{
            id: 'extra-1',
            port: 8444,
            inboundTag: 'vless-extra-1',
            transport: 'ws',
            security: 'none',
            wsPath: '/ws',
            vlessEncryption: true,
            vlessEncryptionAuth: 'mlkem768',
        }, {
            id: 'extra-2',
            port: 8445,
            inboundTag: 'vless-extra-2',
            transport: 'tcp',
            security: 'none',
        }],
    });
    assert.strictEqual(await ve.applyVlessEncryptionToXray(enabled, null), null);
    {
        assert.notStrictEqual(enabled.vlessEncryptionPublicKey, 'attacker-chosen');
        assert.notStrictEqual(enabled.vlessEncryptionPrivateKey, 'attacker-chosen');
        const serverKey = cryptoService.decrypt(enabled.vlessEncryptionPrivateKey);
        assert.strictEqual(Buffer.from(serverKey, 'base64url').length, 32);
        assert.ok(!enabled.vlessEncryptionPrivateKey.includes(serverKey), 'stored encrypted');
        assert.strictEqual(cryptoService.deriveX25519PublicKey(serverKey), enabled.vlessEncryptionPublicKey);

        const mlkem = enabled.extraInbounds[0];
        const seed = cryptoService.decrypt(mlkem.vlessEncryptionPrivateKey);
        assert.strictEqual(Buffer.from(seed, 'base64url').length, 64);
        assert.strictEqual(Buffer.from(mlkem.vlessEncryptionPublicKey, 'base64url').length, 1184);
        assert.strictEqual(await ve.deriveClientKey('mlkem768', seed), mlkem.vlessEncryptionPublicKey);
        assert.strictEqual(mlkem.vlessEncryptionMode, 'native');
        assert.strictEqual(mlkem.vlessEncryptionTicket, '600s');

        const plainExtra = enabled.extraInbounds[1];
        assert.strictEqual(plainExtra.vlessEncryption, false);
        assert.strictEqual(plainExtra.vlessEncryptionPrivateKey, '');

        const doc = new HyNode({ name: 'enc', type: 'xray', ip: '192.0.2.10', port: 443, xray: enabled });
        assert.strictEqual(doc.validateSync(), undefined);
    }

    // ---- node config: decryption string, no fallbacks, broken key fails loudly
    {
        const config = JSON.parse(configGenerator.generateXrayConfig(makeNode(enabled), []));
        const main = config.inbounds.find(i => i.tag === 'vless-in');
        const serverKey = cryptoService.decrypt(enabled.vlessEncryptionPrivateKey);
        assert.strictEqual(main.settings.decryption, `mlkem768x25519plus.xorpub.300-600s.${serverKey}`);
        const extra = config.inbounds.find(i => i.tag === 'vless-extra-1');
        const seed = cryptoService.decrypt(enabled.extraInbounds[0].vlessEncryptionPrivateKey);
        assert.strictEqual(extra.settings.decryption, `mlkem768x25519plus.native.600s.${seed}`);
        assert.strictEqual(config.inbounds.find(i => i.tag === 'vless-extra-2').settings.decryption, 'none');

        const redacted = configGenerator.generateXrayConfig(makeNode(enabled), [], { redactSecrets: true });
        assert.ok(!redacted.includes(serverKey) && !redacted.includes(seed), 'preview never shows server keys');
        assert.ok(redacted.includes('mlkem768x25519plus.xorpub.300-600s.<redacted>'));

        const tlsEnc = { ...enabled, security: 'tls', tlsSource: 'acme', flow: '', fallbackDest: '127.0.0.1:8080', extraInbounds: [] };
        const tlsInbound = JSON.parse(configGenerator.generateXrayConfig(makeNode(tlsEnc), []))
            .inbounds.find(i => i.tag === 'vless-in');
        assert.strictEqual(tlsInbound.settings.fallbacks, undefined, 'fallbacks are never emitted with decryption');

        const broken = { ...enabled, vlessEncryptionPrivateKey: cryptoService.encrypt('not-a-key'), extraInbounds: [] };
        assert.throws(
            () => configGenerator.generateXrayConfig(makeNode(broken), []),
            err => err.code === 'VLESS_ENCRYPTION_KEY_INVALID'
        );
    }

    // ---- key preservation, rekeying and disabling
    {
        const next = JSON.parse(JSON.stringify(enabled));
        next.vlessEncryptionMode = 'random';
        next.vlessEncryptionPublicKey = 'attacker-chosen';
        next.extraInbounds.reverse();
        assert.strictEqual(await ve.applyVlessEncryptionToXray(next, enabled), null);
        assert.strictEqual(next.vlessEncryptionPrivateKey, enabled.vlessEncryptionPrivateKey, 'kept on mode change');
        assert.strictEqual(next.vlessEncryptionPublicKey, enabled.vlessEncryptionPublicKey);
        const movedExtra = next.extraInbounds.find(i => i.id === 'extra-1');
        assert.strictEqual(movedExtra.vlessEncryptionPublicKey, enabled.extraInbounds[0].vlessEncryptionPublicKey,
            'extras are matched by id, not position');

        const rekeyed = JSON.parse(JSON.stringify(enabled));
        assert.strictEqual(await ve.applyVlessEncryptionToXray(rekeyed, enabled, ['main']), null);
        assert.notStrictEqual(rekeyed.vlessEncryptionPublicKey, enabled.vlessEncryptionPublicKey);
        assert.strictEqual(rekeyed.extraInbounds[0].vlessEncryptionPublicKey,
            enabled.extraInbounds[0].vlessEncryptionPublicKey, 'regenerating main leaves extras alone');

        const switched = JSON.parse(JSON.stringify(enabled));
        switched.vlessEncryptionAuth = 'mlkem768';
        assert.strictEqual(await ve.applyVlessEncryptionToXray(switched, enabled), null);
        assert.strictEqual(Buffer.from(switched.vlessEncryptionPublicKey, 'base64url').length, 1184,
            'auth change generates a key of the new type');

        const partial = { vlessEncryptionMode: 'native' };
        assert.strictEqual(await ve.applyVlessEncryption(partial, enabled), null);
        assert.strictEqual(partial.vlessEncryption, true, 'omitted fields fall back to stored values');
        assert.strictEqual(partial.vlessEncryptionTicket, '300-600s');
        assert.strictEqual(partial.vlessEncryptionPrivateKey, enabled.vlessEncryptionPrivateKey);

        const disabled = JSON.parse(JSON.stringify(enabled));
        disabled.vlessEncryption = false;
        assert.strictEqual(await ve.applyVlessEncryptionToXray(disabled, enabled), null);
        assert.strictEqual(disabled.vlessEncryptionPrivateKey, enabled.vlessEncryptionPrivateKey,
            'turning it off keeps the key so turning it back on does not break clients');
        assert.strictEqual(ve.buildServerDecryption(disabled), 'none');

        const repaired = { ...JSON.parse(JSON.stringify(enabled)), extraInbounds: [] };
        const prevBadPublic = { ...enabled, vlessEncryptionPublicKey: 'garbage' };
        assert.strictEqual(await ve.applyVlessEncryptionToXray(repaired, prevBadPublic), null);
        assert.strictEqual(repaired.vlessEncryptionPublicKey, enabled.vlessEncryptionPublicKey,
            'an unusable stored client key is re-derived');

        const prevUndecryptable = { ...enabled, vlessEncryptionPrivateKey: 'garbage', extraInbounds: [] };
        const recovered = { ...JSON.parse(JSON.stringify(enabled)), extraInbounds: [] };
        assert.strictEqual(await ve.applyVlessEncryptionToXray(recovered, prevUndecryptable), null);
        assert.ok(cryptoService.decrypt(recovered.vlessEncryptionPrivateKey), 'undecryptable key is replaced');
    }

    // ---- validation errors
    {
        const badTicket = baseXray({ vlessEncryption: true, vlessEncryptionTicket: '1rtt' });
        assert.match(await ve.applyVlessEncryptionToXray(badTicket, null), /Main inbound: .*ticket/);

        const withFallback = baseXray({ security: 'tls', vlessEncryption: true, fallbackDest: '127.0.0.1:80' });
        assert.match(await ve.applyVlessEncryptionToXray(withFallback, null), /fallback/);

        const extraFallback = baseXray({
            extraInbounds: [{ id: 'x', port: 8444, transport: 'tcp', security: 'tls', fallbackDest: '80', vlessEncryption: true }],
        });
        assert.match(await ve.applyVlessEncryptionToXray(extraFallback, null), /Extra inbound #1: .*fallback/);

        const offWithFallback = baseXray({ security: 'tls', fallbackDest: '127.0.0.1:80', vlessEncryptionTicket: 'junk' });
        assert.strictEqual(await ve.applyVlessEncryptionToXray(offWithFallback, null), null,
            'disabled inbounds are not blocked by encryption settings');

        const enumGarbage = baseXray({ vlessEncryption: true, vlessEncryptionAuth: 'rsa', vlessEncryptionMode: '$(id)' });
        assert.strictEqual(await ve.applyVlessEncryptionToXray(enumGarbage, null), null);
        assert.strictEqual(enumGarbage.vlessEncryptionAuth, 'x25519');
        assert.strictEqual(enumGarbage.vlessEncryptionMode, 'native');

        assert.strictEqual(await ve.applyVlessEncryptionToXray(baseXray({ vlessEncryption: 'true' }), null), null);
    }

    // ---- subscriptions: URI, Clash, Xray JSON, sing-box skip
    {
        const node = makeNode(enabled);
        const published = getXrayPublishedInbounds(node);
        const clientMain = `mlkem768x25519plus.xorpub.0rtt.${enabled.vlessEncryptionPublicKey}`;
        assert.strictEqual(published[0].vlessEncryption, clientMain);
        assert.strictEqual(published[1].vlessEncryption,
            `mlkem768x25519plus.native.0rtt.${enabled.extraInbounds[0].vlessEncryptionPublicKey}`);
        assert.strictEqual(published[2].vlessEncryption, null);

        const uri = new URL(vlessURIForInbound(user, node, published[0]));
        assert.strictEqual(uri.searchParams.get('encryption'), clientMain);
        assert.strictEqual(uri.searchParams.get('flow'), 'xtls-rprx-vision', 'flow is unchanged');
        assert.strictEqual(new URL(vlessURIForInbound(user, node, published[2])).searchParams.get('encryption') || 'none', 'none');

        const clash = clashVlessProxyForInbound(user, node, published[0]).proxy;
        assert.ok(clash.includes(`encryption: "${clientMain}"`));
        assert.ok(!clashVlessProxyForInbound(user, node, published[2]).proxy.includes('encryption:'));

        const v2ray = v2rayOutboundsForNode(user, node);
        const vnextUsers = v2ray.map(o => o.outbound.settings.vnext[0].users[0].encryption);
        assert.deepStrictEqual(vnextUsers, [clientMain, published[1].vlessEncryption, 'none']);

        assert.strictEqual(singboxVlessOutboundForInbound(user, node, published[0]).outbound, null);
        assert.ok(singboxVlessOutboundForInbound(user, node, published[2]).outbound);

        // Only the plain extra survives in sing-box; groups must reference real outbounds.
        const virtual = {
            _id: 'v1', name: 'Auto EU', type: 'virtual', virtual: {},
            _resolvedSources: [{ _id: 'n1' }],
        };
        const sb = singboxJSON(user, [node, virtual], null);
        const outboundTags = new Set(sb.outbounds.map(o => o.tag));
        for (const group of sb.outbounds.filter(o => Array.isArray(o.outbounds))) {
            assert.ok(group.outbounds.length > 0, `${group.tag} is not empty`);
            for (const tag of group.outbounds) assert.ok(outboundTags.has(tag), `${group.tag} -> ${tag}`);
        }
        assert.strictEqual(sb.outbounds.filter(o => o.type === 'vless').length, 1);

        const allEncrypted = makeNode({ ...enabled, extraInbounds: [enabled.extraInbounds[0]] });
        const sbEmpty = singboxJSON(user, [allEncrypted, virtual], null);
        assert.strictEqual(sbEmpty.outbounds.filter(o => o.type === 'vless').length, 0);
        assert.ok(!sbEmpty.outbounds.some(o => o.type === 'urltest'), 'no empty urltest groups');
        for (const group of sbEmpty.outbounds.filter(o => Array.isArray(o.outbounds))) {
            assert.ok(group.outbounds.length > 0, `${group.tag} is not empty`);
        }

        const yaml = clashYAML(user, [node], null);
        assert.ok(yaml.includes(`encryption: "${clientMain}"`));

        // Unusable client key: the inbound is withheld, never published as plain VLESS.
        const brokenPublic = makeNode({ ...enabled, vlessEncryptionPublicKey: 'garbage' });
        const brokenPublished = getXrayPublishedInbounds(brokenPublic);
        assert.ok(!brokenPublished.some(i => !i.extraId), 'main inbound withheld');
        assert.strictEqual(brokenPublished.length, 2);
    }

    // ---- CDN copies inherit the client string
    {
        const origin = makeNode(enabled);
        const cdn = {
            _id: 'c1', name: 'CDN', type: 'cdn', _resolvedOrigin: origin,
            cdn: { originInboundId: 'extra-1', domain: 'cdn.example.com', edges: [] },
        };
        const published = getXrayPublishedInbounds(cdn);
        assert.strictEqual(published.length, 1);
        assert.strictEqual(published[0].vlessEncryption,
            `mlkem768x25519plus.native.0rtt.${enabled.extraInbounds[0].vlessEncryptionPublicKey}`);
        assert.strictEqual(new URL(vlessURIForInbound(user, cdn, published[0])).searchParams.get('encryption'),
            published[0].vlessEncryption);
    }

    // ---- version gating
    {
        assert.strictEqual(ve.versionError(baseXray(), 'v1.8.0', 'n'), null, 'disabled never blocks');
        assert.match(ve.versionError(enabled, 'v25.9.4', 'Frankfurt'), /requires Xray >= 25\.9\.5, Frankfurt runs/);
        assert.match(ve.versionError({ extraInbounds: [{ vlessEncryption: true }] }, '1.8.24'), /25\.9\.5/);
        assert.strictEqual(ve.versionError(enabled, 'v25.9.5'), null);
        assert.strictEqual(ve.versionError(enabled, 'v26.1.1'), null);
        assert.strictEqual(ve.versionError(enabled, ''), null, 'unknown version is left to xray -test');
        assert.strictEqual(ve.versionError(enabled, 'custom-build'), null);
    }

    // ---- panel form parsing
    {
        const parsed = parseXrayFormFields({
            'xray.transport': 'tcp',
            'xray.security': 'reality',
            'xray.vlessEncryption': 'on',
            'xray.vlessEncryptionAuth': 'mlkem768',
            'xray.vlessEncryptionMode': 'random',
            'xray.vlessEncryptionTicket': ' 0s ',
            'xray.vlessEncryptionPrivateKey': 'injected',
            xray_extra_id: ['a', 'b'],
            xray_extra_port: ['8444', '8445'],
            xray_extra_inboundTag: ['vless-extra-1', 'vless-extra-2'],
            xray_extra_transport: ['tcp', 'ws'],
            xray_extra_security: ['none', 'none'],
            xray_extra_vlessEncryption: 'b',
            xray_extra_vlessEncryptionAuth: ['x25519', 'bogus'],
            xray_extra_vlessEncryptionMode: ['native', 'xorpub'],
            xray_extra_vlessEncryptionTicket: ['600s', '300-600s'],
        });
        assert.strictEqual(parsed.vlessEncryption, true);
        assert.strictEqual(parsed.vlessEncryptionAuth, 'mlkem768');
        assert.strictEqual(parsed.vlessEncryptionMode, 'random');
        assert.strictEqual(parsed.vlessEncryptionTicket, '0s');
        assert.strictEqual(parsed.extraInbounds[0].vlessEncryption, false);
        assert.strictEqual(parsed.extraInbounds[1].vlessEncryption, true, 'checked rows are matched by id');
        assert.strictEqual(parsed.extraInbounds[1].vlessEncryptionAuth, 'x25519');
        assert.strictEqual(parsed.extraInbounds[1].vlessEncryptionMode, 'xorpub');
        assert.strictEqual(await ve.applyVlessEncryptionToXray(parsed, null), null);
        assert.notStrictEqual(parsed.vlessEncryptionPrivateKey, 'injected');

        const legacyForm = parseXrayFormFields({ 'xray.transport': 'tcp', 'xray.security': 'reality' });
        assert.strictEqual(legacyForm.vlessEncryption, undefined, 'forms without the block leave the fields alone');

        assert.deepStrictEqual(parseVlessEncryptionRegenerateIds({
            'xray.vlessEncryptionRegenerate': '1',
            xray_extra_vlessEncryptionRegenerate: ['', 'b'],
        }), ['main', 'b']);
        assert.deepStrictEqual(parseVlessEncryptionRegenerateIds({ 'xray.vlessEncryptionRegenerate': 'yes' }), []);

        const apiPatch = { vlessEncryptionRegenerate: true, extraInbounds: [{ id: 'b', vlessEncryptionRegenerate: true }, { vlessEncryptionRegenerate: true }] };
        assert.deepStrictEqual(ve.takeRegenerateIds(apiPatch), ['main', 'b']);
        assert.ok(!('vlessEncryptionRegenerate' in apiPatch) && !apiPatch.extraInbounds.some(i => 'vlessEncryptionRegenerate' in i));
        assert.deepStrictEqual(ve.takeRegenerateIds({ vlessEncryptionRegenerate: 'true' }), []);
    }

    // ---- server keys never leave the panel
    {
        const node = { _id: 'n1', name: 'x', xray: JSON.parse(JSON.stringify(enabled)) };
        const redacted = ve.redactNode(node);
        assert.strictEqual(redacted.xray.vlessEncryptionPrivateKey, undefined);
        assert.strictEqual(redacted.xray.extraInbounds[0].vlessEncryptionPrivateKey, undefined);
        assert.strictEqual(redacted.xray.vlessEncryptionPublicKey, enabled.vlessEncryptionPublicKey);
        assert.ok(node.xray.vlessEncryptionPrivateKey && node.xray.extraInbounds[0].vlessEncryptionPrivateKey,
            'the source document is not mutated');

        const rendered = sanitizeXrayForRender(JSON.parse(JSON.stringify(enabled)));
        assert.strictEqual(rendered.vlessEncryptionPrivateKey, undefined);
        assert.strictEqual(rendered.extraInbounds[0].vlessEncryptionPrivateKey, undefined);
        assert.strictEqual(rendered.vlessEncryptionPublicKey, enabled.vlessEncryptionPublicKey);

        const clone = buildClonedNodePrefill({ type: 'xray', name: 'src', xray: JSON.parse(JSON.stringify(enabled)) });
        assert.strictEqual(clone.xray.vlessEncryption, true);
        assert.strictEqual(clone.xray.vlessEncryptionPrivateKey, undefined);
        assert.strictEqual(clone.xray.vlessEncryptionPublicKey, undefined);
        assert.strictEqual(clone.xray.extraInbounds[0].vlessEncryptionPrivateKey, undefined);
        assert.strictEqual(await ve.applyVlessEncryptionToXray(clone.xray, null), null);
        assert.notStrictEqual(clone.xray.vlessEncryptionPublicKey, enabled.vlessEncryptionPublicKey, 'a clone gets new keys');

        assert.ok(ve.PRIVATE_KEY_EXCLUDE.split(' ').every(p => p.startsWith('-') && p.endsWith('vlessEncryptionPrivateKey')));
    }

    console.log('vless encryption tests passed');
    // versionError loads xrayVersionService, whose SSH pool keeps a timer alive.
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
