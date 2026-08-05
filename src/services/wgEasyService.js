const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const WgPanel = require('../models/wgPanelModel');
const WgProfile = require('../models/wgProfileModel');
const HyUser = require('../models/hyUserModel');
const cryptoService = require('./cryptoService');
const logger = require('../utils/logger');

const REQUEST_TIMEOUT_MS = 12_000;

function normalizeBaseUrl(value) {
    let raw = String(value || '').trim();
    if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
    const url = new URL(raw);
    if (url.username || url.password) throw new Error('Не указывайте логин или пароль в адресе');
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
}

function safeRemoteName(userId) {
    const raw = String(userId).trim();
    const safe = raw.replace(/[^a-zA-Z0-9_.=@+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
    const suffix = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
    return `celerity-${safe || 'user'}-${suffix}`;
}

function errorMessage(error) {
    const status = error.response?.status;
    const detail = error.response?.data?.statusMessage || error.response?.data?.message || error.response?.data?.error;
    return [status ? `HTTP ${status}` : '', detail || error.message].filter(Boolean).join(': ').slice(0, 500);
}

function clientList(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.clients)) return data.clients;
    return [];
}

class WgEasyClient {
    constructor(panel) {
        this.panel = panel;
        this.baseUrl = normalizeBaseUrl(panel.baseUrl);
        this.password = cryptoService.decryptSafe(panel.password);
        this.http = axios.create({
            baseURL: this.baseUrl,
            timeout: REQUEST_TIMEOUT_MS,
            validateStatus: status => status >= 200 && status < 300,
            httpsAgent: new https.Agent({ rejectUnauthorized: panel.rejectUnauthorized !== false }),
            maxRedirects: 3,
        });
        this.version = panel.apiVersion === 'auto' ? (panel.detectedVersion || '') : panel.apiVersion;
        this.cookie = '';
    }

    async authenticate() {
        if (this.version === 'v15') return this.authenticateV15();
        if (this.version === 'v14') return this.authenticateV14();

        if (this.panel.username) {
            try {
                await this.authenticateV15();
                this.version = 'v15';
                return;
            } catch (error) {
                logger.debug(`[WG Easy] v15 detection failed for ${this.panel.name}: ${errorMessage(error)}`);
            }
        }
        await this.authenticateV14();
        this.version = 'v14';
    }

    async authenticateV15() {
        if (!this.panel.username) throw new Error('Для wg-easy v15 требуется логин');
        this.http.defaults.headers.common.Authorization = `Basic ${Buffer.from(`${this.panel.username}:${this.password}`).toString('base64')}`;
        await this.http.get('/api/client');
        this.version = 'v15';
    }

    async authenticateV14() {
        delete this.http.defaults.headers.common.Authorization;
        const response = await this.http.post('/api/session', { password: this.password });
        const cookies = response.headers['set-cookie'] || [];
        this.cookie = cookies.map(value => value.split(';')[0]).join('; ');
        if (this.cookie) this.http.defaults.headers.common.Cookie = this.cookie;
        await this.http.get('/api/wireguard/client');
        this.version = 'v14';
    }

    paths(clientId = '') {
        const id = encodeURIComponent(clientId);
        if (this.version === 'v15') {
            return {
                list: '/api/client', create: '/api/client',
                config: `/api/client/${id}/configuration`,
                enable: `/api/client/${id}/enable`, disable: `/api/client/${id}/disable`,
                remove: `/api/client/${id}`,
            };
        }
        return {
            list: '/api/wireguard/client', create: '/api/wireguard/client',
            config: `/api/wireguard/client/${id}/configuration`,
            enable: `/api/wireguard/client/${id}/enable`, disable: `/api/wireguard/client/${id}/disable`,
            remove: `/api/wireguard/client/${id}`,
        };
    }

    async listClients() {
        return clientList((await this.http.get(this.paths().list)).data);
    }

    async createOrFind(name, expiresAt) {
        let clients = await this.listClients();
        let client = clients.find(item => item.name === name);
        if (client) return client;

        const body = this.version === 'v15'
            ? { name, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null }
            : { name };
        const created = (await this.http.post(this.paths().create, body)).data || {};
        if (created.clientId) return { id: created.clientId, clientId: created.clientId, name };

        clients = await this.listClients();
        client = clients.find(item => item.name === name);
        if (!client) throw new Error('Панель создала клиента, но не вернула его идентификатор');
        return client;
    }

    clientId(client) {
        return String(client.id || client.clientId || client.client_id || '');
    }

    async getConfiguration(clientId) {
        const response = await this.http.get(this.paths(clientId).config, { responseType: 'text' });
        return typeof response.data === 'string' ? response.data : String(response.data || '');
    }

    async setEnabled(clientId, enabled) {
        await this.http.post(enabled ? this.paths(clientId).enable : this.paths(clientId).disable);
    }

    async remove(clientId) {
        await this.http.delete(this.paths(clientId).remove);
    }
}

async function loadPanel(panelOrId) {
    const id = panelOrId?._id || panelOrId;
    const panel = await WgPanel.findById(id).select('+password');
    if (!panel) throw new Error('WG-панель не найдена');
    return panel;
}

async function connect(panelOrId) {
    const panel = await loadPanel(panelOrId);
    const client = new WgEasyClient(panel);
    try {
        await client.authenticate();
        await WgPanel.updateOne({ _id: panel._id }, {
            $set: { detectedVersion: client.version, status: 'online', lastCheckedAt: new Date(), lastError: '' },
        });
        return { panel, client };
    } catch (error) {
        await WgPanel.updateOne({ _id: panel._id }, {
            $set: { status: 'error', lastCheckedAt: new Date(), lastError: errorMessage(error) },
        });
        throw error;
    }
}

async function provisionUserOnPanel(user, panelOrId) {
    const panelId = panelOrId?._id || panelOrId;
    const remoteName = safeRemoteName(user.userId);
    await WgProfile.updateOne(
        { panel: panelId, userId: user.userId },
        { $setOnInsert: { remoteName, status: 'pending' } },
        { upsert: true }
    );

    try {
        const { panel, client } = await connect(panelId);
        const remote = await client.createOrFind(remoteName, user.expireAt);
        const remoteClientId = client.clientId(remote);
        if (!remoteClientId) throw new Error('Панель не вернула ID клиента');
        if (user.enabled === false) await client.setEnabled(remoteClientId, false);
        const configuration = await client.getConfiguration(remoteClientId);
        await WgProfile.updateOne({ panel: panel._id, userId: user.userId }, {
            $set: {
                remoteClientId,
                remoteName,
                configuration: cryptoService.encrypt(configuration),
                status: user.enabled === false ? 'disabled' : 'active',
                lastSyncedAt: new Date(),
                lastError: '',
            },
        });
        return { panelId: String(panel._id), remoteClientId, success: true };
    } catch (error) {
        const message = errorMessage(error);
        await WgProfile.updateOne({ panel: panelId, userId: user.userId }, {
            $set: { remoteName, status: 'error', lastSyncedAt: new Date(), lastError: message },
        }, { upsert: true });
        logger.error(`[WG Easy] Provision ${user.userId}: ${message}`);
        return { panelId: String(panelId), success: false, error: message };
    }
}

async function provisionUser(user) {
    const panels = await WgPanel.find({ enabled: true }).select('_id').lean();
    return Promise.all(panels.map(panel => provisionUserOnPanel(user, panel._id)));
}

async function syncExistingUsers(panelId) {
    const users = await HyUser.find().select('userId enabled expireAt').lean();
    const results = [];
    for (let offset = 0; offset < users.length; offset += 5) {
        const batch = users.slice(offset, offset + 5);
        results.push(...await Promise.all(batch.map(user => provisionUserOnPanel(user, panelId))));
    }
    return results;
}

async function setUserEnabled(userId, enabled) {
    const profiles = await WgProfile.find({ userId, remoteClientId: { $ne: '' } }).lean();
    await Promise.all(profiles.map(async profile => {
        try {
            const { client } = await connect(profile.panel);
            await client.setEnabled(profile.remoteClientId, enabled);
            await WgProfile.updateOne({ _id: profile._id }, { $set: { status: enabled ? 'active' : 'disabled', lastError: '', lastSyncedAt: new Date() } });
        } catch (error) {
            await WgProfile.updateOne({ _id: profile._id }, { $set: { status: 'error', lastError: errorMessage(error), lastSyncedAt: new Date() } });
        }
    }));
    if (enabled) {
        const user = await HyUser.findOne({ userId }).lean();
        if (user) await provisionUser(user);
    }
}

async function removeUser(userId) {
    const profiles = await WgProfile.find({ userId }).lean();
    await Promise.all(profiles.map(async profile => {
        if (profile.remoteClientId) {
            try {
                const { client } = await connect(profile.panel);
                await client.remove(profile.remoteClientId);
            } catch (error) {
                logger.warn(`[WG Easy] Remove ${userId}: ${errorMessage(error)}`);
            }
        }
    }));
    await WgProfile.deleteMany({ userId });
}

async function getConfiguration(profileId, userId = null) {
    const filter = { _id: profileId };
    if (userId) filter.userId = userId;
    const profile = await WgProfile.findOne(filter).select('+configuration').populate('panel', 'name kind enabled').lean();
    if (!profile || !profile.configuration) return null;
    return { profile, configuration: cryptoService.decryptSafe(profile.configuration) };
}

module.exports = {
    WgEasyClient,
    normalizeBaseUrl,
    safeRemoteName,
    connect,
    provisionUser,
    provisionUserOnPanel,
    syncExistingUsers,
    setUserEnabled,
    removeUser,
    getConfiguration,
};
