const express = require('express');
const router = express.Router();
const WgPanel = require('../../models/wgPanelModel');
const WgProfile = require('../../models/wgProfileModel');
const HyNode = require('../../models/hyNodeModel');
const CascadeLink = require('../../models/cascadeLinkModel');
const cryptoService = require('../../services/cryptoService');
const wgEasyService = require('../../services/wgEasyService');
const logger = require('../../utils/logger');
const { getCountryOptions, normalizeCountryCode, countryCodeToFlag } = require('../../utils/country');
const { render } = require('./helpers');

function translate(res, key, replacements = {}) {
    let value = res.locals.t?.(key) || key;
    Object.entries(replacements).forEach(([name, replacement]) => {
        value = value.replaceAll(`{${name}}`, String(replacement));
    });
    return value;
}

function localizeServiceError(res, error) {
    const errorKeys = {
        'Для wg-easy v15 требуется логин': 'loginRequiredV15',
        'WG-панель не найдена': 'panelNotFound',
        'Не указывайте логин или пароль в адресе': 'credentialsInAddress',
        'Панель создала клиента, но не вернула его идентификатор': 'createdClientMissingId',
        'Панель не вернула ID клиента': 'clientIdMissing',
    };
    if (errorKeys[error.message]) return translate(res, `wgPanels.${errorKeys[error.message]}`);
    return error.message;
}

function panelPayload(body, existing = null) {
    const apiVersion = ['auto', 'v14', 'v15'].includes(body.apiVersion) ? body.apiVersion : 'auto';
    const kind = body.kind === 'awg-easy' ? 'awg-easy' : 'wg-easy';
    return {
        name: String(body.name || '').trim(),
        kind,
        baseUrl: wgEasyService.normalizeBaseUrl(body.baseUrl),
        country: normalizeCountryCode(body.country),
        username: String(body.username || '').trim(),
        apiVersion,
        rejectUnauthorized: body.rejectUnauthorized === 'on',
        enabled: body.enabled === 'on',
        detectedVersion: existing && existing.apiVersion === apiVersion ? existing.detectedVersion : '',
        status: 'unknown',
        lastError: '',
    };
}

async function renderPanelForm(res, { panel = null, error = '' } = {}) {
    return render(res, 'wg-panel-form', {
        title: translate(res, panel?._id ? 'wgPanels.edit' : 'wgPanels.add'),
        page: 'wg-panels',
        panel,
        countryOptions: getCountryOptions(res.locals.lang),
        error,
    });
}

router.get('/wg-panels', async (req, res) => {
    try {
        const [panels, counts, nodesCount, linksCount] = await Promise.all([
            WgPanel.find().sort({ createdAt: -1 }).lean(),
            WgProfile.aggregate([{ $group: { _id: '$panel', count: { $sum: 1 }, errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } } } }]),
            HyNode.countDocuments(),
            CascadeLink.countDocuments({ active: true }),
        ]);
        const countMap = new Map(counts.map(item => [String(item._id), item]));
        render(res, 'wg-panels', {
            title: translate(res, 'wgPanels.title'), page: 'wg-panels', panels,
            counts: countMap, nodesCount, linksCount, countryCodeToFlag,
            message: req.query.message || '', error: req.query.error || '',
        });
    } catch (error) {
        res.status(500).send(`${translate(res, 'common.error')}: ${error.message}`);
    }
});

router.get('/wg-panels/add', async (req, res) => {
    return renderPanelForm(res);
});

router.get('/wg-panels/:id/edit', async (req, res) => {
    try {
        const panel = await WgPanel.findById(req.params.id).lean();
        if (!panel) return res.redirect('/panel/wg-panels');
        return renderPanelForm(res, { panel });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

router.post('/wg-panels', async (req, res) => {
    try {
        if (!req.body.name || !req.body.baseUrl || !req.body.password) {
            return renderPanelForm(res.status(400), {
                panel: { ...req.body, enabled: req.body.enabled === 'on', rejectUnauthorized: req.body.rejectUnauthorized === 'on', syncExisting: req.body.syncExisting === 'on' },
                error: translate(res, 'wgPanels.requiredFields'),
            });
        }
        const payload = panelPayload(req.body);
        payload.password = cryptoService.encrypt(req.body.password);
        const panel = await WgPanel.create(payload);
        try {
            await wgEasyService.connect(panel._id);
        } catch (error) {
            logger.warn(`[WG Easy] New panel test failed: ${error.message}`);
        }
        if (req.body.syncExisting === 'on') {
            await wgEasyService.syncExistingUsers(panel._id);
        }
        res.redirect('/panel/wg-panels?message=' + encodeURIComponent(translate(res, 'wgPanels.added')));
    } catch (error) {
        const message = error.code === 11000 ? translate(res, 'wgPanels.duplicateAddress') : localizeServiceError(res, error);
        return renderPanelForm(res.status(error.code === 11000 ? 409 : 400), {
            panel: { ...req.body, enabled: req.body.enabled === 'on', rejectUnauthorized: req.body.rejectUnauthorized === 'on', syncExisting: req.body.syncExisting === 'on' },
            error: message,
        });
    }
});

router.post('/wg-panels/:id', async (req, res) => {
    try {
        const current = await WgPanel.findById(req.params.id).select('+password');
        if (!current) return res.redirect('/panel/wg-panels');
        const payload = panelPayload(req.body, current);
        if (req.body.password) payload.password = cryptoService.encrypt(req.body.password);
        await WgPanel.updateOne({ _id: current._id }, { $set: payload });
        res.redirect('/panel/wg-panels?message=' + encodeURIComponent(translate(res, 'wgPanels.saved')));
    } catch (error) {
        const current = await WgPanel.findById(req.params.id).lean().catch(() => null);
        return renderPanelForm(res.status(400), {
            panel: { ...(current || {}), ...req.body, _id: req.params.id, enabled: req.body.enabled === 'on', rejectUnauthorized: req.body.rejectUnauthorized === 'on' },
            error: localizeServiceError(res, error),
        });
    }
});

router.post('/wg-panels/:id/test', async (req, res) => {
    try {
        const { client } = await wgEasyService.connect(req.params.id);
        const clients = await client.listClients();
        res.redirect('/panel/wg-panels?message=' + encodeURIComponent(translate(res, 'wgPanels.connectionSuccess', {
            api: client.version,
            count: clients.length,
        })));
    } catch (error) {
        res.redirect('/panel/wg-panels?error=' + encodeURIComponent(translate(res, 'wgPanels.connectionError', {
            error: localizeServiceError(res, error),
        })));
    }
});

router.post('/wg-panels/:id/sync', async (req, res) => {
    try {
        const results = await wgEasyService.syncExistingUsers(req.params.id);
        const failed = results.filter(item => !item.success).length;
        res.redirect('/panel/wg-panels?message=' + encodeURIComponent(translate(res, 'wgPanels.syncResult', {
            success: results.length - failed,
            failed,
        })));
    } catch (error) {
        res.redirect('/panel/wg-panels?error=' + encodeURIComponent(localizeServiceError(res, error)));
    }
});

router.post('/wg-panels/:id/delete', async (req, res) => {
    try {
        await Promise.all([
            WgProfile.deleteMany({ panel: req.params.id }),
            WgPanel.findByIdAndDelete(req.params.id),
        ]);
        res.redirect('/panel/wg-panels?message=' + encodeURIComponent(translate(res, 'wgPanels.deleted')));
    } catch (error) {
        res.redirect('/panel/wg-panels?error=' + encodeURIComponent(localizeServiceError(res, error)));
    }
});

router.get('/wg-profiles/:id/download', async (req, res) => {
    try {
        const result = await wgEasyService.getConfiguration(req.params.id);
        if (!result) return res.status(404).send(translate(res, 'wgPanels.profileNotFound'));
        const filename = `${result.profile.remoteName}.conf`.replace(/[^a-zA-Z0-9_.-]/g, '-');
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(result.configuration);
    } catch (error) {
        res.status(500).send(`${translate(res, 'common.error')}: ${localizeServiceError(res, error)}`);
    }
});

module.exports = router;
