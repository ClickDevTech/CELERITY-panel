/**
 * Panel routes aggregator.
 * Mounts sub-routers for auth, nodes, users, settings, and system.
 */

const express = require('express');
const router = express.Router();

const { checkIpWhitelist, requireAuth, requireOnboarding } = require('./helpers');

const authRoutes = require('./auth');
const wizardRoutes = require('./wizard');
const nodeCronRoutes = require('./nodeCron');
const broadcastRoutes = require('./broadcast');
const nodesRoutes = require('./nodes');
const usersRoutes = require('./users');
const settingsRoutes = require('./settings');
const systemRoutes = require('./system');
const migrationRoutes = require('./migration');
const accessLogsRoutes = require('./accessLogs');
const probesRoutes = require('./probes');

// IP whitelist applies to all panel routes
router.use(checkIpWhitelist);

// Auth routes are public (login, setup, totp, logout)
router.use('/', authRoutes);

// Wizard routes require auth but bypass requireOnboarding (they ARE the onboarding)
router.use('/', requireAuth, wizardRoutes);

// All other routes require authentication and completed onboarding
router.use('/', requireAuth, requireOnboarding, nodeCronRoutes);
router.use('/', requireAuth, requireOnboarding, broadcastRoutes);
router.use('/', requireAuth, requireOnboarding, nodesRoutes);
router.use('/', requireAuth, requireOnboarding, usersRoutes);
router.use('/', requireAuth, requireOnboarding, settingsRoutes);
router.use('/', requireAuth, requireOnboarding, systemRoutes);
router.use('/', requireAuth, requireOnboarding, migrationRoutes);
router.use('/', requireAuth, requireOnboarding, accessLogsRoutes);
router.use('/', requireAuth, requireOnboarding, probesRoutes);

module.exports = router;
