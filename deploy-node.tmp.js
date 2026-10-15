// Deploy a Hysteria + Xray node to VamPanel via panel HTTP API.
// Usage: node deploy-node.tmp.js <baseUrl> <adminUser> <adminPass> <nodeIp> <sshPass>
const BASE = process.argv[2];
const ADMIN = process.argv[3];
const APASS = process.argv[4];
const IP = process.argv[5];
const SSHPASS = process.argv[6];
if (!BASE || !ADMIN || !APASS || !IP || !SSHPASS) {
  console.error('usage: deploy-node.tmp.js <base> <admin> <pass> <ip> <sshpass>');
  process.exit(2);
}

let cookies = '';
function storeCookies(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) cookies += c.split(';')[0] + '; ';
}
async function req(method, path, body, extraHeaders = {}) {
  const headers = { Cookie: cookies, ...extraHeaders };
  const opts = { method, headers, redirect: 'manual' };
  if (body !== undefined) {
    if (typeof body === 'string') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = body;
    } else {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(BASE + path, opts);
  storeCookies(res);
  return res;
}
const form = (obj) => new URLSearchParams(obj).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. login
  let res = await req('POST', '/panel/login', form({ username: ADMIN, password: APASS }));
  console.log('login:' + res.status);
  if (res.status !== 302 && res.status !== 200) throw new Error('login failed: ' + res.status);

  // 2. hysteria node
  const hyBody = form({
    name: 'VPS-172 Hysteria', ip: IP, type: 'hysteria',
    'ssh.port': '22', 'ssh.username': 'root', 'ssh.password': SSHPASS,
    port: '443', portRange: '20000-50000', statsPort: '9999',
    active: 'on', autoSetup: 'on',
  });
  res = await req('POST', '/panel/nodes', hyBody, { Accept: 'application/json' });
  const hyJson = await res.json().catch(() => ({}));
  console.log('hy-create:' + res.status + ' ' + JSON.stringify(hyJson).slice(0, 200));
  if (!hyJson.success) throw new Error('hysteria create failed: ' + JSON.stringify(hyJson));
  const hyId = (hyJson.redirect || '').match(/\/panel\/nodes\/([a-f0-9]{24})/)?.[1];
  console.log('hyId:' + hyId);

  // 3. poll hysteria setup
  const hyTask = await pollTask(hyId, 'hysteria');
  console.log('hy-setup:' + hyTask.status);

  // 4. reality keys
  res = await req('POST', '/panel/nodes/generate-reality-keys', form({}), { Accept: 'application/json' });
  const keys = await res.json();
  console.log('keys:' + (keys.success ? 'ok' : JSON.stringify(keys).slice(0, 150)));
  if (!keys.success) throw new Error('reality keys failed');

  // 5. xray node
  const xBody = form({
    name: 'VPS-172 Xray', ip: IP, type: 'xray',
    'ssh.port': '22', 'ssh.username': 'root', 'ssh.password': SSHPASS,
    port: '443', active: 'on', autoSetup: 'on',
    'xray.transport': 'tcp', 'xray.security': 'reality',
    'xray.flow': 'xtls-rprx-vision', 'xray.fingerprint': 'chrome',
    'xray.realityDest': 'www.microsoft.com:443',
    'xray.realitySni': 'www.microsoft.com',
    'xray.realityPrivateKey': keys.privateKey || keys.private || '',
    'xray.realityPublicKey': keys.publicKey || keys.public || '',
  });
  res = await req('POST', '/panel/nodes', xBody, { Accept: 'application/json' });
  const xJson = await res.json().catch(() => ({}));
  console.log('x-create:' + res.status + ' ' + JSON.stringify(xJson).slice(0, 200));
  if (!xJson.success) throw new Error('xray create failed: ' + JSON.stringify(xJson));
  const xId = (xJson.redirect || '').match(/\/panel\/nodes\/([a-f0-9]{24})/)?.[1];
  console.log('xId:' + xId);

  // 6. poll xray setup
  const xTask = await pollTask(xId, 'xray');
  console.log('x-setup:' + xTask.status);

  async function pollTask(id, label) {
    const t0 = Date.now();
    for (;;) {
      await sleep(20000);
      const r = await req('GET', `/panel/nodes/${id}/setup-task`, undefined, { Accept: 'application/json' });
      if (r.status === 404) { console.log(`[${label}] no task yet...`); continue; }
      const t = await r.json();
      const last = (t.logs || []).slice(-1)[0] || '';
      console.log(`[${label}] ${t.status} logs=${(t.logs || []).length} last=${last.slice(0, 100)}`);
      if (t.status !== 'running') return t;
      if (Date.now() - t0 > 12 * 60 * 1000) throw new Error(label + ' setup timeout');
    }
  }
  console.log('RESULT hyId=' + hyId + ' xId=' + xId);
})().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });
