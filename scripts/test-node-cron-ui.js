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

const managementPartial = read('views/partials/node-form/management.ejs');
assertIncludes(managementPartial, '/panel/nodes/<%= node._id %>/cron', 'management partial');
assertIncludes(managementPartial, "t('nodes.cronTasks')", 'management partial');
assertIncludes(managementPartial, 'class="beta-badge"', 'management partial');
assertIncludes(managementPartial, "t('network.betaBadge')", 'management partial');
assert(
  /node\?\._id\s*&&\s*node\.type\s*!==\s*'virtual'\s*&&\s*node\.type\s*!==\s*'cdn'/.test(managementPartial),
  'management partial should render remote management only for saved non-serverless nodes',
);

const styleCss = read('public/css/style.css');
assertIncludes(styleCss, '.beta-badge', 'global stylesheet');

const cronView = read('views/node-cron.ejs');
[
  '/panel/nodes/<%= node._id %>/cron/data',
  '/panel/nodes/<%= node._id %>/cron/save',
  '/panel/nodes/<%= node._id %>/cron/run',
  '/panel/nodes/<%= node._id %>/cron/service',
  'id="rawCrontab"',
  'name="minute"',
  'name="hour"',
  'name="dayOfMonth"',
  'name="month"',
  'name="dayOfWeek"',
  'name="command"',
  'id="diffPreview"',
  'id="confirmSaveBtn"',
  'data-action="status"',
  'data-action="reload"',
  'data-action="restart"',
].forEach(expected => assertIncludes(cronView, expected, 'node cron view'));

assert(
  !/\.innerHTML\s*=|insertAdjacentHTML\s*\(/.test(cronView),
  'node cron view should avoid unsafe HTML injection APIs',
);
assert(
  /saveCronBtn['"]\)\.addEventListener\('click',\s*showDiff\)/.test(cronView)
    && /confirmSaveBtn['"]\)\.addEventListener\('click',\s*confirmSave\)/.test(cronView)
    && !/saveCronBtn['"]\)\.addEventListener\('click',\s*confirmSave\)/.test(cronView),
  'node cron view should require confirmation before POST save',
);
assertIncludes(cronView, 'error.status === 409 ? labels.conflict : error.message', 'node cron view conflict handling');
assert(
  /body:\s*JSON\.stringify\(\{\s*user:\s*cronUser\.value\.trim\(\)\s*\|\|\s*'root',\s*command,?\s*\}\)/.test(cronView),
  'node cron view should include selected user when running a command now',
);
assert(
  /runCommand\(task\.command\)\.catch\(error\s*=>\s*appendOutput\(error\.message\)\)/.test(cronView),
  'node cron view should display Run now request errors in cron output',
);

const buildDiffMatch = cronView.match(/function buildDiff\(before, after\) \{([\s\S]*?)\n    \}/);
assert(buildDiffMatch, 'node cron view should define buildDiff');
const buildDiffSource = buildDiffMatch[0];
assert(
  !/\.includes\(/.test(buildDiffSource),
  'buildDiff should not use duplicate-unsafe includes checks',
);
assert(
  /lcs|counts|commonLengths|dp/i.test(buildDiffSource),
  'buildDiff should include a duplicate-aware implementation marker',
);
const buildDiff = new Function(`${buildDiffSource}; return buildDiff;`)();
assert.strictEqual(
  buildDiff('same\nsame\nremove\n', 'same\nsame\nadd\n'),
  '- remove\n+ add',
  'buildDiff should preserve duplicate unchanged lines while showing real changes',
);
assert.strictEqual(
  buildDiff('dup\ndup\n', 'dup\n'),
  '- dup',
  'buildDiff should show removal when only one duplicate line is removed',
);
assert.strictEqual(
  buildDiff('dup\n', 'dup\ndup\n'),
  '+ dup',
  'buildDiff should show addition when only one duplicate line is added',
);

[
  'react',
  'vue',
  'angular',
  'svelte',
  'alpine',
  'jquery',
].forEach(framework => {
  assert(
    !new RegExp(`<(script|link)[^>]+${framework}`, 'i').test(cronView),
    `node cron view should not import ${framework}`,
  );
});

const requiredNodeKeys = [
  'cronTasks',
  'cronBackToNode',
  'cronUser',
  'cronServiceStatus',
  'cronServiceStatusButton',
  'cronServiceReload',
  'cronServiceRestart',
  'cronModeTasks',
  'cronModeRaw',
  'cronRawCrontab',
  'cronAddTask',
  'cronMinute',
  'cronHour',
  'cronDayOfMonth',
  'cronMonth',
  'cronDayOfWeek',
  'cronCommand',
  'cronRunNow',
  'cronEdit',
  'cronDelete',
  'cronSave',
  'cronDiffPreview',
  'cronConfirmSave',
  'cronCancel',
  'cronBackupPath',
  'cronConflictReload',
  'cronOutput',
  'cronRawOnly',
  'cronLoad',
  'cronLoading',
  'cronSaved',
  'cronEmptyVirtualTitle',
  'cronEmptyVirtualDesc',
  'cronEmptySshTitle',
  'cronEmptySshDesc',
  'cronEmptySshStep1Title',
  'cronEmptySshStep1Desc',
  'cronEmptySshStep2Title',
  'cronEmptySshStep2Desc',
  'cronEmptySshStep3Title',
  'cronEmptySshStep3Desc',
];

const cronEmptyView = read('views/cron-empty.ejs');
assertIncludes(cronEmptyView, 'cron-empty-card', 'cron empty view');
assertIncludes(cronEmptyView, "t('nodes.cronBackToNode')", 'cron empty view');
assertIncludes(cronEmptyView, "t('common.backToList')", 'cron empty view');
assert(
  /reason\s*===\s*'virtual'\s*\?/.test(cronEmptyView) && /reason\s*===\s*'no-ssh'/.test(cronEmptyView),
  'cron empty view should switch icon and copy based on reason',
);
assert(
  /reason\s*===\s*'no-ssh'[\s\S]+cronEmptySshStep1Title[\s\S]+cronEmptySshStep2Title[\s\S]+cronEmptySshStep3Title/.test(cronEmptyView),
  'cron empty view should render the 3-step SSH guide only for the no-ssh reason',
);
assert(
  /href="\/panel\/nodes\/<%= node\._id %>"/.test(cronEmptyView) && /href="\/panel\/nodes"/.test(cronEmptyView),
  'cron empty view should provide navigation back to the node and to the nodes list',
);
[
  'react',
  'vue',
  'angular',
  'svelte',
  'alpine',
  'jquery',
].forEach(framework => {
  assert(
    !new RegExp(`<(script|link)[^>]+${framework}`, 'i').test(cronEmptyView),
    `cron empty view should not import ${framework}`,
  );
});

[
  'src/locales/ru.json',
  'src/locales/en.json',
  'src/locales/zh-CN.json',
].forEach(localePath => {
  const locale = readJson(localePath);
  requiredNodeKeys.forEach(key => {
    assert(
      Object.prototype.hasOwnProperty.call(locale.nodes, key),
      `${localePath} should contain nodes.${key}`,
    );
  });
});

const packageJson = readJson('package.json');
[
  'node scripts/test-remote-cron-service.js',
  'node scripts/test-node-cron-panel.js',
  'node scripts/test-node-cron-ui.js',
].forEach(command => {
  assertIncludes(packageJson.scripts.test, command, 'package npm test script');
});

console.log('node cron UI tests passed');
