const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const HyNode = require('../../models/hyNodeModel');
const multicastCronService = require('../../services/multicastCronService');
const logger = require('../../utils/logger');

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ success: false, error: 'Too many broadcast cron requests. Try again in a minute.' });
  },
});

function hasSshCredentials(node) {
  return !!(node?.ssh?.password || node?.ssh?.privateKey);
}

function normalizeBroadcastNodes(nodes) {
  const seenIps = new Set();
  const sshNodes = [];
  for (const node of nodes || []) {
    if (node.type === 'virtual' || !node.ip) continue;
    if (seenIps.has(node.ip)) continue;
    seenIps.add(node.ip);
    sshNodes.push({
      _id: node._id,
      name: node.name,
      ip: node.ip,
      type: node.type,
      status: node.status,
      flag: node.flag,
      sshPort: node.ssh?.port || 22,
      sshUsername: node.ssh?.username || 'root',
      groups: node.groups,
    });
  }
  return sshNodes;
}

async function loadBroadcastPageNodes() {
  const nodes = await HyNode.find({
    type: { $nin: ['virtual', 'cdn'] },
    $or: [
      { 'ssh.password': { $exists: true, $ne: '' } },
      { 'ssh.privateKey': { $exists: true, $ne: '' } },
    ],
  })
    .select('_id name ip type status flag ssh.port ssh.username groups')
    .populate('groups', 'name')
    .lean();
  return normalizeBroadcastNodes(nodes);
}

async function loadCronTargetNodes(nodeIds) {
  const requested = new Set(nodeIds.map(id => String(id)));
  const nodes = await HyNode.find({
    _id: { $in: nodeIds },
    type: { $nin: ['virtual', 'cdn'] },
    $or: [
      { 'ssh.password': { $exists: true, $ne: '' } },
      { 'ssh.privateKey': { $exists: true, $ne: '' } },
    ],
  }).lean();

  const seenIps = new Set();
  return (nodes || []).filter((node) => {
    if (!requested.has(String(node._id))) return false;
    if (node.type === 'virtual' || !node.ip || !hasSshCredentials(node)) return false;
    if (seenIps.has(node.ip)) return false;
    seenIps.add(node.ip);
    return true;
  });
}

function sendJsonError(res, error, fallbackStatus = 500) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : fallbackStatus;
  return res.status(status).json({
    success: false,
    error: error?.expose ? error.message : (status < 500 ? error.message : 'Broadcast cron operation failed'),
  });
}

function isValidObjectId(value) {
  return /^[a-f0-9]{24}$/i.test(String(value || ''));
}

router.get('/broadcast', async (_req, res) => {
  try {
    const nodes = await loadBroadcastPageNodes();
    return res.render('broadcast-terminal', { nodes });
  } catch (error) {
    return res.status(500).send('Error: ' + error.message);
  }
});

router.get('/broadcast-terminal', (_req, res) => {
  res.redirect('/panel/broadcast');
});

router.post('/broadcast/cron/apply', writeLimiter, async (req, res) => {
  try {
    const nodeIds = Array.isArray(req.body.nodeIds) ? req.body.nodeIds.filter(Boolean) : [];
    if (nodeIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Select at least one node' });
    }
    if (!nodeIds.every(isValidObjectId)) {
      return res.status(400).json({ success: false, error: 'Invalid node id' });
    }

    const content = typeof req.body.content === 'string' ? req.body.content : '';
    const user = req.body.user || 'root';
    const runNow = req.body.runNow === true;
    const nodes = await loadCronTargetNodes(nodeIds);
    if (nodes.length === 0) {
      return res.status(400).json({ success: false, error: 'No nodes with SSH credentials found' });
    }

    const result = await multicastCronService.applyCronBlockToNodes(nodes, { user, content, runNow });
    logger.info('[PanelBroadcast] Multicast cron applied', {
      requested: nodeIds.length,
      targeted: nodes.length,
      total: result.summary.total,
      saved: result.summary.saved,
      skipped: result.summary.skipped,
      failed: result.summary.failed,
      runFailed: result.summary.runFailed,
    });
    return res.json(result);
  } catch (error) {
    logger.warn('[PanelBroadcast] Multicast cron failed', { error: error.message });
    return sendJsonError(res, error);
  }
});

module.exports = router;
