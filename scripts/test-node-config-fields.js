/**
 * Bulk config field allowlist tests (pure, no DB).
 *
 * Verifies the allowlist holds no secrets or server-side fields, values are
 * checked strictly (ALPN enum, fingerprints, xhttp ranges, ACL syntax), scope
 * and inbound filters pick the right inbounds, fronted inbounds are left
 * alone and ACL rules respect per-node outbounds and Hysteria ACL modes.
 */

const assert = require('assert');
const fields = require('../src/services/nodeConfigFields');

const { parsePatch, planNodePatch, applyChanges, FIELDS } = fields;

function rejects(params, pattern) {
    assert.throws(() => parsePatch(params), (error) => {
        assert.strictEqual(error.statusCode, 400);
        if (pattern) assert.match(error.message, pattern);
        return true;
    });
}

// --- allowlist contents ------------------------------------------------------
{
    const paths = Object.keys(FIELDS);
    const forbidden = [
        /secret/i, /password/i, /privateKey/i, /publicKey/i, /token/i, /manualKey/i, /manualCert/i,
        /initScript/, /customConfig/, /^ssh\./, /^cdn\./, /front/, /port/i, /listen/, /\.security$/,
        /tlsSource/, /domain/, /\bsni\b/, /portRange/, /vlessEncryption/, /statsSecret/, /acmeEmail/,
    ];
    for (const path of paths) {
        for (const re of forbidden) {
            assert.ok(!re.test(path), `${path} must not be bulk-editable (${re})`);
        }
    }
    assert.ok(paths.includes('xray.alpn') && paths.includes('aclRules') && paths.includes('bandwidth.up'));
    assert.ok(fields.listFields().every(f => f.ops.includes('set')));
}

// --- strict values -----------------------------------------------------------
rejects({ path: 'ssh.password', value: 'x' }, /cannot be changed/);
rejects({ path: 'xray.port', value: 443 }, /cannot be changed/);
rejects({ path: '__proto__', value: 'x' }, /cannot be changed/);
rejects({ path: 'xray.alpn', value: 'h2,h4' }, /alpn/);
rejects({ path: 'xray.alpn', value: 'h2', op: 'append' }, /not supported/);
rejects({ path: 'xray.fingerprint', value: 'chrom' }, /fingerprint/);
rejects({ path: 'xray.fingerprint', value: 'chrome', op: 'add' }, /not supported/);
rejects({ path: 'xray.fingerprint', value: ['chrome'] }, /single value/);
rejects({ path: 'xray.flow', value: 'xtls-rprx-direct' }, /flow/);
rejects({ path: 'xray.xhttpXPaddingBytes', value: '5000-100' }, /ascending range/);
rejects({ path: 'xray.realityDest', value: 'example.com' }, /host:port/);
rejects({ path: 'xray.realityDest', value: 'example.com:70000' }, /host:port/);
rejects({ path: 'xray.realitySni', value: 'bad host', op: 'set' }, /realitySni/);
rejects({ path: 'xray.realitySni', value: '', op: 'set' }, /cannot be empty/);
rejects({ path: 'xray.realityShortIds', value: 'xyz' }, /realityShortIds/);
rejects({ path: 'xray.wsPath', value: 'no-slash' }, /wsPath/);
rejects({ path: 'xray.connIdle', value: '5' }, /10\.\.86400/);
rejects({ path: 'xray.xhttpNoGrpcHeader', value: 'yes' }, /true or false/);
rejects({ path: 'xray.alpn', value: 'h2', scope: 'all' }, /scope/);
rejects({ path: 'xray.alpn', value: 'h2', inboundFilter: { transport: 'quic' } }, /transport/);
rejects({ path: 'masquerade.proxy.url', value: 'javascript:alert(1)' }, /http\(s\) URL/);
rejects({ path: 'aclRules', op: 'add', value: 'reject(geoip:cn); rm -rf /' }, /not a rule/);
rejects({ path: 'aclRules', op: 'add', value: 'reject(geoip:cn)\n"x"(y)' }, /not a rule/);
rejects({ path: 'aclRules', op: 'add', value: '' }, /at least one/);
rejects({ path: 'aclRules', op: 'add', value: 'reject(a)', position: 'middle' }, /position/);
rejects({ path: 'aclRules', op: 'set', value: Array.from({ length: 101 }, (_, i) => `reject(h${i}.example.com)`) }, /at most 100/);

