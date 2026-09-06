const assert = require('assert');
const {
    isValidXhttpRange,
    sanitizeXhttpRange,
    validateXhttpInbound,
    validateXrayXhttp,
} = require('../src/utils/xhttpOptions');

// ---- ranges ----------------------------------------------------------------
assert.ok(isValidXhttpRange('100-1000'));
assert.ok(isValidXhttpRange('500'));
assert.ok(isValidXhttpRange('0-1000'));
// An inverted range and an int32 overflow both make Xray refuse to start, and
// used to pass every entry point because only the digit shape was checked.
assert.ok(!isValidXhttpRange('5000-100'));
assert.ok(!isValidXhttpRange('4000000000'));
assert.ok(!isValidXhttpRange('100..200'));
assert.strictEqual(sanitizeXhttpRange('5000-100'), '');
assert.strictEqual(sanitizeXhttpRange(' 100-1000 '), '100-1000');

// ---- cross-field invariants ------------------------------------------------
const base = { transport: 'xhttp', xhttpMode: 'packet-up' };

assert.strictEqual(validateXhttpInbound({ transport: 'tcp', xhttpXPaddingBytes: '0-0' }), null);
assert.match(
    validateXhttpInbound({ ...base, xhttpXPaddingBytes: '0-0' }, 'Main inbound'),
    /non-zero size/
);
assert.match(
    validateXhttpInbound({ ...base, xhttpXmuxMaxConcurrency: '32-16' }, 'Main inbound'),
    /ascending range/
);

// Anything but a body upload sends one request per packet, which only
// packet-up produces.
for (const placement of ['header', 'cookie']) {
    assert.match(
        validateXhttpInbound({ transport: 'xhttp', xhttpMode: 'auto', xhttpUplinkDataPlacement: placement, xhttpUplinkDataKey: 'X-Up' }),
        /packet-up mode/
    );
    assert.match(
        validateXhttpInbound({ ...base, xhttpUplinkDataPlacement: placement }),
        /uplink data key/
    );
    assert.strictEqual(
        validateXhttpInbound({ ...base, xhttpUplinkDataPlacement: placement, xhttpUplinkDataKey: 'X-Up' }),
        null
    );
}

assert.match(
    validateXhttpInbound({ transport: 'xhttp', xhttpMode: 'stream-up', xhttpUplinkHTTPMethod: 'GET' }),
    /GET upload requires packet-up/
);
assert.match(
    validateXhttpInbound({ ...base, xhttpUplinkHTTPMethod: 'GET', xhttpUplinkDataPlacement: 'body' }),
    /cannot carry data in the body/
);
// Xray treats an omitted placement as body, so a bare GET is the same mistake.
assert.match(
    validateXhttpInbound({ ...base, xhttpUplinkHTTPMethod: 'GET' }),
    /cannot carry data in the body/
);

// ---- session ID table/length ----------------------------------------------
assert.match(
    validateXhttpInbound({ ...base, xhttpSessionIDTable: 'Base62' }),
    /session ID length/
);
assert.match(
    validateXhttpInbound({ ...base, xhttpSessionIDLength: '16-32' }),
    /session ID table/
);
assert.match(
    validateXhttpInbound({ ...base, xhttpSessionIDTable: 'Base62', xhttpSessionIDLength: '0-32' }),
    /start above 0/
);
// xray-core rejects an ID space below ~2.1 billion: hex^5 is far short of it.
assert.match(
    validateXhttpInbound({ ...base, xhttpSessionIDTable: 'hex', xhttpSessionIDLength: '5-8' }),
    /too small/
);
assert.strictEqual(
    validateXhttpInbound({ ...base, xhttpSessionIDTable: 'Base62', xhttpSessionIDLength: '16-32' }),
    null
);
// "uuid" keeps the core's own generator, so no length is needed.
assert.strictEqual(validateXhttpInbound({ ...base, xhttpSessionIDTable: 'uuid' }), null);

// ---- whole-node walk -------------------------------------------------------
assert.strictEqual(validateXrayXhttp({ transport: 'tcp', extraInbounds: [] }), null);
assert.match(
    validateXrayXhttp({
        transport: 'tcp',
        extraInbounds: [{ label: 'CDN inbound', transport: 'xhttp', xhttpXPaddingBytes: '9000-100' }],
    }),
    /CDN inbound: XHTTP padding size/
);

console.log('XHTTP option tests passed');
