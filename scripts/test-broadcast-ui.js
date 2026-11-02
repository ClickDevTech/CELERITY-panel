const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function assertIncludes(content, expected, label) {
  assert(
    content.includes(expected),
    `${label} should include ${expected}`,
  );
}

const broadcastView = read('views/broadcast-terminal.ejs');
[
  'id="broadcastTabs"',
  'data-mode="terminal"',
  'data-mode="cron"',
  'id="terminalPanel"',
  'id="cronPanel"',
  'id="cronUser"',
  'id="cronRawBlock"',
  'id="btnCronSave"',
  'id="btnCronSaveRun"',
  'id="cronResults"',
  '/panel/broadcast/cron/apply',
  'selectedNodeIds: Array.from(selectedNodeIds)',
  'runNow: runNow === true',
].forEach(expected => assertIncludes(broadcastView, expected, 'broadcast view'));

const nodeSelectorIndex = broadcastView.indexOf('id="nodeSelector"');
const terminalPanelIndex = broadcastView.indexOf('id="terminalPanel"');
const cronPanelIndex = broadcastView.indexOf('id="cronPanel"');
assert(nodeSelectorIndex !== -1, 'broadcast view should include node selector');
assert(
  nodeSelectorIndex < terminalPanelIndex,
  'node selector should appear before terminal panel',
);
assert(
  nodeSelectorIndex < cronPanelIndex,
  'node selector should appear before cron panel',
);
assert(
  /betaBadge:\s*typeof t !== 'undefined' \? t\('network\.betaBadge'\)/.test(broadcastView),
  'broadcast view should use the shared beta badge translation',
);
assertIncludes(broadcastView, 'class="beta-badge"', 'broadcast cron tab');

[
  '/ws/broadcast',
  'type: \'exec\'',
  'type: \'cancel\'',
  'nodeIds: Array.from(selectedNodeIds)',
].forEach(expected => assertIncludes(broadcastView, expected, 'broadcast terminal behavior'));

assert(
  !/insertAdjacentHTML\s*\(/.test(broadcastView),
  'broadcast view should avoid insertAdjacentHTML',
);
assert(
  !/\.innerHTML\s*\+=/.test(broadcastView),
  'broadcast view should avoid appending untrusted HTML',
);

const nodesView = read('views/nodes.ejs');
assertIncludes(nodesView, '/panel/broadcast', 'nodes view');
assert(!nodesView.includes('/panel/broadcast-terminal'), 'nodes view should no longer link to legacy broadcast-terminal path');

const broadcastRoute = read('src/routes/panel/broadcast.js');
assertIncludes(broadcastRoute, "router.get('/broadcast'", 'broadcast route');
assertIncludes(broadcastRoute, "router.get('/broadcast-terminal'", 'broadcast route');
assertIncludes(broadcastRoute, "res.redirect('/panel/broadcast')", 'broadcast route');
assertIncludes(broadcastRoute, "router.post('/broadcast/cron/apply'", 'broadcast route');
assertIncludes(broadcastRoute, "res.render('broadcast-terminal'", 'broadcast route');
assertIncludes(broadcastRoute, ".select('_id name ip type status flag ssh.port ssh.username groups xrayVersion')", 'broadcast route');

[
  'data-mode="jobs"',
  'id="jobsPanel"',
  'id="jobsAction"',
  'id="jobsVersion"',
  'id="jobsPassword"',
  'id="btnJobsPreview"',
  'id="btnJobsStart"',
  'id="btnJobsStop"',
  'id="jobsResults"',
  "const JOBS_BASE = '/panel/broadcast/jobs'",
  "jobsRequest('/xray-releases')",
  "jobsRequest('/status')",
  "'/cancel'",
  "'/preview'",
  "'/start'",
  '/xray-version-task',
  'document.hidden',
  "document.body.classList.toggle('mode-no-terminal'",
].forEach(expected => assertIncludes(broadcastView, expected, 'broadcast jobs tab'));

const jobsPanelIndex = broadcastView.indexOf('id="jobsPanel"');
assert(nodeSelectorIndex < jobsPanelIndex, 'node selector should appear before jobs panel');

[
  "router.get('/broadcast/jobs/xray-releases'",
  "router.get('/broadcast/jobs/status'",
  "router.post('/broadcast/jobs/cancel', jobsCancelLimiter",
  "router.post('/broadcast/jobs/:action/preview', jobsPreviewLimiter",
  "router.post('/broadcast/jobs/:action/start', jobsStartLimiter",
  'reauthenticateXrayVersionChange',
].forEach(expected => assertIncludes(broadcastRoute, expected, 'broadcast jobs route'));

const panelNodesRoute = read('src/routes/panel/nodes.js');
assert(!panelNodesRoute.includes("router.get('/broadcast-terminal'"), 'nodes route should not own broadcast-terminal');

const requiredBroadcastKeys = [
  'title',
  'terminalTab',
  'cronTab',
  'cronTitle',
  'cronUser',
  'cronRawBlock',
  'cronRawPlaceholder',
  'cronSave',
  'cronSaveRun',
  'cronResults',
  'cronSaved',
  'cronSkipped',
  'cronFailed',
  'cronRunFailed',
  'cronSelectNodes',
  'cronEmpty',
  'nodes',
  'selectAll',
  'deselectAll',
  'execute',
  'cancel',
  'summaryTotal',
  'summaryOk',
  'summaryFailed',
  'jobsTab',
  'jobsTitle',
  'jobsSubtitle',
  'jobsActionXray',
  'jobsActionSync',
  'jobsPreview',
  'jobsStart',
  'jobsStop',
  'jobsConfirm',
  'jobsPreviewSummary',
  'jobsStateQueued',
  'jobsStateRunning',
  'jobsStateDone',
  'jobsStateError',
  'jobsStateSkipped',
  'jobsStateCancelled',
  'jobsBatchStopping',
  'jobsStopCanary',
  'jobsStopFailures',
  'jobsShowLog',
];

[
  'src/locales/ru.json',
  'src/locales/en.json',
  'src/locales/zh-CN.json',
].forEach(localePath => {
  const locale = readJson(localePath);
  requiredBroadcastKeys.forEach(key => {
    assert(
      Object.prototype.hasOwnProperty.call(locale.broadcast, key),
      `${localePath} should contain broadcast.${key}`,
    );
  });
});

const packageJson = readJson('package.json');
[
  'node scripts/test-multicast-cron-service.js',
  'node scripts/test-broadcast-panel.js',
  'node scripts/test-broadcast-ui.js',
  'node scripts/test-bulk-actions.js',
].forEach(command => assertIncludes(packageJson.scripts.test, command, 'package npm test script'));

console.log('broadcast UI tests passed');