{
    const alpn = parsePatch({ path: 'xray.alpn', value: ' h2 , http/1.1,h2 ' });
    assert.deepStrictEqual(alpn.value, ['h2', 'http/1.1'], 'trimmed, deduplicated');
    assert.strictEqual(alpn.scope, 'main_extras');
    assert.deepStrictEqual(parsePatch({ path: 'xray.alpn', value: '' }).value, [], 'empty ALPN = Xray default');
    assert.deepStrictEqual(parsePatch({ path: 'xray.realityShortIds', value: ',ab12' }).value, ['', 'ab12'], 'empty short id kept');
    assert.strictEqual(parsePatch({ path: 'xray.connIdle', value: '600' }).value, 600);
    assert.strictEqual(parsePatch({ path: 'disableUDP', value: 'on' }).value, true);
    const acl = parsePatch({ path: 'aclRules', op: 'add', value: 'reject(geoip:cn)\r\n ukr(suffix:example.com) \n' });
    assert.deepStrictEqual(acl.value, ['reject(geoip:cn)', 'ukr(suffix:example.com)']);
    assert.strictEqual(acl.position, 'start', 'new rules go first by default');
    assert.strictEqual(acl.scope, null);
    assert.deepStrictEqual(fields.publicPatch(acl), { path: 'aclRules', op: 'add', value: acl.value, position: 'start' });
}

// --- per-node planning: inbounds, scope, filter, front -------------------------
const xrayNode = {
    type: 'xray',
    xray: {
        security: 'tls',
        transport: 'xhttp',
        alpn: ['h2'],
        fingerprint: 'chrome',
        extraInbounds: [
            { id: 'e1', label: 'reality', security: 'reality', transport: 'tcp', alpn: [] },
            { id: 'e2', label: 'tls-ws', security: 'tls', transport: 'ws', alpn: ['http/1.1'] },
            { id: 'e3', label: 'fronted', security: 'none', transport: 'xhttp', listen: '127.0.0.1', alpn: [] },
        ],
        front: { enabled: true, inboundIds: ['e3'] },
    },
};

{
    const patch = parsePatch({ path: 'xray.alpn', value: 'h3,h2' });
    const plan = planNodePatch(xrayNode, patch);
    assert.deepStrictEqual(plan.changes.map(c => c.target), ['main', 'e2'], 'TLS inbounds only, fronted one excluded');
    assert.deepStrictEqual(plan.changes[1], {
        target: 'e2', label: 'tls-ws', key: 'alpn', dbPath: 'xray.extraInbounds.1.alpn', before: ['http/1.1'], after: ['h3', 'h2'],
    });
    assert.ok(plan.notes.some(n => /reality: security is reality/.test(n)));
    assert.ok(plan.notes.some(n => /fronted: served by the reverse proxy front/.test(n)));

    const mainOnly = planNodePatch(xrayNode, parsePatch({ path: 'xray.alpn', value: 'h3', scope: 'main' }));
    assert.deepStrictEqual(mainOnly.changes.map(c => c.target), ['main']);
    const extras = planNodePatch(xrayNode, parsePatch({ path: 'xray.alpn', value: 'h3', scope: 'extras' }));
    assert.deepStrictEqual(extras.changes.map(c => c.target), ['e2']);
    const wsOnly = planNodePatch(xrayNode, parsePatch({ path: 'xray.alpn', value: 'h3', inboundFilter: { transport: 'ws' } }));
    assert.deepStrictEqual(wsOnly.changes.map(c => c.target), ['e2']);

    const same = planNodePatch(xrayNode, parsePatch({ path: 'xray.alpn', value: 'h2', scope: 'main' }));
    assert.deepStrictEqual(same.changes, []);
    assert.strictEqual(same.reason, 'Already up to date');

    const vision = planNodePatch(xrayNode, parsePatch({ path: 'xray.flow', value: 'xtls-rprx-vision' }));
    assert.deepStrictEqual(vision.changes.map(c => c.target), ['e1'], 'Vision only on raw TCP');

    const hysteriaOnly = planNodePatch(xrayNode, parsePatch({ path: 'disableUDP', value: true }));
    assert.match(hysteriaOnly.reason, /Not available for xray/);

    const applied = applyChanges(xrayNode, plan.changes);
    assert.deepStrictEqual(applied.xray.alpn, ['h3', 'h2']);
    assert.deepStrictEqual(applied.xray.extraInbounds[1].alpn, ['h3', 'h2']);
    assert.deepStrictEqual(xrayNode.xray.alpn, ['h2'], 'input is not mutated');
}

// --- list operations ---------------------------------------------------------
{
    const node = { type: 'xray', xray: { security: 'reality', realityShortIds: ['', 'ab'], realitySni: ['a.example.com'] } };
    const add = planNodePatch(node, parsePatch({ path: 'xray.realityShortIds', op: 'add', value: 'cd', scope: 'main' }));
    assert.deepStrictEqual(add.changes[0].after, ['', 'ab', 'cd'], 'add appends');
    const removeAll = planNodePatch(node, parsePatch({ path: 'xray.realityShortIds', op: 'remove', value: 'ab', scope: 'main' }));
    assert.deepStrictEqual(removeAll.changes[0].after, ['']);
    const emptySni = planNodePatch(node, parsePatch({ path: 'xray.realitySni', op: 'remove', value: 'a.example.com', scope: 'main' }));
    assert.deepStrictEqual(emptySni.changes, []);
    assert.match(emptySni.reason, /cannot become empty/);
}

// --- ACL rules ---------------------------------------------------------------
{
    const hy = {
        type: 'hysteria',
        acl: { enabled: true, type: 'inline' },
        outbounds: [{ name: 'ukr', type: 'socks5' }, { name: 'blk', type: 'block' }],
        aclRules: ['reject(geoip:private)', 'direct(all)'],
    };
    const add = planNodePatch(hy, parsePatch({ path: 'aclRules', op: 'add', value: 'reject(geoip:cn)\nukr(suffix:example.com)' }));
    assert.deepStrictEqual(add.changes[0].after,
        ['reject(geoip:cn)', 'ukr(suffix:example.com)', 'reject(geoip:private)', 'direct(all)'],
        'added before the catch-all');
    const addEnd = planNodePatch(hy, parsePatch({ path: 'aclRules', op: 'add', value: 'default(all)', position: 'end' }));
    assert.deepStrictEqual(addEnd.changes[0].after.slice(-1), ['default(all)']);
    const dup = planNodePatch(hy, parsePatch({ path: 'aclRules', op: 'add', value: 'direct(all)' }));
    assert.strictEqual(dup.reason, 'Already up to date', 'existing rule is not duplicated');
    const missing = planNodePatch(hy, parsePatch({ path: 'aclRules', op: 'add', value: 'nl(all)' }));
    assert.match(missing.reason, /Outbound "nl" does not exist/);
    const block = planNodePatch(hy, parsePatch({ path: 'aclRules', op: 'add', value: 'blk(all)' }));
    assert.match(block.reason, /Outbound "blk" does not exist/, 'block entries are not real outbounds');
    const remove = planNodePatch(hy, parsePatch({ path: 'aclRules', op: 'remove', value: 'direct(all)' }));
    assert.deepStrictEqual(remove.changes[0].after, ['reject(geoip:private)']);
    assert.strictEqual(remove.changes[0].dbPath, 'aclRules');
    const set = planNodePatch(hy, parsePatch({ path: 'aclRules', op: 'set', value: 'reject(geoip:cn)' }));
    assert.deepStrictEqual(set.changes[0].after, ['reject(geoip:cn)']);

    assert.match(planNodePatch({ ...hy, acl: { enabled: false } }, parsePatch({ path: 'aclRules', op: 'add', value: 'reject(a.example.com)' })).reason,
        /ACL is disabled/);
    assert.match(planNodePatch({ ...hy, acl: { enabled: true, type: 'file' } }, parsePatch({ path: 'aclRules', op: 'add', value: 'reject(a.example.com)' })).reason,
        /from a file/);

    const xr = { type: 'xray', outbounds: [], aclRules: [] };
    assert.match(planNodePatch(xr, parsePatch({ path: 'aclRules', op: 'add', value: 'proxy(all)' })).reason, /"proxy" does not exist/,
        'proxy needs a custom outbound on Xray');
    assert.match(planNodePatch(xr, parsePatch({ path: 'aclRules', op: 'add', value: 'default(all)' })).reason, /"default" does not exist/,
        'default is a Hysteria built-in only');
    assert.strictEqual(planNodePatch({ ...xr, outbounds: [{ name: 'ukr', type: 'socks5' }] },
        parsePatch({ path: 'aclRules', op: 'add', value: 'proxy(all)' })).changes.length, 1);
    assert.match(planNodePatch({ type: 'cdn' }, parsePatch({ path: 'aclRules', op: 'add', value: 'reject(a.example.com)' })).reason,
        /Not available for cdn/);
}

// --- Hysteria scalars --------------------------------------------------------
{
    const hy = { type: 'hysteria', masquerade: { type: 'proxy', proxy: { url: 'https://old.example.com' } } };
    const url = planNodePatch(hy, parsePatch({ path: 'masquerade.proxy.url', value: 'https://new.example.com' }));
    assert.deepStrictEqual(url.changes[0], {
        target: 'node', label: '', key: 'masquerade.proxy.url', dbPath: 'masquerade.proxy.url',
        before: 'https://old.example.com', after: 'https://new.example.com',
    });
    assert.match(planNodePatch({ type: 'hysteria', masquerade: { type: 'string' } },
        parsePatch({ path: 'masquerade.proxy.url', value: 'https://new.example.com' })).reason, /masquerade type is string/);
    assert.strictEqual(applyChanges(hy, url.changes).masquerade.proxy.url, 'https://new.example.com');
}

console.log('node config fields tests passed');
