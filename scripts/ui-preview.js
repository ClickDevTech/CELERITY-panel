/**
 * C³ CELERITY — UI preview server (DEV ONLY, no DB needed).
 *
 * Renders EJS pages with mock data so the redesigned UI can be reviewed
 * without MongoDB/Redis. Never use in production.
 *
 * Run:  node scripts/ui-preview.js [port]
 * Open: http://localhost:3100/panel
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const ejs = require('ejs');

const PORT = parseInt(process.argv[2], 10) || 3100;
const VIEWS = path.join(__dirname, '..', 'views');
const PUBLIC = path.join(__dirname, '..', 'public');

// --- Mock i18n: last key segment, prettified ---
function t(key) {
    if (!key) return '';
    const last = String(key).split('.').pop();
    return last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function formatTraffic(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

const baseVars = {
    t,
    lang: 'ru',
    languageOptions: [
        { code: 'ru', label: 'RU' },
        { code: 'en', label: 'EN' },
    ],
    supportedLangs: ['ru', 'en'],
    accessLogsEnabled: true,
    probesEnabled: true,
    appVersion: '1.6.16-preview',
    baseUrl: 'http://localhost:' + PORT,
    formatTraffic,
};

const mockNodes = [
    { _id: 'mock1', name: 'DE-1 Frankfurt', ip: '185.10.10.1', status: 'online', onlineUsers: 42, maxOnlineUsers: 200, type: 'hysteria', flag: '🇩🇪', comment: 'Main EU entry', groups: [{ name: 'Europe', color: '#6366f1' }] },
    { _id: 'mock2', name: 'NL-2 Amsterdam', ip: '185.10.10.2', status: 'online', onlineUsers: 17, maxOnlineUsers: 0, type: 'xray', flag: '🇳🇱', comment: '', groups: [{ name: 'Europe', color: '#6366f1' }] },
    { _id: 'mock3', name: 'FI-1 Helsinki', ip: '185.10.10.3', status: 'offline', onlineUsers: 0, maxOnlineUsers: 100, type: 'xray', flag: '🇫🇮', comment: 'Maintenance', groups: [] },
];

const mockStats = {
    users: { total: 128, enabled: 121 },
    nodes: { total: 3, online: 2 },
    onlineUsers: 59,
    traffic: { tx: 412345678901, rx: 1234567890123, total: 1646913569024 },
};

function renderPage(template, data, title, page) {
    const innerPath = path.join(VIEWS, template + '.ejs');
    const inner = ejs.compile(fs.readFileSync(innerPath, 'utf8'), { filename: innerPath });
    const vars = { ...baseVars, ...data, title, page };
    const content = inner(vars);
    const layoutPath = path.join(VIEWS, 'layout.ejs');
    const layout = ejs.compile(fs.readFileSync(layoutPath, 'utf8'), { filename: layoutPath });
    return layout({ ...vars, content });
}

const app = express();
app.use('/css', express.static(path.join(PUBLIC, 'css')));
app.use('/js', express.static(path.join(PUBLIC, 'js')));
app.use('/img', express.static(path.join(PUBLIC, 'img')));
app.use(express.static(PUBLIC));

app.get('/', (req, res) => res.redirect('/panel'));

app.get('/panel', (req, res) => {
    try {
        res.send(renderPage('dashboard', { stats: mockStats, nodes: mockNodes }, 'Dashboard', 'dashboard'));
    } catch (e) {
        res.status(500).send('<pre>Preview render error (dashboard): ' + String(e.message) + '</pre>');
    }
});

// Any other panel page: best-effort with empty mocks (shares new layout/css/js)
app.get('/panel/:page', (req, res) => {
    const map = { nodes: 'nodes', users: 'users', groups: 'groups', stats: 'stats', settings: 'settings' };
    const tpl = map[req.params.page];
    if (!tpl) return res.status(404).send('Unknown preview page');
    const data = {
        nodes: mockNodes, groups: [], users: [], linksCount: 0,
        pagination: { total: 0 }, query: {}, stats: mockStats,
        ipProtocolCount: {}, probeSummary: {},
        loadBalancingEnabled: true, panelDomain: 'preview.local',
        buildNodeUiMeta: () => ({ displayDomain: '', badges: [] }),
    };
    try {
        res.send(renderPage(tpl, data, tpl[0].toUpperCase() + tpl.slice(1), req.params.page));
    } catch (e) {
        res.status(500).send('<pre>Preview render error (' + tpl + '): ' + String(e.message) + '</pre>');
    }
});

app.listen(PORT, () => {
    console.log('[ui-preview] open http://localhost:' + PORT + '/panel');
});
