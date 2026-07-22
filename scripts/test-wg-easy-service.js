const assert = require('assert');
const http = require('http');
process.env.PANEL_DOMAIN ||= 'panel.example.test';
process.env.ACME_EMAIL ||= 'admin@example.test';
process.env.ENCRYPTION_KEY ||= 'test-encryption-key-32-characters!!';
process.env.SESSION_SECRET ||= 'test-session-secret-32-characters!!!!';
const { WgEasyClient, normalizeBaseUrl, safeRemoteName } = require('../src/services/wgEasyService');
const { getCountryOptions, normalizeCountryCode, countryCodeToFlag } = require('../src/utils/country');

function readJson(req) {
    return new Promise(resolve => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => resolve(body ? JSON.parse(body) : {}));
    });
}

async function withServer(handler, run) {
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
    }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

async function testV15() {
    const clients = [];
    await withServer(async (req, res) => {
        assert.equal(req.headers.authorization, `Basic ${Buffer.from('admin:secret').toString('base64')}`);
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET' && req.url === '/api/client') return res.end(JSON.stringify(clients));
        if (req.method === 'POST' && req.url === '/api/client') {
            const body = await readJson(req);
            assert.equal(body.name, 'celerity-alice');
            clients.push({ id: 'v15-id', name: body.name });
            return res.end(JSON.stringify({ success: true, clientId: 'v15-id' }));
        }
        if (req.url === '/api/client/v15-id/configuration') return res.end('[Interface]\nPrivateKey=v15');
        res.statusCode = 404; res.end('{}');
    }, async baseUrl => {
        const client = new WgEasyClient({ name: 'v15', baseUrl, username: 'admin', password: 'secret', apiVersion: 'auto', rejectUnauthorized: true });
        await client.authenticate();
        assert.equal(client.version, 'v15');
        const created = await client.createOrFind('celerity-alice', null);
        assert.equal(client.clientId(created), 'v15-id');
        assert.match(await client.getConfiguration('v15-id'), /PrivateKey=v15/);
    });
}

async function testV14() {
    const clients = [];
    let loggedIn = false;
    await withServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST' && req.url === '/api/session') {
            const body = await readJson(req);
            assert.equal(body.password, 'secret');
            loggedIn = true;
            res.setHeader('Set-Cookie', 'connect.sid=test; Path=/; HttpOnly');
            return res.end(JSON.stringify({ authenticated: true }));
        }
        assert(loggedIn);
        assert.match(req.headers.cookie || '', /connect\.sid=test/);
        if (req.method === 'GET' && req.url === '/api/wireguard/client') return res.end(JSON.stringify(clients));
        if (req.method === 'POST' && req.url === '/api/wireguard/client') {
            const body = await readJson(req);
            clients.push({ id: 'v14-id', name: body.name });
            return res.end(JSON.stringify({ success: true }));
        }
        if (req.url === '/api/wireguard/client/v14-id/configuration') return res.end('[Interface]\nPrivateKey=v14');
        res.statusCode = 404; res.end('{}');
    }, async baseUrl => {
        const client = new WgEasyClient({ name: 'v14', baseUrl, username: '', password: 'secret', apiVersion: 'auto', rejectUnauthorized: true });
        await client.authenticate();
        assert.equal(client.version, 'v14');
        const created = await client.createOrFind('celerity-bob', null);
        assert.equal(client.clientId(created), 'v14-id');
        assert.match(await client.getConfiguration('v14-id'), /PrivateKey=v14/);
    });
}

(async () => {
    assert.equal(normalizeBaseUrl('wg.example.com:51821/'), 'http://wg.example.com:51821');
    assert.match(safeRemoteName('Иван / test'), /^celerity-test-[a-f0-9]{8}$/);
    assert.notEqual(safeRemoteName('Иван'), safeRemoteName('Пётр'));
    assert.equal(normalizeCountryCode(' de '), 'DE');
    assert.equal(normalizeCountryCode('DEU'), '');
    assert.equal(countryCodeToFlag('DE'), '🇩🇪');
    assert.equal(getCountryOptions('ru').find(country => country.code === 'NL').name, 'Нидерланды');
    assert.equal(getCountryOptions('en').find(country => country.code === 'NL').name, 'Netherlands');
    await testV15();
    await testV14();
    console.log('wg-easy service tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
