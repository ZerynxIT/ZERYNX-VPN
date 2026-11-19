// ZERYNX Worker — config engine, panel API, subscription pages, VLESS/WS relay.
// Original code. Storage: Cloudflare D1 (binding "DB").
// Single Worker: serves the panel (Static Assets, binding ASSETS), the API, subscriptions and the relay.
// Only requirement: a D1 binding named DB. Tables are prefixed zx_ and created automatically.
// First login is admin / admin and the panel forces a change immediately.
import { connect } from 'cloudflare:sockets';

const VERSION = '1.1.0';
const enc = new TextEncoder();
const dec = new TextDecoder();
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS zx_users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, sub_token TEXT NOT NULL UNIQUE,
    quota INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0,
    expire INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    created INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS zx_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS zx_daily (day TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS zx_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')`,
];
let ready = false;
const cache = new Map();
const fails = new Map();
const now = () => Math.floor(Date.now() / 1000);

async function init(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  const cols = (await env.DB.prepare('PRAGMA table_info(zx_users)').all()).results.map((c) => c.name);
  if (!cols.includes('last_seen')) await env.DB.prepare('ALTER TABLE zx_users ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0').run();
  ready = true;
}

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      const p = url.pathname;
      const isWs = req.headers.get('Upgrade') === 'websocket';
      const dynamic = p === '/vless' || p === '/api/health' || p.startsWith('/api/') || p.startsWith('/sub/');
      if (!dynamic && !isWs) return env.ASSETS ? env.ASSETS.fetch(req) : landing();
      if (p === '/api/health') {
        try {
          if (!env.DB) throw new Error('D1 binding "DB" is missing');
          await init(env);
          await env.DB.prepare('SELECT 1').first();
          return json({ ok: true, database: 'connected', version: VERSION });
        } catch (e) {
          return json({ ok: false, database: 'error', error: String((e && e.message) || e) }, 503);
        }
      }
      if (!env.DB) return json({ ok: false, error: 'D1 binding "DB" is missing' }, 503);
      if (isWs) {
        if (p !== '/vless') return new Response('Not found', { status: 404 });
        await init(env);
        return ws(req, env, ctx);
      }
      await init(env);
      if (p.startsWith('/api/')) return await api(req, env, url);
      if (p.startsWith('/sub/')) return await sub(req, env, url);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: 'internal_error' }, 500);
    }
  },
};

/* ---------- settings / logs ---------- */
const sc = new Map();
async function sget(env, k) {
  const c = sc.get(k);
  if (c && Date.now() - c.t < 30000) return c.v;
  const r = await env.DB.prepare('SELECT v FROM zx_settings WHERE k=?').bind(k).first();
  const v = r ? r.v : '';
  sc.set(k, { v, t: Date.now() });
  return v;
}
async function sset(env, k, v) {
  await env.DB.prepare('INSERT INTO zx_settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, String(v)).run();
  sc.set(k, { v: String(v), t: Date.now() });
}
async function addLog(env, action, detail = '') {
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO zx_logs (ts,action,detail) VALUES (?,?,?)').bind(now(), action, String(detail).slice(0, 200)),
      env.DB.prepare('DELETE FROM zx_logs WHERE id <= (SELECT MAX(id) - 300 FROM zx_logs)'),
    ]);
  } catch (e) { /* logging must never break a request */ }
}

/* ---------- crypto / auth ---------- */
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rhex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
function same(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}
async function hmac(secret, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data))));
}
let secretMem = '';
async function secret(env) {
  if (secretMem) return secretMem;
  await env.DB.prepare('INSERT OR IGNORE INTO zx_settings (k,v) VALUES (?,?)').bind('token_secret', rhex(32)).run();
  secretMem = (await env.DB.prepare('SELECT v FROM zx_settings WHERE k=?').bind('token_secret').first()).v;
  return secretMem;
}
let credMem = null;
async function creds(env) {
  if (credMem && Date.now() - credMem.t < 10000) return credMem;
  const q = async (k) => ((await env.DB.prepare('SELECT v FROM zx_settings WHERE k=?').bind(k).first()) || {}).v || '';
  const user = await q('admin_user'), salt = await q('admin_salt'), hash = await q('admin_hash');
  credMem = user && hash ? { user, salt, hash, def: false, pv: hash.slice(0, 8), t: Date.now() } : { user: 'admin', def: true, pv: 'def', t: Date.now() };
  return credMem;
}
const hashPw = async (salt, pw) => b64u(await sha(salt + pw));
async function checkLogin(env, u, pw) {
  const c = await creds(env);
  u = String(u || ''); pw = String(pw || '');
  const userOk = same(enc.encode(u), enc.encode(c.user));
  const pwOk = c.def ? same(enc.encode(pw), enc.encode('admin')) : same(enc.encode(await hashPw(c.salt, pw)), enc.encode(c.hash));
  return userOk && pwOk;
}
async function makeToken(env) {
  const c = await creds(env);
  const p = `${now() + 7 * 86400}.${c.pv}`;
  return p + '.' + (await hmac(await secret(env), p));
}
async function tokenOk(env, t) {
  const [exp, pv, sig] = String(t || '').split('.');
  if (!sig || Number(exp) < now()) return false;
  const c = await creds(env);
  if (pv !== c.pv) return false;
  return same(enc.encode(sig), enc.encode(await hmac(await secret(env), `${exp}.${pv}`)));
}
async function failState(env, ip) {
  const r = await env.DB.prepare('SELECT v FROM zx_settings WHERE k=?').bind('f:' + ip).first();
  if (!r) return { n: 0, t: 0 };
  const [n, t] = r.v.split('|').map(Number);
  return Date.now() - t > 600000 ? { n: 0, t: 0 } : { n, t };
}

/* ---------- panel API ---------- */
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const list = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/$/, '').toLowerCase()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (!list.length || list.includes('*')) h['Access-Control-Allow-Origin'] = '*';
  else if (list.includes(origin.toLowerCase())) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

const pub = (u, url) => ({
  id: u.id, name: u.name, sub_token: u.sub_token, quota: u.quota, used: u.used,
  expire: u.expire, enabled: !!u.enabled, created: u.created, last_seen: u.last_seen || 0,
  sub_url: `${url.origin}/sub/${u.sub_token}`,
});
const SET_KEYS = ['clean_ips', 'proxy_ip', 'remark'];

async function api(req, env, url) {
  const c = corsHeaders(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
  const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...c, 'Content-Type': 'application/json' } });
  const p = url.pathname, M = req.method;
  if (p === '/api/ping') return out({ ok: true, version: VERSION });

  if (p === '/api/login' && M === 'POST') {
    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    const f = await failState(env, ip);
    if (f.n >= 8) return out({ error: 'too_many_attempts' }, 429);
    const b = await req.json().catch(() => ({}));
    if (!(await checkLogin(env, b.username, b.password))) {
      await sset(env, 'f:' + ip, `${f.n + 1}|${f.t || Date.now()}`);
      return out({ error: 'bad_credentials' }, 401);
    }
    if (f.n) await env.DB.prepare('DELETE FROM zx_settings WHERE k=?').bind('f:' + ip).run();
    const cr = await creds(env);
    await addLog(env, 'login', ip);
    return out({ token: await makeToken(env), must_change: cr.def });
  }

  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!(await tokenOk(env, bearer))) return out({ error: 'unauthorized' }, 401);
  const cr = await creds(env);

  if (p === '/api/account' && M === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!(await checkLogin(env, cr.user, b.current))) return out({ error: 'bad_password' }, 401);
    const nu = String(b.username || '').trim().slice(0, 32), np = String(b.password || '');
    if (nu.length < 3 || np.length < 6 || np === 'admin') return out({ error: 'weak' }, 400);
    const salt = rhex(8);
    await sset(env, 'admin_user', nu);
    await sset(env, 'admin_salt', salt);
    await sset(env, 'admin_hash', await hashPw(salt, np));
    credMem = null;
    await addLog(env, 'account_changed', nu);
    return out({ token: await makeToken(env) });
  }
  if (cr.def) return out({ error: 'change_password' }, 403);

  if (p === '/api/status') {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM zx_users').first();
    return out({ ok: true, db: true, version: VERSION, users: r.n, username: cr.user });
  }
  if (p === '/api/stats') {
    const r = await env.DB.prepare('SELECT day,bytes FROM zx_daily ORDER BY day DESC LIMIT 30').all();
    return out({ daily: r.results.reverse() });
  }
  if (p === '/api/logs') {
    const r = await env.DB.prepare('SELECT ts,action,detail FROM zx_logs ORDER BY id DESC LIMIT 100').all();
    return out({ logs: r.results });
  }
  if (p === '/api/users' && M === 'GET') {
    const r = await env.DB.prepare('SELECT * FROM zx_users ORDER BY created DESC').all();
    return out({ users: r.results.map((u) => pub(u, url)) });
  }
  if (p === '/api/users' && M === 'POST') {
    const b = await req.json().catch(() => ({}));
    const name = String(b.name || '').trim().slice(0, 40);
    const q = Math.max(0, Number(b.quotaGB) || 0);
    const d = Math.max(0, Math.floor(Number(b.days) || 0));
    if (!name || q > 100000 || d > 3650) return out({ error: 'invalid' }, 400);
    const t = now();
    const u = { id: crypto.randomUUID(), name, sub_token: rhex(12), quota: Math.round(q * 1e9), used: 0, expire: d ? t + d * 86400 : 0, enabled: 1, created: t, last_seen: 0 };
    await env.DB.prepare('INSERT INTO zx_users (id,name,sub_token,quota,used,expire,enabled,created,last_seen) VALUES (?,?,?,?,?,?,?,?,0)')
      .bind(u.id, u.name, u.sub_token, u.quota, u.used, u.expire, u.enabled, u.created).run();
    await addLog(env, 'user_created', name);
    return out({ user: pub(u, url) }, 201);
  }
  const m = p.match(/^\/api\/users\/([\w-]+)$/);
  if (m && M === 'PATCH') {
    const b = await req.json().catch(() => ({}));
    const sets = [], vals = [];
    if ('enabled' in b) { sets.push('enabled=?'); vals.push(b.enabled ? 1 : 0); }
    if ('quotaGB' in b) { sets.push('quota=?'); vals.push(Math.round(Math.max(0, Number(b.quotaGB) || 0) * 1e9)); }
    if ('days' in b) { const d = Math.max(0, Math.floor(Number(b.days) || 0)); sets.push('expire=?'); vals.push(d ? now() + d * 86400 : 0); }
    if (b.resetUsage) sets.push('used=0');
    if (!sets.length) return out({ error: 'nothing_to_update' }, 400);
    await env.DB.prepare(`UPDATE zx_users SET ${sets.join(',')} WHERE id=?`).bind(...vals, m[1]).run();
    cache.delete(m[1]);
    const u = await env.DB.prepare('SELECT * FROM zx_users WHERE id=?').bind(m[1]).first();
    if (!u) return out({ error: 'not_found' }, 404);
    await addLog(env, 'user_updated', u.name);
    return out({ user: pub(u, url) });
  }
  if (m && M === 'DELETE') {
    const u = await env.DB.prepare('SELECT name FROM zx_users WHERE id=?').bind(m[1]).first();
    await env.DB.prepare('DELETE FROM zx_users WHERE id=?').bind(m[1]).run();
    cache.delete(m[1]);
    await addLog(env, 'user_deleted', u ? u.name : m[1]);
    return out({ ok: true });
  }
  if (p === '/api/settings') {
    if (M === 'PUT') {
      const b = await req.json().catch(() => ({}));
      if ('clean_ips' in b) await sset(env, 'clean_ips', String(b.clean_ips || '').split(/[\s,]+/).filter((x) => /^[\w.:-]{3,100}$/.test(x)).slice(0, 30).join('\n'));
      if ('proxy_ip' in b) await sset(env, 'proxy_ip', /^[\w.:-]{0,100}$/.test(String(b.proxy_ip || '').trim()) ? String(b.proxy_ip || '').trim() : '');
      if ('remark' in b) await sset(env, 'remark', /^[\w -]{1,20}$/.test(String(b.remark || '').trim()) ? String(b.remark).trim() : 'ZERYNX');
      await addLog(env, 'settings_saved');
    }
    const o = {};
    for (const k of SET_KEYS) o[k] = await sget(env, k);
    return out(o);
  }
  return out({ error: 'not_found' }, 404);
}

/* ---------- subscription ---------- */
const active = (u) => u.enabled && (!u.expire || u.expire > now()) && (!u.quota || u.used < u.quota);
const APP_UA = /v2ray|clash|mihomo|stash|hiddify|sing-?box|nekobox|nekoray|streisand|shadowrocket|karing|flclash|happ|v2box|foxray|quantumult|surge|loon|okhttp|dart|cfnetwork/i;

