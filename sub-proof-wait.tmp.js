// Wait out login rate-limit, then run the subscription proof once. Single login.
const BASE = process.argv[2], ADMIN = process.argv[3], APASS = process.argv[4];
const HY = '6ad13d459d584fcc23fe137d', X = '6ad13d5a9d584fcc23fe138a';
let cookies = '';
async function req(method, path, body, headers = {}) {
  const h = { Cookie: cookies, ...headers };
  const opts = { method, headers: h, redirect: 'manual' };
  if (body !== undefined) {
    if (typeof body === 'string') { h['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = body; }
    else { h['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(BASE + path, opts);
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) cookies += c.split(';')[0] + '; ';
  return res;
}
const form = (obj) => new URLSearchParams(obj).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let logged = false;
  for (let i = 0; i < 20; i++) {
    const r = await req('POST', '/panel/login', form({ username: ADMIN, password: APASS }));
    console.log('login try:' + r.status);
    if (r.status === 302) { logged = true; break; }
    await sleep(60000);
  }
  if (!logged) throw new Error('login never succeeded');
  let res = await req('POST', '/api/groups', { name: 'shot-g', nodes: [HY, X] });
  const g = await res.json().catch(() => ({}));
  console.log('group:' + res.status + ' ' + JSON.stringify(g).slice(0, 160));
  const gid = g._id || g.id || g.group?._id;
  if (!gid) throw new Error('no group id');
  res = await req('POST', '/api/users', { userId: 'shot-qa', enabled: true, groups: [gid] });
  const created = await res.json().catch(() => ({}));
  const token = created.subscriptionToken || created.user?.subscriptionToken;
  if (!token) throw new Error('no token');
  console.log('token:' + token.slice(0, 8) + '...');
  res = await req('GET', `/api/files/${token}?format=uri`, undefined, { 'User-Agent': 'curl/8.0' });
  const uri = await res.text();
  console.log('uri:' + res.status + ' hysteria2=' + (uri.match(/hysteria2:\/\//g) || []).length + ' vless=' + (uri.match(/vless:\/\//g) || []).length);
  for (const l of uri.split('\n')) console.log('  ' + l.slice(0, 80));
  res = await req('GET', `/api/files/${token}?format=clash`, undefined, { 'User-Agent': 'Clash-Verge/1.0' });
  const clash = await res.text();
  console.log('clash:' + res.status + ' hy2=' + (clash.match(/type: hysteria2/g) || []).length + ' vless=' + (clash.match(/type: vless/g) || []).length);
  const etag = res.headers.get('etag');
  res = await req('GET', `/api/files/${token}?format=clash`, undefined, { 'User-Agent': 'Clash-Verge/1.0', 'If-None-Match': etag });
  console.log('etag304:' + res.status);
  await req('DELETE', '/api/users/shot-qa');
  await req('DELETE', `/api/groups/${gid}`);
  console.log('cleanup done');
})().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });
