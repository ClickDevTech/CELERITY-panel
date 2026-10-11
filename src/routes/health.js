/**
 * Unauthenticated liveness endpoint for monitoring (Uptime Kuma, cron, LB).
 * Always 200 with a JSON body — `ok:false` signals degradation, never a
 * non-2xx (so uptime checks distinguish "panel down" from "db wobbly").
 */

const express = require('express');
const mongoose = require('mongoose');

const APP_VERSION = require('../../package.json').version;

async function getHealth(req, res) {
    let redis = false;
    try {
        const cacheService = require('../services/cacheService');
        redis = !!cacheService.isConnected();
    } catch { /* report, don't throw */ }
    const mongoState = mongoose.connection?.readyState;
    const body = {
        ok: mongoState === 1,
        version: APP_VERSION,
        uptime: Math.floor(process.uptime()),
        mongo: mongoState === 1 ? 'up' : 'down',
        redis: redis ? 'up' : 'down',
    };
    return res.json(body);
}

const router = express.Router();
router.get('/', getHealth);

module.exports = router;
module.exports.getHealth = getHealth;
