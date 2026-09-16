const crypto = require('crypto');

const { shellQuote } = require('../utils/shell');

const MAX_CRON_BYTES = 64 * 1024;
const MAX_COMMAND_CHARS = 4096;
const MAX_OUTPUT_CHARS = 20000;
const CRON_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/i;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const CRON_MACROS = new Set([
  '@reboot',
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
]);

function normalizeContent(content) {
  return String(content || '').replace(/\r\n?/g, '\n');
}

function hashContent(content) {
  return crypto.createHash('sha256').update(normalizeContent(content)).digest('hex');
}

function validateCronUser(user) {
  if (typeof user !== 'string' || !CRON_USER_RE.test(user)) {
    throw new Error('Invalid cron user');
  }
  return true;
}

function validateCronContent(content) {
  if (typeof content !== 'string') {
    throw new Error('Cron content must be a string');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CRON_BYTES) {
    throw new Error('Cron content must be at most 64 KiB');
  }
  if (content.includes('\0')) {
    throw new Error('Cron content must not contain NUL bytes');
  }

  const normalized = normalizeContent(content);
  const lines = normalized.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (ENV_ASSIGNMENT_RE.test(line)) {
      continue;
    }

    const fields = line.split(/\s+/);
    if (fields[0].startsWith('@')) {
      if (CRON_MACROS.has(fields[0]) && fields.length >= 2) {
        continue;
      }
      throw new Error(`Invalid cron line ${i + 1}`);
    }
    if (fields.length < 6) {
      throw new Error(`Invalid cron line ${i + 1}`);
    }
  }
  return true;
}

function truncateOutput(value) {
  return String(value || '').slice(0, MAX_OUTPUT_CHARS);
}

function getSshUsername(node) {
  return node?.ssh?.username || 'root';
}

function crontabReadCommand(node, user) {
  if (user === getSshUsername(node)) {
    return 'crontab -l';
  }
  if (getSshUsername(node) === 'root') {
    return `crontab -u ${user} -l`;
  }
  return `sudo -n crontab -u ${user} -l`;
}

function crontabInstallCommand(node, user, tempPath) {
  if (user === getSshUsername(node)) {
    return `crontab ${tempPath}`;
  }
  if (getSshUsername(node) === 'root') {
    return `crontab -u ${user} ${tempPath}`;
  }
  return `sudo -n crontab -u ${user} ${tempPath}`;
}

function isMissingCrontab(result) {
  const text = `${result?.stdout || ''}\n${result?.stderr || ''}`.toLowerCase();
  return text.includes('no crontab') || text.includes('no crontab for');
}

