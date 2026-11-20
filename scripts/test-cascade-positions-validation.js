const assert = require('assert');

const { parsePositionsBody, MAX_POSITIONS, MAX_COORD } = require('../src/utils/cascadeTopology');

const ID = '0123456789abcdef01234567';

const ok = parsePositionsBody({ positions: [{ id: ID, x: 10.04, y: -20.06 }] });
assert.deepStrictEqual(ok, { ok: true, positions: [{ id: ID, x: 10, y: -20.1 }] });

assert.deepStrictEqual(parsePositionsBody({ positions: [] }), { ok: true, positions: [] });

const rejected = [
    undefined,
    null,
    'positions',
    {},
    { positions: 'x' },
    { positions: [{ id: 'internet', x: 0, y: 0 }] },
    { positions: [{ id: `${ID}0`, x: 0, y: 0 }] },
    { positions: [{ id: { $gt: '' }, x: 0, y: 0 }] },
    { positions: [{ id: ID, x: '1', y: 0 }] },
    { positions: [{ id: ID, x: NaN, y: 0 }] },
    { positions: [{ id: ID, x: Infinity, y: 0 }] },
    { positions: [{ id: ID, x: MAX_COORD + 1, y: 0 }] },
    { positions: [{ id: ID, x: 0 }] },
    { positions: [{ id: ID, x: 0, y: 0, $set: { role: 'admin' } }] },
    { positions: Array.from({ length: MAX_POSITIONS + 1 }, () => ({ id: ID, x: 0, y: 0 })) },
];
for (const body of rejected) {
    const res = parsePositionsBody(body);
    assert.strictEqual(res.ok, false, `must reject ${JSON.stringify(body)?.slice(0, 80)}`);
    assert.match(res.error, /^invalid /);
}

const err = parsePositionsBody({ positions: [{ id: ID, x: 0, y: 'a' }] });
assert.strictEqual(err.error, 'invalid positions.0.y');

console.log('cascade positions validation tests passed');
