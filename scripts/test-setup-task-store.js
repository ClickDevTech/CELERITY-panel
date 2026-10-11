'use strict';

// Setup-task progress store: lifecycle, log cap, TTL expiry.

const assert = require('assert');
const store = require('../src/utils/setupTaskStore');

store.clearTasks();

// Miss -> null.
assert.strictEqual(store.getTask('nope'), null);

// Lifecycle: running -> done with logs.
const t = store.createTask('node1');
assert.strictEqual(t.status, 'running');
assert.deepStrictEqual(t.logs, []);
store.pushLog(t, 'a');
store.pushLog(t, 'b');
assert.strictEqual(store.getTask('node1'), t);
store.finishTask(t, 'done');
assert.strictEqual(t.status, 'done');
assert.strictEqual(typeof t.finishedAt, 'number');

// Log cap: only the last MAX_LOGS lines survive.
const t2 = store.createTask('node2');
for (let i = 0; i < store.MAX_LOGS + 50; i++) store.pushLog(t2, 'line' + i);
assert.strictEqual(t2.logs.length, store.MAX_LOGS);
assert.strictEqual(t2.logs[0], 'line50');
assert.strictEqual(t2.logs[store.MAX_LOGS - 1], 'line' + (store.MAX_LOGS + 49));

// Running tasks never expire, even when old.
const t3 = store.createTask('node3');
t3.startedAt = Date.now() - store.TTL_MS - 1000;
assert.strictEqual(store.getTask('node3'), t3);

// Finished tasks expire after TTL.
store.finishTask(t3, 'error', 'boom');
t3.finishedAt = Date.now() - store.TTL_MS - 1000;
assert.strictEqual(store.getTask('node3'), null);

// Error payload survives.
const t4 = store.createTask('node4');
store.finishTask(t4, 'error', 'ssh refused');
assert.strictEqual(store.getTask('node4').error, 'ssh refused');

store.clearTasks();
console.log('setup task store tests passed');
