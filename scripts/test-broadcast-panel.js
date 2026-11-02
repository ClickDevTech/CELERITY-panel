const assert = require('assert');
const express = require('express');
const Module = require('module');

const originalLoad = Module._load;

let dbNodes = [];
const findCalls = [];
const rendered = [];
const serviceCalls = [];
let findError = null;
const id1 = '64f000000000000000000001';
const id2 = '64f000000000000000000002';
const id3 = '64f000000000000000000003';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const HyNode = {
  find: (filter) => {
    findCalls.push({ method: 'find', filter });
    return {
      select(fields) {
        findCalls.push({ method: 'select', fields });
        return this;
      },
      populate(path, fields) {
        findCalls.push({ method: 'populate', path, fields });
        return this;
      },
      lean: async () => {
        if (findError) throw findError;
        return clone(dbNodes);
      },
    };
  },
};

const multicastCronService = {
  applyCronBlockToNodes: async (nodes, options) => {
    serviceCalls.push({ nodes: clone(nodes), options: clone(options) });
    if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(String(options.user || ''))) {
      const error = new Error('Invalid cron user');
      error.statusCode = 400;
      error.expose = true;
      throw error;
    }
    if (String(options.content || '').includes('bad cron')) {
      const error = new Error('Invalid cron line 1');
      error.statusCode = 400;
      error.expose = true;
      throw error;
    }
    return {
      success: true,
      summary: { total: nodes.length, saved: nodes.length, skipped: 0, failed: 0, runFailed: 0 },
      results: nodes.map(node => ({ nodeId: String(node._id), success: true, saved: true, runNow: [] })),
    };
  },
};

let adminTwoFactor = false;
const Admin = {
  findOne: () => ({
    select() { return this; },
    lean: async () => ({ twoFactor: { enabled: adminTwoFactor } }),
  }),
};

const bulkCalls = [];
const bulkActionService = {
  MAX_NODES: 200,
  listActions: () => [{ id: 'xray_version', requiresReauth: true }, { id: 'sync', requiresReauth: false }],
  getAction(action) {
    if (action === 'xray_version') return { requiresReauth: true };
    if (action === 'sync') return { requiresReauth: false };
    const error = new Error('Unknown bulk action');
    error.statusCode = 400;
    error.expose = true;
    throw error;
  },
  preview: async (args) => {
    bulkCalls.push({ op: 'preview', args: clone(args) });
    return { action: args.action, ready: 1, skipped: 0, items: [] };
  },
  start: async (args) => {
    bulkCalls.push({ op: 'start', args: clone(args) });
    return { state: 'running', action: args.action };
  },
  cancel: (actor) => {
    bulkCalls.push({ op: 'cancel', actor });
    const error = new Error('No bulk action is running');
    error.statusCode = 409;
    error.expose = true;
    throw error;
  },
  status: () => ({ state: 'idle' }),
};

let reauthResult = true;
const reauthCalls = [];

const stubs = {
  '../../models/adminModel': Admin,
  '../../models/hyNodeModel': HyNode,
  '../../services/multicastCronService': multicastCronService,
  '../../services/bulkActionService': bulkActionService,
  '../../services/xrayVersionService': {
    getVersionInfo: async () => ({ releases: [{ version: '26.7.28', prerelease: false }], error: null }),
  },
  '../../utils/logger': {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  './helpers': {
    render: (res, template, data) => {
      rendered.push({ template, data: clone(data) });
      res.rendered = { template, data };
      return res;
    },
    checkIpWhitelist: (_req, _res, next) => next(),
    requireAuth: (_req, _res, next) => next(),
    requireOnboarding: (_req, _res, next) => next(),
    reauthenticateXrayVersionChange: async (req, res) => {
      reauthCalls.push(clone(req.body));
      if (!reauthResult) {
        res.status(401).json({ error: 'Invalid current password' });
        return false;
      }
      return true;
    },
  },
  './auth': express.Router(),
  './wizard': express.Router(),
  './nodeCron': express.Router(),
  './nodes': express.Router(),
  './users': express.Router(),
  './settings': express.Router(),
  './system': express.Router(),
  './migration': express.Router(),
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) {
    return stubs[request];
  }
  return originalLoad.call(this, request, parent, isMain);
};

const broadcastRouter = require('../src/routes/panel/broadcast');
const panelRouter = require('../src/routes/panel');
Module._load = originalLoad;