function createConflictError() {
  const error = new Error('Cron changed since it was loaded');
  error.statusCode = 409;
  return error;
}

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function createRemoteCronService({ SSHClass, now = () => Date.now() } = {}) {
  const ResolvedSSHClass = SSHClass || require('./nodeSSH');
  const saveLocks = new Map();

  function getNodeLockPart(node) {
    return [
      node?._id || node?.id || '',
      node?.ip || '',
      node?.name || '',
    ].map(value => String(value)).join('|') || 'unknown';
  }

  async function withSaveLock(node, user, callback) {
    const key = `${getNodeLockPart(node)}:${user}`;
    const previous = saveLocks.get(key)?.promise || Promise.resolve();
    let release;
    const currentPromise = new Promise((resolve) => {
      release = resolve;
    });
    const entry = {
      promise: previous.then(() => currentPromise, () => currentPromise),
    };
    saveLocks.set(key, entry);
    await previous.catch(() => {});
    try {
      return await callback();
    } finally {
      release();
      if (saveLocks.get(key) === entry) {
        saveLocks.delete(key);
      }
    }
  }

  async function withSSH(node, callback) {
    const ssh = new ResolvedSSHClass(node);
    await ssh.connect();
    try {
      return await callback(ssh);
    } finally {
      ssh.disconnect();
    }
  }

  async function readCronWithSSH(ssh, node, user) {
    const result = await ssh.exec(crontabReadCommand(node, user));
    if (result.code !== 0) {
      if (isMissingCrontab(result)) {
        return '';
      }
      const error = new Error(result.stderr || result.stdout || 'Failed to read crontab');
      error.statusCode = 502;
      throw error;
    }
    return normalizeContent(result.stdout || '');
  }

  async function getCron(node, user) {
    validateCronUser(user);
    return withSSH(node, async (ssh) => {
      const content = await readCronWithSSH(ssh, node, user);
      return {
        content,
        hash: hashContent(content),
        user,
      };
    });
  }

  async function cleanupTempDir(ssh, tempDir) {
    try {
      await ssh.exec(`rm -rf ${tempDir}`);
    } catch (error) {
      return undefined;
    }
    return undefined;
  }

  function createRemoteError(result, fallbackMessage) {
    const error = new Error(result?.stderr || result?.stdout || fallbackMessage);
    error.statusCode = 502;
    return error;
  }

  async function saveCron(node, user, content, baseHash) {
    validateCronUser(user);
    validateCronContent(content);
    if (typeof baseHash !== 'string' || baseHash.trim() === '') {
      throw createValidationError('Base hash is required');
    }
    const normalized = normalizeContent(content);

    return withSaveLock(node, user, () => withSSH(node, async (ssh) => {
      const currentContent = await readCronWithSSH(ssh, node, user);
      if (hashContent(currentContent) !== baseHash) {
        throw createConflictError();
      }

      const timestamp = now();
      const randomSuffix = crypto.randomBytes(8).toString('hex');
      const backupPath = `/tmp/celerity-cron-backup-${user}-${timestamp}-${crypto.randomBytes(8).toString('hex')}.txt`;
      const tempDir = `/tmp/celerity-cron-${user}-${timestamp}-${randomSuffix}`;
      const tempBase64Path = `${tempDir}/crontab.b64`;
      const tempCronPath = `${tempDir}/crontab.txt`;
      const tempDirResult = await ssh.exec(`umask 077; mkdir -p ${tempDir} && chmod 700 ${tempDir}`);
      if (tempDirResult.code !== 0) {
        const error = new Error(tempDirResult.stderr || tempDirResult.stdout || 'Failed to prepare crontab temp directory');
        error.statusCode = 502;
        throw error;
      }
      try {
        const backupResult = await ssh.exec(`umask 077 && ${crontabReadCommand(node, user)} > ${backupPath}`);
        if (backupResult.code !== 0 && !isMissingCrontab(backupResult)) {
          throw createRemoteError(backupResult, 'Failed to backup crontab');
        }
        await ssh.writeFile(tempBase64Path, Buffer.from(normalized, 'utf8').toString('base64'));

        const installCommand = crontabInstallCommand(node, user, tempCronPath);
        const result = await ssh.exec(`base64 -d < ${tempBase64Path} > ${tempCronPath} && ${installCommand}`);
        if (result.code !== 0) {
          throw createRemoteError(result, 'Failed to install crontab');
        }
      } catch (error) {
        await cleanupTempDir(ssh, tempDir);
        throw error;
      }
      await cleanupTempDir(ssh, tempDir);

      return {
        success: true,
        hash: hashContent(normalized),
        backupPath,
      };
    }));
  }

  async function runCommandNow(node, user, command) {
    validateCronUser(user);
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('Command is required');
    }
    if (command.length > MAX_COMMAND_CHARS) {
      throw new Error('Command must be at most 4096 characters');
    }

    return withSSH(node, async (ssh) => {
      const sshUsername = getSshUsername(node);
      const runCommand = user === sshUsername
        ? `bash -lc ${shellQuote(command)}`
        : `sudo -n -u ${user} bash -lc ${shellQuote(command)}`;
      const result = await ssh.exec(runCommand);
      return {
        code: result.code,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr),
      };
    });
  }

  async function getCronServiceStatus(node) {
    return withSSH(node, async (ssh) => {
      const checked = [];
      for (const service of ['cron', 'crond']) {
        const result = await ssh.exec(`systemctl is-active ${service}`);
        const entry = {
          service,
          active: result.code === 0 && String(result.stdout || '').trim() === 'active',
          code: result.code,
          stdout: String(result.stdout || '').trim(),
          stderr: String(result.stderr || '').trim(),
        };
        checked.push(entry);
        if (entry.active) {
          return {
            service,
            active: true,
            checked,
          };
        }
      }
      return {
        service: null,
        active: false,
        checked,
      };
    });
  }

  async function runServiceAction(node, action) {
    return withSSH(node, async (ssh) => {
      let lastResult = null;
      for (const service of ['cron', 'crond']) {
        const result = await ssh.exec(`sudo -n systemctl ${action} ${service}`);
        lastResult = { service, result };
        if (result.code === 0) {
          return {
            success: true,
            action,
            service,
            code: result.code,
            stdout: String(result.stdout || '').trim(),
            stderr: String(result.stderr || '').trim(),
          };
        }
      }
      return {
        success: false,
        action,
        service: lastResult?.service || null,
        code: lastResult?.result?.code ?? 1,
        stdout: String(lastResult?.result?.stdout || '').trim(),
        stderr: String(lastResult?.result?.stderr || '').trim(),
      };
    });
  }

  return {
    validateCronUser,
    validateCronContent,
    getCron,
    saveCron,
    runCommandNow,
    getCronServiceStatus,
    reloadCronService: (node) => runServiceAction(node, 'reload'),
    restartCronService: (node) => runServiceAction(node, 'restart'),
  };
}

let defaultService;

function getDefaultService() {
  if (!defaultService) {
    defaultService = createRemoteCronService();
  }
  return defaultService;
}

module.exports = {
  createRemoteCronService,
  validateCronUser,
  validateCronContent,
  getCron: (...args) => getDefaultService().getCron(...args),
  saveCron: (...args) => getDefaultService().saveCron(...args),
  runCommandNow: (...args) => getDefaultService().runCommandNow(...args),
  getCronServiceStatus: (...args) => getDefaultService().getCronServiceStatus(...args),
  reloadCronService: (...args) => getDefaultService().reloadCronService(...args),
  restartCronService: (...args) => getDefaultService().restartCronService(...args),
};
