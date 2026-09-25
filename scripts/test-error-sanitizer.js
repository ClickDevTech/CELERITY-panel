const assert = require('assert');

const logger = require('../src/utils/logger');
const { sanitizeJsonErrors, errorHandler } = require('../src/middleware/errorSanitizer');

const logged = [];
logger.error = message => logged.push(message);

function makeRes() {
    const res = {
        statusCode: 200,
        body: undefined,
        contentType: '',
        status(code) { res.statusCode = code; return res; },
        json(body) { res.body = body; return res; },
        type(value) { res.contentType = value; return res; },
        send(body) { res.body = body; return res; },
    };
    return res;
}

function makeReq({ admin = false, apiKey = null, path = '/api/nodes/1/disable' } = {}) {
    return {
        method: 'POST',
        path,
        originalUrl: path,
        session: admin ? { authenticated: true } : {},
        apiKey,
    };
}

function sendJson(req, status, body) {
    const res = makeRes();
    sanitizeJsonErrors(req, res, () => {});
    res.status(status).json(body);
    return res;
}

const original = { error: 'SSH timeout', node: { active: false } };
process.env.NODE_ENV = 'production';

assert.deepStrictEqual(
    sendJson(makeReq({ admin: true }), 500, original).body,
    original,
    'admin session must receive the original 5xx body'
);

for (const req of [makeReq({ admin: true, apiKey: { keyPrefix: 'ck_x' } }), makeReq()]) {
    logged.length = 0;
    const { body } = sendJson(req, 500, original);
    assert.strictEqual(body.error, 'Internal Server Error', 'API key and anonymous 5xx must be masked');
    assert.match(body.requestId, /^[0-9a-f]{8}$/, 'masked body must carry a requestId');
    assert.strictEqual(body.node, undefined, 'masked body must not leak other fields');
    assert.ok(logged[0].includes(body.requestId) && logged[0].includes('SSH timeout'),
        'the original error must be logged under the same requestId');
}

assert.deepStrictEqual(
    sendJson(makeReq(), 409, original).body,
    original,
    'non-5xx bodies must pass through untouched'
);

process.env.NODE_ENV = 'development';
assert.deepStrictEqual(
    sendJson(makeReq(), 500, original).body,
    original,
    'development must not mask'
);
process.env.NODE_ENV = 'production';

{
    const req = makeReq();
    const res = makeRes();
    sanitizeJsonErrors(req, res, () => {});
    logged.length = 0;
    errorHandler(new Error('boom'), req, res, () => {});
    const body = JSON.parse(res.body);
    assert.strictEqual(res.contentType, 'json', 'API errors must be sent as JSON');
    assert.strictEqual(body.error, 'Internal Server Error', 'API errorHandler output must be masked');
    assert.match(body.requestId, /^[0-9a-f]{8}$/, 'masked API error must carry a requestId');
    assert.strictEqual(logged.length, 1, 'a masked API error must be logged exactly once');
}

{
    const req = makeReq({ admin: true });
    const res = makeRes();
    errorHandler(new Error('boom'), req, res, () => {});
    assert.deepStrictEqual(JSON.parse(res.body), { error: 'boom' }, 'admin API error must stay unmasked');
}

{
    const res = makeRes();
    res.headersSent = true;
    const err = new Error('late');
    let forwarded = null;
    errorHandler(err, makeReq(), res, e => { forwarded = e; });
    assert.strictEqual(forwarded, err, 'errors after headers are sent must go to the default handler');
    assert.strictEqual(res.body, undefined, 'nothing must be written after headers are sent');
}

{
    const req = makeReq({ admin: true, path: '/panel/nodes' });
    const res = makeRes();
    errorHandler(new Error('<b>boom</b>'), req, res, () => {});
    assert.strictEqual(res.contentType, 'text', 'panel errors must be sent as plain text');
    assert.strictEqual(res.body, '<b>boom</b>', 'admin panel error must keep the original message');
}

{
    const req = makeReq({ path: '/panel/nodes' });
    const res = makeRes();
    errorHandler(new Error('boom'), req, res, () => {});
    assert.match(res.body, /^Internal Server Error \([0-9a-f]{8}\)$/, 'anonymous panel error must be masked');
}

console.log('error sanitizer tests passed');