function reset() {
  dbNodes = [];
  findCalls.length = 0;
  rendered.length = 0;
  serviceCalls.length = 0;
  findError = null;
  bulkCalls.length = 0;
  reauthCalls.length = 0;
  reauthResult = true;
  adminTwoFactor = false;
}

function findRoute(router, method, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route?.methods?.[method]);
  assert(layer, `${method.toUpperCase()} ${path} route exists`);
  return layer.route.stack.map(item => item.handle);
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    redirectedTo: null,
    rendered: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    render(template, data) {
      rendered.push({ template, data: clone(data) });
      this.rendered = { template, data };
      return this;
    },
    redirect(target) {
      this.redirectedTo = target;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
  };
}

async function runRoute(method, path, { body = {}, params = {} } = {}) {
  const handlers = findRoute(broadcastRouter, method, path);
  const handler = handlers[handlers.length - 1];
  const req = {
    body,
    params,
    ip: '127.0.0.1',
    session: { adminUsername: 'root-admin' },
    get: () => undefined,
  };
  const res = makeRes();
  await handler(req, res, () => {});
  return res;
}

(async () => {
  assert(findRoute(broadcastRouter, 'get', '/broadcast'));
  assert(findRoute(broadcastRouter, 'get', '/broadcast-terminal'));
  assert(findRoute(broadcastRouter, 'post', '/broadcast/cron/apply').length > 1, 'cron apply route has local rate limiter');
  assert(panelRouter.stack.some(layer => layer.name === 'router' && layer.handle === broadcastRouter), 'panel index mounts broadcast router');

  reset();
  dbNodes = [
    { _id: id1, name: 'Alpha', ip: '10.0.0.1', type: 'xray', status: 'online', flag: '🇳🇱', ssh: { port: 2222, username: 'admin' }, groups: [{ name: 'A' }] },
    { _id: id2, name: 'Duplicate', ip: '10.0.0.1', type: 'hysteria', status: 'online', ssh: { username: 'root' }, groups: [] },
    { _id: id3, name: 'Beta', ip: '10.0.0.2', type: 'hysteria', status: 'offline', ssh: { privateKey: 'key' }, groups: [] },
    { _id: 'v1', name: 'Virtual', ip: null, type: 'virtual', status: 'online', ssh: { username: 'root' }, groups: [] },
  ];
  let res = await runRoute('get', '/broadcast');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rendered[0].template, 'broadcast-terminal');
  assert.deepStrictEqual(findCalls[0], {
    method: 'find',
    filter: {
      type: { $nin: ['virtual', 'cdn'] },
      $or: [
        { 'ssh.password': { $exists: true, $ne: '' } },
        { 'ssh.privateKey': { $exists: true, $ne: '' } },
      ],
    },
  });
  assert.deepStrictEqual(findCalls[1], { method: 'select', fields: '_id name ip type status flag ssh.port ssh.username groups xrayVersion' });
  assert.deepStrictEqual(rendered[0].data.bulkActions.map(action => action.id), ['xray_version', 'sync']);
  assert.strictEqual(rendered[0].data.totpEnabled, false);
  assert.deepStrictEqual(findCalls[2], { method: 'populate', path: 'groups', fields: 'name' });
  assert.deepStrictEqual(rendered[0].data.nodes.map(node => node._id), [id1, id3]);
  assert.strictEqual(rendered[0].data.nodes[0].sshPort, 2222);
  assert.strictEqual(rendered[0].data.nodes[0].sshUsername, 'admin');
  assert.strictEqual(rendered[0].data.nodes[1].sshPort, 22);
  assert.strictEqual(rendered[0].data.nodes[1].sshUsername, 'root');

  reset();
  res = await runRoute('get', '/broadcast-terminal');
  assert.strictEqual(res.redirectedTo, '/panel/broadcast');

  reset();
  findError = new Error('database unavailable');
  res = await runRoute('get', '/broadcast');
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body, 'Error: database unavailable');

  reset();
  dbNodes = [
    { _id: id1, name: 'Alpha', ip: '10.0.0.1', type: 'xray', ssh: { password: 'secret', username: 'root' } },
    { _id: id2, name: 'Beta', ip: '10.0.0.2', type: 'hysteria', ssh: { privateKey: 'key', username: 'deploy' } },
    { _id: id3, name: 'No SSH', ip: '10.0.0.3', type: 'xray', ssh: { username: 'root' } },
  ];
  res = await runRoute('post', '/broadcast/cron/apply', {
    body: {
      nodeIds: [id1, id2, id3],
      user: 'root',
      content: '*/5 * * * * /opt/job\n',
      runNow: true,
    },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(serviceCalls.length, 1);
  assert.deepStrictEqual(serviceCalls[0].nodes.map(node => node._id), [id1, id2]);
  assert.deepStrictEqual(serviceCalls[0].options, {
    user: 'root',
    content: '*/5 * * * * /opt/job\n',
    runNow: true,
  });
  assert.strictEqual(res.body.success, true);

  reset();
  res = await runRoute('post', '/broadcast/cron/apply', {
    body: {
      nodeIds: [],
      user: 'root',
      content: '* * * * * /opt/job\n',
    },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { success: false, error: 'Select at least one node' });

  reset();
  res = await runRoute('post', '/broadcast/cron/apply', {
    body: {
      nodeIds: ['not-an-object-id'],
      user: 'root',
      content: '* * * * * /opt/job\n',
    },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { success: false, error: 'Invalid node id' });

  reset();
  dbNodes = [{ _id: id1, name: 'Alpha', ip: '10.0.0.1', type: 'xray', ssh: { password: 'secret' } }];
  res = await runRoute('post', '/broadcast/cron/apply', {
    body: {
      nodeIds: [id1],
      user: 'bad user',
      content: '* * * * * /opt/job\n',
    },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { success: false, error: 'Invalid cron user' });

  reset();
  dbNodes = [{ _id: id1, name: 'Alpha', ip: '10.0.0.1', type: 'xray', ssh: { password: 'secret' } }];
  res = await runRoute('post', '/broadcast/cron/apply', {
    body: {
      nodeIds: [id1],
      user: 'root',
      content: 'bad cron',
    },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { success: false, error: 'Invalid cron line 1' });

  // Bulk jobs: every write route carries its own limiter.
  assert(findRoute(broadcastRouter, 'post', '/broadcast/jobs/:action/preview').length > 1, 'jobs preview has a limiter');
  assert(findRoute(broadcastRouter, 'post', '/broadcast/jobs/:action/start').length > 1, 'jobs start has a limiter');
  assert(findRoute(broadcastRouter, 'post', '/broadcast/jobs/cancel').length > 1, 'jobs cancel has a limiter');
  assert(findRoute(broadcastRouter, 'get', '/broadcast/jobs/status'));
  assert(findRoute(broadcastRouter, 'get', '/broadcast/jobs/xray-releases'));

  reset();
  res = await runRoute('post', '/broadcast/jobs/:action/preview', {
    params: { action: 'xray_version' },
    body: { nodeIds: [id1], version: '26.7.28' },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(bulkCalls[0].args, { action: 'xray_version', nodeIds: [id1], params: { version: '26.7.28' } });
  assert.strictEqual(reauthCalls.length, 0, 'preview never asks for credentials');

  // Xray start requires re-authentication and never reaches the service on failure.
  reset();
  reauthResult = false;
  res = await runRoute('post', '/broadcast/jobs/:action/start', {
    params: { action: 'xray_version' },
    body: { nodeIds: [id1], version: '26.7.28', currentPassword: 'bad' },
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(bulkCalls.length, 0);

  reset();
  res = await runRoute('post', '/broadcast/jobs/:action/start', {
    params: { action: 'xray_version' },
    body: { nodeIds: [id1], version: '26.7.28', currentPassword: 'good', totpToken: '123456' },
  });
  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(reauthCalls.length, 1);
  assert.strictEqual(bulkCalls[0].args.actor, 'admin:root-admin (IP: 127.0.0.1)');
  assert.strictEqual(bulkCalls[0].args.currentPassword, undefined, 'credentials are not passed to the service');

  // Sync start needs no credentials.
  reset();
  res = await runRoute('post', '/broadcast/jobs/:action/start', { params: { action: 'sync' }, body: { nodeIds: [id1] } });
  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(reauthCalls.length, 0);

  reset();
  res = await runRoute('post', '/broadcast/jobs/:action/start', { params: { action: 'evil' }, body: { nodeIds: [id1] } });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { success: false, error: 'Unknown bulk action' });
  assert.strictEqual(reauthCalls.length, 0);

  reset();
  res = await runRoute('post', '/broadcast/jobs/cancel');
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(bulkCalls[0].actor, 'admin:root-admin (IP: 127.0.0.1)');

  reset();
  res = await runRoute('get', '/broadcast/jobs/status');
  assert.deepStrictEqual(res.body, { state: 'idle' });

  console.log('broadcast panel tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
