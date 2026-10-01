'use strict';

// Builds the projection Mongoose sends for the node update read without a
// database: MongoDB 4.4+ rejects a projection holding both a path and one of
// its children, which made every MCP/REST node update fail.

const assert = require('assert');

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const HyNode = require('../src/models/hyNodeModel');
const { FRONT_HIDDEN_SELECT } = require('../src/services/edgeFront/frontConfig');

function projectionFor(select) {
    const query = HyNode.findById('64b000000000000000000000').select(select);
    query._applyPaths();
    return query._fields || {};
}

function findCollision(fields) {
    const paths = Object.keys(fields);
    for (const parent of paths) {
        const child = paths.find(path => path.startsWith(`${parent}.`));
        if (child) return `${parent} / ${child}`;
    }
    return null;
}

const legacy = projectionFor(
    `type ip domain port virtual cdn xray name flag active groups ${FRONT_HIDDEN_SELECT}`
);
assert.ok(findCollision(legacy), 'the legacy projection must reproduce the collision');

const fields = projectionFor(FRONT_HIDDEN_SELECT);
assert.strictEqual(findCollision(fields), null, `path collision: ${findCollision(fields)}`);
assert.notStrictEqual(fields['xray.front.siteHtml'], 0, 'siteHtml must be loaded');
assert.notStrictEqual(fields['xray.front.rollbackSnapshot'], 0, 'rollbackSnapshot must be loaded');
assert.strictEqual(fields['xray.manualKey'], 0, 'manualKey must stay hidden');

console.log('test-node-update-projection: ok');
process.exit(0);