function vlessLinks(u, host, ips, prefix) {
  const addrs = [host, ...ips];
  return addrs.map((a, i) => {
    const q = new URLSearchParams({ encryption: 'none', security: 'tls', sni: host, fp: 'chrome', type: 'ws', host, path: '/vless' });
    const remark = `${prefix} ${u.name}${i ? ' ' + (i + 1) : ''}`;
    return { addr: a, remark, link: `vless://${u.id}@${a}:443?${q}#${encodeURIComponent(remark)}` };
  });
}

function clashYaml(u, items, host) {
  const px = items.map((x) => `  - {name: ${JSON.stringify(x.remark)}, type: vless, server: ${x.addr}, port: 443, uuid: ${u.id}, tls: true, servername: ${host}, network: ws, udp: true, client-fingerprint: chrome, ws-opts: {path: /vless, headers: {Host: ${host}}}}`);
  return `proxies:\n${px.join('\n')}\nproxy-groups:\n  - {name: ZERYNX, type: select, proxies: [${items.map((x) => JSON.stringify(x.remark)).join(', ')}]}\nrules:\n  - MATCH,ZERYNX\n`;
}

async function sub(req, env, url) {
  const tok = url.pathname.slice(5);
  const u = /^[a-f0-9]{24}$/.test(tok) ? await env.DB.prepare('SELECT * FROM zx_users WHERE sub_token=?').bind(tok).first() : null;
  if (!u) return new Response('Not found', { status: 404 });
  const ua = req.headers.get('User-Agent') || '';
  const fmt = url.searchParams.get('format');
  const wantsHtml = !fmt && !url.searchParams.has('raw') && (req.headers.get('Accept') || '').includes('text/html') && !APP_UA.test(ua);
  if (wantsHtml) return subPage(u, url);

  const ips = (await sget(env, 'clean_ips')).split('\n').filter(Boolean);
  const prefix = (await sget(env, 'remark')) || 'ZERYNX';
  const items = active(u) ? vlessLinks(u, url.host, ips, prefix) : [{ addr: url.host, remark: 'ZERYNX expired or disabled', link: `vless://${u.id}@${url.host}:443?encryption=none&security=tls&sni=${url.host}&type=ws&host=${url.host}&path=%2Fvless#${encodeURIComponent('ZERYNX expired or disabled')}` }];
  const info = [`upload=0`, `download=${u.used}`];
  if (u.quota) info.push(`total=${u.quota}`);
  if (u.expire) info.push(`expire=${u.expire}`);
  const h = { 'Subscription-Userinfo': info.join('; '), 'Profile-Update-Interval': '6', 'Cache-Control': 'no-store', 'Profile-Title': 'ZERYNX' };
  if (fmt === 'clash' || (!fmt && /clash|mihomo|stash|flclash/i.test(ua))) {
    return new Response(clashYaml(u, items, url.host), { headers: { ...h, 'Content-Type': 'text/yaml; charset=utf-8' } });
  }
  return new Response(btoa(items.map((x) => x.link).join('\n')), { headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8' } });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (b) => (b / 1e9).toFixed(b >= 1e10 ? 1 : 2);

function subPage(u, url) {
  const subUrl = `${url.origin}/sub/${u.sub_token}`;
  const q = encodeURIComponent(subUrl);
  const on = active(u);
  const left = u.expire ? Math.max(0, Math.ceil((u.expire - now()) / 86400)) : null;
  const pct = u.quota ? Math.min(100, (u.used / u.quota) * 100) : 0;
  const apps = [
    ['Hiddify', `hiddify://import/${subUrl}#ZERYNX`],
    ['v2rayNG', `v2rayng://install-sub?url=${q}&name=ZERYNX`],
    ['Clash / FlClash', `clash://install-config?url=${encodeURIComponent(subUrl + '?format=clash')}`],
    ['sing-box', `sing-box://import-remote-profile?url=${q}#ZERYNX`],
  ];
  const html = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>اشتراک زرینیکس</title>
<style>
:root{--bg:#02040f;--s:#071029;--line:#13296b;--ink:#e9f1ff;--mute:#7f93c4;--teal:#1f7bff;--neon:#2ab8ff;--bad:#ff6b8b}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg) radial-gradient(800px 420px at 80% -10%,rgba(31,123,255,.25),transparent 60%),radial-gradient(500px 300px at 10% 110%,rgba(139,92,255,.16),transparent 60%);color:var(--ink);font-family:Tahoma,system-ui,sans-serif;line-height:1.7;display:grid;place-items:center;padding:20px}
.card{width:min(520px,100%);background:var(--s);border:1px solid var(--line);border-radius:18px;padding:26px;box-shadow:0 0 60px rgba(31,123,255,.2)}
h1{margin:0;font-size:26px;color:var(--neon);text-shadow:0 0 20px rgba(42,184,255,.45)}.sub{color:var(--mute);margin:2px 0 18px}
.st{display:inline-block;padding:1px 12px;border-radius:99px;border:1px solid ${on ? 'var(--teal)' : 'var(--bad)'};color:${on ? 'var(--neon)' : 'var(--bad)'};font-size:13px}
.meter{height:8px;border-radius:9px;background:#0b1a42;overflow:hidden;margin:14px 0 6px}.meter i{display:block;height:100%;width:${pct}%;background:linear-gradient(90deg,var(--teal),var(--neon))}
.meta{display:flex;justify-content:space-between;color:var(--mute);font-size:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:22px 0 14px}
a.b,button{display:block;text-align:center;text-decoration:none;cursor:pointer;border:1px solid var(--teal);color:var(--teal);background:transparent;padding:10px;border-radius:10px;font:inherit}
a.b:hover,button:hover{background:var(--teal);color:#fff}
.link{direction:ltr;font-size:12px;word-break:break-all;color:var(--mute);border:1px dashed var(--line);border-radius:10px;padding:10px;margin-bottom:10px}
</style></head><body><main class="card">
<h1><svg viewBox="0 0 200 200" width="34" height="34" style="vertical-align:-6px;margin-inline-start:8px" aria-hidden="true"><path d="M46 58H154L52 142H160" fill="none" stroke="#2ab8ff" stroke-width="18"/></svg>ZERYNX</h1><p class="sub">${esc(u.name)}</p>
<span class="st">${on ? 'فعال' : 'غیرفعال یا منقضی'}</span>
<div class="meter"><i></i></div>
<div class="meta"><span>مصرف: ${gb(u.used)} گیگابایت${u.quota ? ' از ' + gb(u.quota) : ' (نامحدود)'}</span><span>${left === null ? 'بدون انقضا' : left + ' روز مانده'}</span></div>
<div class="grid">${apps.map((a) => `<a class="b" href="${esc(a[1])}">افزودن به ${esc(a[0])}</a>`).join('')}</div>
<div class="link" id="l">${esc(subUrl)}</div>
<button id="c" type="button">کپی لینک اشتراک</button>
</main><script>document.getElementById('c').onclick=function(){navigator.clipboard.writeText(document.getElementById('l').textContent).then(function(){document.getElementById('c').textContent='کپی شد'})}</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function landing() {
  return new Response('<!DOCTYPE html><meta charset="utf-8"><title>ZERYNX</title><body style="background:#02040f;color:#2ab8ff;letter-spacing:.4em;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><h1>ZERYNX</h1>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/* ---------- VLESS over WebSocket ---------- */
const HEX = [...Array(256)].map((_, i) => i.toString(16).padStart(2, '0'));
function uuidOf(b) {
  const h = [...b].map((x) => HEX[x]).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function parseVless(b) {
  if (b.length < 24) return null;
  const uuid = uuidOf(b.subarray(1, 17));
  let i = 18 + b[17];
  const cmd = b[i++];
  const port = (b[i] << 8) | b[i + 1];
  i += 2;
  const at = b[i++];
  let addr;
  if (at === 1) { addr = [...b.subarray(i, i + 4)].join('.'); i += 4; }
  else if (at === 2) { const l = b[i++]; addr = dec.decode(b.subarray(i, i + l)); i += l; }
  else if (at === 3) { const g = []; for (let k = 0; k < 8; k++) g.push(((b[i + 2 * k] << 8) | b[i + 2 * k + 1]).toString(16)); addr = g.join(':'); i += 16; }
  else return null;
  if (!addr || i > b.length) return null;
  return { ver: b[0], uuid, cmd, port, addr, payload: b.subarray(i) };
}

async function getUser(env, id) {
  const c = cache.get(id);
  if (c && Date.now() - c.t < 15000) return c.u;
  let u;
  try { u = await env.DB.prepare('SELECT * FROM zx_users WHERE id=?').bind(id).first(); }
  catch (e) { if (c) return c.u; throw e; }
  if (cache.size > 500) cache.clear();
  cache.set(id, { u, t: Date.now() });
  return u;
}

async function flush(env, st) {
  const d = st.sess - st.flushed;
  if (d <= 0 || !st.user) return;
  st.flushed += d;
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE zx_users SET used=used+?, last_seen=? WHERE id=?').bind(d, now(), st.user.id),
      env.DB.prepare('INSERT INTO zx_daily (day,bytes) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET bytes=bytes+excluded.bytes').bind(new Date().toISOString().slice(0, 10), d),
    ]);
  }
  catch (e) { st.flushed -= d; }
}

function ws(req, env, ctx) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const st = { user: null, ver: 0, sess: 0, flushed: 0, writer: null, remote: null, udp: false, sent: false, got: false, closed: false };

  const shut = () => {
    if (st.closed) return;
    st.closed = true;
    try { server.close(1000); } catch (e) {}
    try { st.remote && st.remote.close(); } catch (e) {}
    ctx.waitUntil(flush(env, st));
  };
  const count = (n) => {
    st.sess += n;
    const u = st.user;
    if (u && ((u.quota && u.used + st.sess >= u.quota) || (u.expire && u.expire < now()))) shut();
    else if (st.sess - st.flushed > 524288) ctx.waitUntil(flush(env, st));
  };
  const send = (d) => {
    try {
      if (st.sent) return server.send(d);
      st.sent = true;
      const o = new Uint8Array(2 + d.length);
      o[0] = st.ver; o[1] = 0; o.set(d, 2);
      server.send(o);
    } catch (e) { shut(); }
  };

  async function dns(data) {
    let i = 0;
    while (i + 2 <= data.length) {
      const l = (data[i] << 8) | data[i + 1];
      const qd = data.subarray(i + 2, i + 2 + l);
      i += 2 + l;
      const r = await fetch('https://1.1.1.1/dns-query', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: qd });
      const a = new Uint8Array(await r.arrayBuffer());
      const o = new Uint8Array(2 + a.length);
      o[0] = a.length >> 8; o[1] = a.length & 255; o.set(a, 2);
      count(a.length + qd.length);
      send(o);
    }
  }

  const hasProxy = async () => !!((await sget(env, 'proxy_ip')) || env.PROXY_IP);
  async function open(host, port, first, viaProxy) {
    let sock;
    try {
      let h = host, p = port;
      if (viaProxy) {
        const pip = (await sget(env, 'proxy_ip')) || env.PROXY_IP || '';
        if (!pip) return shut();
        const [ph, pp] = pip.split(':');
        h = ph; p = Number(pp) || port;
      }
      sock = connect({ hostname: h, port: p });
      await Promise.race([sock.opened, new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 8000))]);
    } catch (e) {
      try { sock && sock.close(); } catch (x) {}
      if (!viaProxy && (await hasProxy())) return open(host, port, first, true);
      return shut();
    }
    if (st.closed) { try { sock.close(); } catch (e) {} return; }
    st.remote = sock;
    st.got = false;
    st.writer = sock.writable.getWriter();
    try { if (first.length) await st.writer.write(first); } catch (e) { return shut(); }
    sock.readable.pipeTo(new WritableStream({
      write(chunk) { st.got = true; count(chunk.length); send(chunk); },
      async close() {
        if (!st.got && !viaProxy && !st.closed && (await hasProxy())) {
          try { st.writer.releaseLock(); } catch (e) {}
          return open(host, port, first, true);
        }
        shut();
      },
      abort() { shut(); },
    })).catch(() => shut());
  }

  async function onData(c) {
    if (st.udp) return dns(c);
    if (st.writer) { count(c.length); return st.writer.write(c); }
    const h = parseVless(c);
    if (!h) return shut();
    const u = await getUser(env, h.uuid);
    if (!u || !active(u)) return shut();
    st.user = u; st.ver = h.ver;
    if (h.cmd === 2) {
      if (h.port !== 53) return shut();
      st.udp = true;
      return dns(h.payload);
    }
    if (h.cmd !== 1) return shut();
    count(h.payload.length);
    return open(h.addr, h.port, h.payload, false);
  }

  let q = Promise.resolve();
  server.addEventListener('message', (e) => {
    if (typeof e.data === 'string') return;
    q = q.then(() => onData(new Uint8Array(e.data))).catch(() => shut());
  });
  server.addEventListener('close', shut);
  server.addEventListener('error', shut);
  return new Response(null, { status: 101, webSocket: client });
}
