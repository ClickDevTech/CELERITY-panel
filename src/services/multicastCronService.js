const remoteCronServiceDefault = require('./remoteCronService');
const { mapLimit } = require('../utils/mapLimit');

const MANAGED_BEGIN = '# BEGIN C3 CELERITY MULTICAST CRON';
const MANAGED_END = '# END C3 CELERITY MULTICAST CRON';
const DEFAULT_CONCURRENCY = 3;

function normalizeContent(content) {
  return String(content || '').replace(/\r\n?/g, '\n');
}

function ensureTrailingNewline(content) {
  return content && !content.endsWith('\n') ? `${content}\n` : content;
}

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.expose = true;
  return error;
}

function validateManagedMarkers(content) {
  if (content.includes(MANAGED_BEGIN) || content.includes(MANAGED_END)) {
    throw createValidationError('Raw cron content must not include managed cron markers');
  }
}

function markerIndexes(lines) {
  const begins = [];
  const ends = [];
  lines.forEach((line, index) => {
    if (line.trim() === MANAGED_BEGIN) begins.push(index);
    if (line.trim() === MANAGED_END) ends.push(index);
  });
  if (begins.length !== ends.length || begins.length > 1) {
    throw createValidationError('Invalid managed cron block markers');
  }
  if (begins.length === 1 && begins[0] >= ends[0]) {
    throw createValidationError('Invalid managed cron block markers');
  }
  return begins.length === 1 ? { begin: begins[0], end: ends[0] } : null;
}

function compactBlankLines(content) {
  return content.replace(/\n{3,}/g, '\n\n');
}

function replaceManagedBlock(currentContent, blockContent) {
  const current = normalizeContent(currentContent);
  const block = normalizeContent(blockContent).trim();
  validateManagedMarkers(block);

  const lines = current.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const indexes = markerIndexes(lines);

  const replacement = block
    ? [MANAGED_BEGIN, ...block.split('\n'), MANAGED_END]
    : [];
  const nextLines = indexes
    ? [...lines.slice(0, indexes.begin), ...replacement, ...lines.slice(indexes.end + 1)]
    : [...lines, ...replacement];

  return ensureTrailingNewline(compactBlankLines(nextLines.join('\n').trim()));
}

function extractRunnableCommands(content) {
  const commands = [];
  normalizeContent(content).split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(line)) {
      return;
    }

    if (line.startsWith('@')) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        commands.push(line.slice(parts[0].length).trim());
      }
      return;
    }

    const parts = line.split(/\s+/);
    if (parts.length >= 6) {
      commands.push(parts.slice(5).join(' '));
    }
  });
  return commands;
}

function safeNodeResult(node, extra) {
  return {
    nodeId: String(node?._id || ''),
    name: node?.name || '',
    ip: node?.ip || '',
    ...extra,
  };
}

function createMulticastCronService({ remoteCronService = remoteCronServiceDefault, concurrency = DEFAULT_CONCURRENCY } = {}) {
  async function applyOneNode(node, options, runnableCommands) {
    try {
      const cron = await remoteCronService.getCron(node, options.user);
      const nextContent = replaceManagedBlock(cron.content, options.content);
      const changed = normalizeContent(cron.content) !== nextContent;
      let saveResult = null;

      if (changed) {
        saveResult = await remoteCronService.saveCron(node, options.user, nextContent, cron.hash);
      }

      const runNow = [];
      if (options.runNow) {
        for (const command of runnableCommands) {
          try {
            const result = await remoteCronService.runCommandNow(node, options.user, command);
            runNow.push({ command, success: result.code === 0, ...result });
          } catch (error) {
            runNow.push({ command, success: false, error: error.message || 'Run failed' });
          }
        }
      }

      return safeNodeResult(node, {
        success: runNow.every(result => result.success !== false),
        saved: changed,
        skipped: !changed,
        hash: saveResult?.hash || cron.hash,
        backupPath: saveResult?.backupPath || null,
        runNow,
      });
    } catch (error) {
      return safeNodeResult(node, {
        success: false,
        saved: false,
        skipped: false,
        error: error.message || 'Cron operation failed',
        runNow: [],
      });
    }
  }

  async function applyCronBlockToNodes(nodes, options = {}) {
    const user = options.user || 'root';
    const content = normalizeContent(options.content);
    try {
      remoteCronService.validateCronUser(user);
      validateManagedMarkers(content);
      remoteCronService.validateCronContent(content);
    } catch (error) {
      throw createValidationError(error.message || 'Invalid cron input');
    }

    const runnableCommands = extractRunnableCommands(content);
    const results = await mapLimit(nodes, concurrency, (node) => (
      applyOneNode(node, { user, content, runNow: !!options.runNow }, runnableCommands)
    ));

    const summary = results.reduce((acc, result) => {
      acc.total += 1;
      if (result.saved) acc.saved += 1;
      if (result.skipped) acc.skipped += 1;
      if (!result.success) acc.failed += 1;
      if (result.runNow?.some(item => item.success === false)) acc.runFailed += 1;
      return acc;
    }, { total: 0, saved: 0, skipped: 0, failed: 0, runFailed: 0 });

    return {
      success: summary.failed === 0,
      summary,
      results,
    };
  }

  return { applyCronBlockToNodes };
}

const defaultService = createMulticastCronService();

module.exports = {
  MANAGED_BEGIN,
  MANAGED_END,
  createMulticastCronService,
  extractRunnableCommands,
  replaceManagedBlock,
  applyCronBlockToNodes: (...args) => defaultService.applyCronBlockToNodes(...args),
};
