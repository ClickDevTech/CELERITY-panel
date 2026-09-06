const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const HyNode = require('../../models/hyNodeModel');
const remoteCronService = require('../../services/remoteCronService');
const logger = require('../../utils/logger');
const { isServerlessNode } = require('../../utils/nodeTypes');
const { render } = require('./helpers');

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ success: false, error: 'Too many cron requests. Try again in a minute.' });
  },
});

function hasSshCredentials(node) {
  return !!(node?.ssh?.password || node?.ssh?.privateKey);
}

function defaultCronUser(node) {
  return node?.ssh?.username || 'root';
}

function errorMessage(error) {
  return error?.message || 'Internal Server Error';
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.expose = true;
  return error;
}

function conflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.expose = true;
  return error;
}

function safeJsonErrorMessage(error) {
  if (error?.expose) {
    return errorMessage(error);
  }
  return 'Remote cron operation failed';
}

function errorStatus(error, fallback = 500) {
  const status = Number(error?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return status;
  }
  return fallback;
}

function validateCronUser(user) {
  try {
    remoteCronService.validateCronUser(user);
  } catch (error) {
    throw validationError(errorMessage(error));
  }
}

function validateCronContent(content) {
  try {
    remoteCronService.validateCronContent(content);
  } catch (error) {
    throw validationError(errorMessage(error));
  }
}

function validateBaseHash(baseHash) {
  if (typeof baseHash !== 'string' || baseHash.trim() === '') {
    throw validationError('Base hash is required');
  }
}

function validateRunCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw validationError('Command is required');
  }
}

async function loadNodeForJson(req, res, { validateUser = false, user } = {}) {
  const node = await HyNode.findById(req.params.id);
  if (!node) {
    res.status(404).json({ success: false, error: 'Node not found' });
    return null;
  }
  if (isServerlessNode(node)) {
    const error = node.type === 'virtual'
      ? 'Virtual nodes do not support remote cron management'
      : 'This node type does not support remote cron management';
    res.status(400).json({ success: false, error });
    return null;
  }
  if (!hasSshCredentials(node)) {
    res.status(400).json({ success: false, error: 'SSH credentials are required for remote cron management' });
    return null;
  }
  if (validateUser) {
    validateCronUser(user || defaultCronUser(node));
  }
  return node;
}

function sendJsonError(res, error, fallbackStatus = 500) {
  return res.status(errorStatus(error, fallbackStatus)).json({
    success: false,
    error: safeJsonErrorMessage(error),
  });
}

function logCronFailure(level, action, req, error) {
  logger[level]('[PanelCron] Remote cron action failed', {
    action,
    nodeId: req.params.id,
    statusCode: errorStatus(error),
    error: errorMessage(error),
  });
}

router.get('/nodes/:id/cron', async (req, res) => {
  try {
    const node = await HyNode.findById(req.params.id);
    if (!node) {
      return res.redirect('/panel/nodes');
    }
    if (isServerlessNode(node) || !hasSshCredentials(node)) {
      return render(res, 'cron-empty', {
        title: `Cron: ${node.name || node.ip || node._id}`,
        page: 'nodes',
        node,
        reason: node.type === 'virtual' ? 'virtual' : (node.type === 'cdn' ? 'serverless' : 'no-ssh'),
        error: null,
      });
    }

    return render(res, 'node-cron', {
      title: `Cron: ${node.name || node.ip || node._id}`,
      page: 'nodes',
      node,
      defaultCronUser: defaultCronUser(node),
      error: null,
    });
  } catch (error) {
    return res.status(500).send('Error: ' + errorMessage(error));
  }
});

router.get('/nodes/:id/cron/data', async (req, res) => {
  try {
    const node = await loadNodeForJson(req, res, { validateUser: true, user: req.query.user });
    if (!node) return null;

    const user = req.query.user || defaultCronUser(node);
    const [cron, service] = await Promise.all([
      remoteCronService.getCron(node, user),
      remoteCronService.getCronServiceStatus(node),
    ]);
    return res.json({ success: true, cron, service });
  } catch (error) {
    return sendJsonError(res, error, errorMessage(error) === 'Invalid cron user' ? 400 : 500);
  }
});

router.post('/nodes/:id/cron/save', writeLimiter, async (req, res) => {
  try {
    const node = await loadNodeForJson(req, res, { validateUser: true, user: req.body.user });
    if (!node) return null;
    validateCronContent(req.body.content);
    validateBaseHash(req.body.baseHash);

    const result = await remoteCronService.saveCron(
      node,
      req.body.user || defaultCronUser(node),
      req.body.content,
      req.body.baseHash
    );
    return res.json(result);
  } catch (error) {
    if (errorStatus(error) === 409) {
      error = conflictError('Cron changed since it was loaded');
    }
    logCronFailure(errorStatus(error) >= 500 ? 'error' : 'warn', 'save', req, error);
    return sendJsonError(res, error);
  }
});

router.post('/nodes/:id/cron/run', writeLimiter, async (req, res) => {
  try {
    const node = await loadNodeForJson(req, res, { validateUser: true, user: req.body.user });
    if (!node) return null;
    validateRunCommand(req.body.command);

    const result = await remoteCronService.runCommandNow(
      node,
      req.body.user || defaultCronUser(node),
      req.body.command
    );
    return res.json(result);
  } catch (error) {
    logCronFailure(errorStatus(error) >= 500 ? 'error' : 'warn', 'run', req, error);
    return sendJsonError(res, error);
  }
});

router.post('/nodes/:id/cron/service', writeLimiter, async (req, res) => {
  try {
    const node = await loadNodeForJson(req, res);
    if (!node) return null;

    const action = req.body.action;
    if (!['status', 'reload', 'restart'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Invalid service action' });
    }

    const result = action === 'status'
      ? await remoteCronService.getCronServiceStatus(node)
      : action === 'reload'
        ? await remoteCronService.reloadCronService(node)
        : await remoteCronService.restartCronService(node);
    return res.json(result);
  } catch (error) {
    logCronFailure(errorStatus(error) >= 500 ? 'error' : 'warn', 'service', req, error);
    return sendJsonError(res, error);
  }
});

module.exports = router;
