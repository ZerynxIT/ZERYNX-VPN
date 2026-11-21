// ZERYNX Worker v2 — panel (Static Assets), JSON API, subscriptions and VLESS/WebSocket relay.
// Original code, MIT licensed. Storage: Cloudflare D1 (binding "DB"). Tables are prefixed zx_ and auto-created.
// First login: admin / admin — the panel forces a change immediately.
import { connect } from 'cloudflare:sockets';

const VERSION = '2.0.0';
const KB = 1024, MB = 1048576, GB = 1073741824;
const PORTS = [443, 8443, 2053, 2083, 2087, 2096];
const FPS = ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'];
const BLOCKED_PORTS = new Set([25]);
const DOH = ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query'];
const IP_WINDOW = 600;
const enc = new TextEncoder();
const dec = new TextDecoder();
const now = () => Math.floor(Date.now() / 1000);

/* ---------- schema ---------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS zx_users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, sub_token TEXT NOT NULL UNIQUE,
    quota INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0,
    expire INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    created INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS zx_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS zx_daily (day TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS zx_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS zx_ips (uid TEXT NOT NULL, ip TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (uid, ip))`,
];
const EXTRA_COLS = [
  ['note', "TEXT NOT NULL DEFAULT ''"], ['cfg_count', 'INTEGER NOT NULL DEFAULT 10'], ['ip_limit', 'INTEGER NOT NULL DEFAULT 0'],
  ['daily_quota', 'INTEGER NOT NULL DEFAULT 0'], ['day', 'INTEGER NOT NULL DEFAULT 0'], ['day_used', 'INTEGER NOT NULL DEFAULT 0'],
  ['start_on_use', 'INTEGER NOT NULL DEFAULT 0'], ['exp_days', 'INTEGER NOT NULL DEFAULT 0'],
];
let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  const cols = (await env.DB.prepare('PRAGMA table_info(zx_users)').all()).results.map((c) => c.name);
  for (const [n, t] of EXTRA_COLS) if (!cols.includes(n)) await env.DB.prepare(`ALTER TABLE zx_users ADD COLUMN ${n} ${t}`).run();
  ready = true;
}

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const isVless = (p) => p === '/vless' || p.startsWith('/vless/');

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      const p = url.pathname;
      const isWs = req.headers.get('Upgrade') === 'websocket';
      const dynamic = isVless(p) || p.startsWith('/api/') || p.startsWith('/sub/');
      if (!dynamic && !isWs) return env.ASSETS ? env.ASSETS.fetch(req) : landing();
      if (p === '/api/health') {
        const healthCors = corsHeaders(req, env);
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: healthCors });
        const healthJson = (data, status = 200) => new Response(JSON.stringify(data), {
          status,
          headers: { ...healthCors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
        try {
          if (!env.DB) throw new Error('D1 binding "DB" is missing');
          await init(env);
          await env.DB.prepare('SELECT 1').first();
          return healthJson({ ok: true, database: 'connected', version: VERSION });
        } catch (e) {
          return healthJson({ ok: false, database: 'error', error: String((e && e.message) || e) }, 503);
        }
      }
      if (!env.DB) return json({ ok: false, error: 'D1 binding "DB" is missing' }, 503);
      if (isWs) {
        if (!isVless(p)) return new Response('Not found', { status: 404 });
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

const dayNum = () => Math.floor(now() / 86400);
const pub = (u, url) => ({
  id: u.id, name: u.name, note: u.note || '', sub_token: u.sub_token, quota: u.quota, used: u.used,
  daily_quota: u.daily_quota || 0, day_used: u.day === dayNum() ? u.day_used : 0,
  expire: u.expire, exp_days: u.exp_days || 0, start_on_use: !!u.start_on_use,
  ip_limit: u.ip_limit || 0, cfg_count: Math.max(10, u.cfg_count || 10),
  enabled: !!u.enabled, created: u.created, last_seen: u.last_seen || 0,
  sub_url: `${url.origin}/sub/${u.sub_token}`,
});
const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0; };
const expireFor = (days, startOnUse) => (days && !startOnUse ? now() + days * 86400 : 0);
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
    if (!name) return out({ error: 'invalid' }, 400);
    const days = Math.floor(num(b.days, 3650)), start = b.startOnUse ? 1 : 0;
    const t = now();
    const u = {
      id: crypto.randomUUID(), name, note: String(b.note || '').slice(0, 120), sub_token: rhex(12),
      quota: Math.round(num(b.quotaGB, 100000) * GB), used: 0, expire: expireFor(days, start), enabled: 1, created: t, last_seen: 0,
      cfg_count: Math.max(10, Math.min(200, Math.floor(num(b.cfgCount, 200)) || 10)), ip_limit: Math.floor(num(b.ipLimit, 1000)),
      daily_quota: Math.round(num(b.dailyGB, 100000) * GB), day: 0, day_used: 0, start_on_use: start, exp_days: days,
    };
    await env.DB.prepare('INSERT INTO zx_users (id,name,note,sub_token,quota,used,expire,enabled,created,last_seen,cfg_count,ip_limit,daily_quota,day,day_used,start_on_use,exp_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(u.id, u.name, u.note, u.sub_token, u.quota, u.used, u.expire, u.enabled, u.created, u.last_seen, u.cfg_count, u.ip_limit, u.daily_quota, u.day, u.day_used, u.start_on_use, u.exp_days).run();
    await addLog(env, 'user_created', name);
    return out({ user: pub(u, url) }, 201);
  }
  const m = p.match(/^\/api\/users\/([\w-]+)$/);
  if (m && M === 'PATCH') {
    const b = await req.json().catch(() => ({}));
    const cur = await env.DB.prepare('SELECT * FROM zx_users WHERE id=?').bind(m[1]).first();
    if (!cur) return out({ error: 'not_found' }, 404);
    const sets = [], vals = [];
    const set = (col, v) => { sets.push(col + '=?'); vals.push(v); };
    if ('name' in b) { const n = String(b.name || '').trim().slice(0, 40); if (n) set('name', n); }
    if ('note' in b) set('note', String(b.note || '').slice(0, 120));
    if ('enabled' in b) set('enabled', b.enabled ? 1 : 0);
    if ('quotaGB' in b) set('quota', Math.round(num(b.quotaGB, 100000) * GB));
    if ('dailyGB' in b) set('daily_quota', Math.round(num(b.dailyGB, 100000) * GB));
    if ('cfgCount' in b) set('cfg_count', Math.max(10, Math.min(200, Math.floor(num(b.cfgCount, 200)) || 10)));
    if ('ipLimit' in b) set('ip_limit', Math.floor(num(b.ipLimit, 1000)));
    if ('days' in b || 'startOnUse' in b) {
      const start = 'startOnUse' in b ? (b.startOnUse ? 1 : 0) : cur.start_on_use;
      const days = 'days' in b ? Math.floor(num(b.days, 3650)) : cur.exp_days;
      set('start_on_use', start); set('exp_days', days); set('expire', expireFor(days, start));
    }
    if (b.resetUsage) { sets.push('used=0', 'day_used=0'); }
    if (!sets.length) return out({ error: 'nothing_to_update' }, 400);
    await env.DB.prepare(`UPDATE zx_users SET ${sets.join(',')} WHERE id=?`).bind(...vals, m[1]).run();
    cache.delete(m[1]);
    const u = await env.DB.prepare('SELECT * FROM zx_users WHERE id=?').bind(m[1]).first();
    await addLog(env, 'user_updated', u.name);
    return out({ user: pub(u, url) });
  }
  if (m && M === 'DELETE') {
    const u = await env.DB.prepare('SELECT name FROM zx_users WHERE id=?').bind(m[1]).first();
    await env.DB.batch([env.DB.prepare('DELETE FROM zx_users WHERE id=?').bind(m[1]), env.DB.prepare('DELETE FROM zx_ips WHERE uid=?').bind(m[1])]);
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

// Builds at least 10 distinct configs per user: addresses x ports x fingerprints, odd ones use 0-RTT early data.
function variants(u, host, ips, prefix) {
  const n = Math.max(10, Math.min(200, u.cfg_count || 10));
  const addrs = [host, ...ips], A = addrs.length, P = PORTS.length, F = FPS.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const addr = addrs[i % A];
    const port = PORTS[Math.floor(i / A) % P];
    const fp = FPS[Math.floor(i / (A * P)) % F];
    const lap = Math.floor(i / (A * P * F));
    const ed = i % 2 === 1;
    const path = '/vless' + (lap ? '/' + lap : '');
    const remark = `${prefix} ${u.name} ${String(i + 1).padStart(2, '0')}`;
    const q = new URLSearchParams({ encryption: 'none', security: 'tls', sni: host, fp, alpn: 'http/1.1', type: 'ws', host, path: path + (ed ? '?ed=2048' : '') });
    out.push({ addr, port, fp, path, ed, remark, link: `vless://${u.id}@${addr}:${port}?${q}#${encodeURIComponent(remark)}` });
  }
  return out;
}

function clashYaml(u, items, host) {
  const px = items.map((x) => `  - {name: ${JSON.stringify(x.remark)}, type: vless, server: ${x.addr}, port: ${x.port}, uuid: ${u.id}, tls: true, servername: ${host}, alpn: [http/1.1], network: ws, udp: true, client-fingerprint: ${x.fp === 'ios' || x.fp === 'android' || x.fp === 'edge' ? 'chrome' : x.fp}, ws-opts: {path: ${JSON.stringify(x.path)}, headers: {Host: ${host}}${x.ed ? ', max-early-data: 2048, early-data-header-name: Sec-WebSocket-Protocol' : ''}}}`);
  const names = items.map((x) => JSON.stringify(x.remark)).join(', ');
  return `proxies:\n${px.join('\n')}\nproxy-groups:\n  - {name: ZERYNX, type: select, proxies: [AUTO, ${names}]}\n  - {name: AUTO, type: url-test, url: "http://www.gstatic.com/generate_204", interval: 300, tolerance: 50, proxies: [${names}]}\nrules:\n  - MATCH,ZERYNX\n`;
}

function singboxJson(u, items, host) {
  const vs = items.map((x) => ({
    type: 'vless', tag: x.remark, server: x.addr, server_port: x.port, uuid: u.id,
    tls: { enabled: true, server_name: host, utls: { enabled: true, fingerprint: x.fp }, alpn: ['http/1.1'] },
    transport: { type: 'ws', path: x.path, headers: { Host: host }, ...(x.ed ? { max_early_data: 2048, early_data_header_name: 'Sec-WebSocket-Protocol' } : {}) },
  }));
  const tags = vs.map((v) => v.tag);
  return JSON.stringify({
    outbounds: [
      { type: 'selector', tag: 'ZERYNX', outbounds: ['AUTO', ...tags], default: 'AUTO' },
      { type: 'urltest', tag: 'AUTO', outbounds: tags, url: 'https://www.gstatic.com/generate_204', interval: '5m' },
      ...vs, { type: 'direct', tag: 'direct' },
    ],
  }, null, 1);
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
  const items = active(u)
    ? variants(u, url.host, ips, prefix)
    : [{ addr: url.host, port: 443, fp: 'chrome', path: '/vless', ed: false, remark: `${prefix} expired or disabled`, link: `vless://${u.id}@${url.host}:443?encryption=none&security=tls&sni=${url.host}&type=ws&host=${url.host}&path=%2Fvless#${encodeURIComponent(prefix + ' expired or disabled')}` }];
  const info = ['upload=0', `download=${u.used}`];
  if (u.quota) info.push(`total=${u.quota}`);
  if (u.expire) info.push(`expire=${u.expire}`);
  const h = { 'Subscription-Userinfo': info.join('; '), 'Profile-Update-Interval': '6', 'Cache-Control': 'no-store', 'Profile-Title': 'ZERYNX', 'Profile-Web-Page-Url': `${url.origin}/sub/${tok}` };
  if (fmt === 'clash' || (!fmt && /clash|mihomo|stash|flclash/i.test(ua))) return new Response(clashYaml(u, items, url.host), { headers: { ...h, 'Content-Type': 'text/yaml; charset=utf-8' } });
  if (fmt === 'singbox' || (!fmt && /sing-?box/i.test(ua))) return new Response(singboxJson(u, items, url.host), { headers: { ...h, 'Content-Type': 'application/json; charset=utf-8' } });
  const body = items.map((x) => x.link).join('\n');
  if (fmt === 'raw') return new Response(body, { headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(btoa(body), { headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8' } });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (b) => (b / GB).toFixed(b >= 10 * GB ? 1 : 2);

function subPage(u, url) {
  const subUrl = `${url.origin}/sub/${u.sub_token}`;
  const q = encodeURIComponent(subUrl);
  const on = active(u);
  const left = u.expire ? Math.max(0, Math.ceil((u.expire - now()) / 86400)) : null;
  const waiting = u.start_on_use && !u.expire && u.exp_days;
  const pct = u.quota ? Math.min(100, (u.used / u.quota) * 100) : 0;
  const n = Math.max(10, u.cfg_count || 10);
  const apps = [
    ['Hiddify', `hiddify://import/${subUrl}#ZERYNX`],
    ['v2rayNG', `v2rayng://install-sub?url=${q}&name=ZERYNX`],
    ['Clash / FlClash', `clash://install-config?url=${encodeURIComponent(subUrl + '?format=clash')}`],
    ['sing-box', `sing-box://import-remote-profile?url=${q}#ZERYNX`],
  ];
  const html = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>اشتراک زرینیکس</title>
<style>
:root{--bg:#02040a;--s:#050912;--line:#13296b;--ink:#e9f1ff;--mute:#7f93c4;--teal:#1f7bff;--neon:#2ab8ff;--bad:#ff6b8b}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg) radial-gradient(800px 420px at 80% -10%,rgba(31,123,255,.22),transparent 60%),radial-gradient(500px 300px at 10% 110%,rgba(139,92,255,.14),transparent 60%);color:var(--ink);font-family:Tahoma,system-ui,sans-serif;line-height:1.7;display:grid;place-items:center;padding:20px}
.card{width:min(520px,100%);background:var(--s);border:1px solid var(--line);border-radius:18px;padding:26px;box-shadow:0 0 60px rgba(31,123,255,.18)}
h1{margin:0;font-size:26px;letter-spacing:.3em;text-shadow:0 0 20px rgba(42,184,255,.45)}.sub{color:var(--mute);margin:2px 0 18px}
.st{display:inline-block;padding:1px 12px;border-radius:99px;border:1px solid ${on ? '#2be3a0' : 'var(--bad)'};color:${on ? '#2be3a0' : 'var(--bad)'};font-size:13px}
.meter{height:8px;border-radius:9px;background:#0b1430;overflow:hidden;margin:14px 0 6px}.meter i{display:block;height:100%;width:${pct}%;background:linear-gradient(90deg,var(--teal),var(--neon))}
.meta{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;color:var(--mute);font-size:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:22px 0 14px}
a.b,button{display:block;text-align:center;text-decoration:none;cursor:pointer;border:1px solid var(--teal);color:var(--neon);background:transparent;padding:10px;border-radius:10px;font:inherit}
a.b:hover,button:hover{background:var(--teal);color:#fff}
.link{direction:ltr;font-size:12px;word-break:break-all;color:var(--mute);border:1px dashed var(--line);border-radius:10px;padding:10px;margin-bottom:10px}
</style></head><body><main class="card">
<h1><svg viewBox="0 0 200 200" width="32" height="32" style="vertical-align:-6px;margin-inline-start:8px" aria-hidden="true"><path d="M46 58H154L52 142H160" fill="none" stroke="#2ab8ff" stroke-width="18"/></svg>ZERYNX</h1><p class="sub">${esc(u.name)}</p>
<span class="st">${on ? 'فعال' : 'غیرفعال یا منقضی'}</span>
<div class="meter"><i></i></div>
<div class="meta"><span>مصرف: ${gb(u.used)} گیگابایت${u.quota ? ' از ' + gb(u.quota) : ' (نامحدود)'}</span><span>${waiting ? 'انقضا از اولین اتصال شروع می‌شود' : left === null ? 'بدون انقضا' : left + ' روز مانده'}</span></div>
<div class="meta" style="margin-top:4px"><span>${n} کانفیگ در این اشتراک</span></div>
<div class="grid">${apps.map((a) => `<a class="b" href="${esc(a[1])}">افزودن به ${esc(a[0])}</a>`).join('')}</div>
<div class="link" id="l">${esc(subUrl)}</div>
<button id="c" type="button">کپی لینک اشتراک</button>
</main><script>document.getElementById('c').onclick=function(){navigator.clipboard.writeText(document.getElementById('l').textContent).then(function(){document.getElementById('c').textContent='کپی شد'})}</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function landing() {
  return new Response('<!DOCTYPE html><meta charset="utf-8"><title>ZERYNX</title><body style="background:#02040a;color:#2ab8ff;letter-spacing:.4em;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><h1>ZERYNX</h1>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/* ---------- VLESS parsing ---------- */
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
function targetAllowed(addr, port) {
  if (!(port > 0 && port < 65536) || BLOCKED_PORTS.has(port)) return false;
  if (addr === 'localhost' || addr.endsWith('.localhost')) return false;
  if (addr.includes(':')) return !/^(::1?$|f[cd][0-9a-f]{2}:|fe80:)/i.test(addr);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return !/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr);
  return true;
}
function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/* ---------- user lookup, IP limit ---------- */
const cache = new Map();
async function getUser(env, id) {
  const c = cache.get(id);
  if (c && Date.now() - c.t < 5000) return c.u;
  let u;
  try { u = await env.DB.prepare('SELECT * FROM zx_users WHERE id=?').bind(id).first(); }
  catch (e) { if (c) return c.u; throw e; }
  if (cache.size > 500) cache.clear();
  cache.set(id, { u, t: Date.now() });
  return u;
}
const ipSeen = new Map();
async function ipOk(env, u, ip) {
  if (!u.ip_limit || !ip) return true;
  const k = u.id + '|' + ip, t = now();
  if (t - (ipSeen.get(k) || 0) < 60) return true;
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM zx_ips WHERE uid=? AND t>? AND ip<>?').bind(u.id, t - IP_WINDOW, ip).first();
  if (r.n >= u.ip_limit) return false;
  await env.DB.prepare('INSERT INTO zx_ips (uid,ip,t) VALUES (?,?,?) ON CONFLICT(uid,ip) DO UPDATE SET t=excluded.t').bind(u.id, ip, t).run();
  if (ipSeen.size > 2000) ipSeen.clear();
  ipSeen.set(k, t);
  if (Math.random() < 0.01) await env.DB.prepare('DELETE FROM zx_ips WHERE t<?').bind(t - 86400).run();
  return true;
}

/* ---------- exact accounting: atomic reservation pool per user ---------- */
// Every byte a user may transfer is first *reserved* in D1 with one atomic UPDATE that refuses to exceed the total
// quota, the daily quota, expiry or a disabled flag. Connections of the same user inside one isolate share one pool,
// so a browsing burst costs a handful of writes. Unused budget is refunded when the last connection closes.
const RESERVE_SQL = `UPDATE zx_users SET used = used + ?, day_used = (CASE WHEN day = ? THEN day_used ELSE 0 END) + ?, day = ?, last_seen = ?
  WHERE id = ? AND enabled = 1 AND (expire = 0 OR expire > ?) AND (quota = 0 OR used + ? <= quota)
  AND (daily_quota = 0 OR (CASE WHEN day = ? THEN day_used ELSE 0 END) + ? <= daily_quota)
  RETURNING used, quota, day_used, daily_quota`;
const REFUND_SQL = `UPDATE zx_users SET used = MAX(used - ?, 0), day_used = CASE WHEN day = ? THEN MAX(day_used - ?, 0) ELSE day_used END, last_seen = ? WHERE id = ?`;
const DAILY_SQL = `INSERT INTO zx_daily (day,bytes) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET bytes = bytes + excluded.bytes`;
const pools = new Map();
let dailyPend = 0;
const alive = (r, t) => !!r && !!r.enabled && !(r.expire && r.expire <= t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function poolOf(uid) {
  let P = pools.get(uid);
  if (!P) { P = { uid, budget: 0, grant: 0, conns: 0, block: 128 * KB, pending: null, denied: 0, pend: 0, dead: false, limited: false }; pools.set(uid, P); }
  return P;
}

async function reserve(env, P, want) {
  for (let i = 0; i < 4; i++) {
    const t = now(), dn = Math.floor(t / 86400);
    try {
      const r = await env.DB.prepare(RESERVE_SQL).bind(want, dn, want, dn, t, P.uid, t, want, dn, want).first();
      if (r) {
        let rem = Infinity;
        if (r.quota) rem = r.quota - r.used;
        if (r.daily_quota) rem = Math.min(rem, r.daily_quota - r.day_used);
        P.block = Math.max(32 * KB, Math.min(P.block * 2, 4 * MB, Math.floor(rem / 4)));
        return want;
      }
      const s = await env.DB.prepare('SELECT quota,used,daily_quota,day,day_used,enabled,expire FROM zx_users WHERE id=?').bind(P.uid).first();
      if (!s || !s.enabled || (s.expire && s.expire <= t)) return 0;
      let rem = Infinity;
      if (s.quota) rem = s.quota - s.used;
      if (s.daily_quota) rem = Math.min(rem, s.daily_quota - (s.day === dn ? s.day_used : 0));
      if (rem <= 0) return 0;
      want = Math.min(want, rem);
    } catch (e) { await sleep(150); }
  }
  return 0;
}

async function flushPool(env, P, final) {
  const t = now(), dn = Math.floor(t / 86400);
  const d = P.pend; P.pend = 0;
  try {
    if (final && P.budget > 0) {
      const rf = P.budget; P.budget = 0;
      await env.DB.prepare(REFUND_SQL).bind(rf, dn, rf, t, P.uid).run();
    }
    if (d > 0 || !P.limited) {
      const r = await env.DB.prepare('UPDATE zx_users SET used = used + ?, last_seen = ? WHERE id = ? RETURNING enabled, expire').bind(d, t, P.uid).first();
      P.dead = !alive(r, t);
    } else if (!final) {
      const r = await env.DB.prepare('SELECT enabled, expire FROM zx_users WHERE id=?').bind(P.uid).first();
      P.dead = !alive(r, t);
    }
  } catch (e) { P.pend += d; }
}
async function flushDaily(env, force) {
  if (dailyPend <= 0 || (!force && dailyPend < 4 * MB)) return;
  const d = dailyPend; dailyPend = 0;
  try { await env.DB.prepare(DAILY_SQL).bind(new Date().toISOString().slice(0, 10), d).run(); } catch (e) { dailyPend += d; }
}

/* ---------- relay ---------- */
async function doh(q) {
  for (const u of DOH) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' }, body: q, signal: AbortSignal.timeout(4000) });
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch (e) { /* try next resolver */ }
  }
  return null;
}

function ws(req, env, ctx) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const early = req.headers.get('Sec-WebSocket-Protocol');
  const tick = Number(env.TICK_MS) || 30000;
  const st = { user: null, ver: 0, P: null, writer: null, remote: null, udp: false, sent: false, got: false, closed: false, dstat: 0, timer: null };
  let q = Promise.resolve();
  const enqueue = (c) => { q = q.then(() => onData(c)).catch(() => shut()); };

  function shut() {
    if (st.closed) return;
    st.closed = true;
    clearInterval(st.timer);
    try { server.close(1000); } catch (e) {}
    try { st.remote && st.remote.close(); } catch (e) {}
    const P = st.P;
    dailyPend += st.dstat; st.dstat = 0;
    if (P) {
      P.conns--;
      ctx.waitUntil((async () => {
        if (P.conns <= 0) { await flushPool(env, P, true); await flushDaily(env, true); if (P.conns <= 0 && !P.budget && !P.pend) pools.delete(P.uid); }
      })());
    }
  }
  const send = (d) => {
    try {
      if (st.sent) return server.send(d);
      st.sent = true;
      const o = new Uint8Array(2 + d.length);
      o[0] = st.ver; o[1] = 0; o.set(d, 2);
      server.send(o);
    } catch (e) { shut(); }
  };

  function refill(need) {
    const P = st.P;
    if (!P.pending && !(P.denied && Date.now() - P.denied < 2000)) {
      P.pending = reserve(env, P, Math.max(P.block, need))
        .then((g) => { if (g > 0) { P.budget += g; P.grant = g; P.denied = 0; } else P.denied = Date.now(); }, () => { P.denied = Date.now(); })
        .then(() => { P.pending = null; });
    }
    return P.pending || Promise.resolve();
  }
  // Returns how many of n bytes may pass (n, a partial tail, or 0).
  async function take(n) {
    const P = st.P;
    st.dstat += n;
    if (!P.limited) {
      P.pend += n;
      if (P.pend >= 8 * MB) ctx.waitUntil(flushPool(env, P, false));
      return n;
    }
    for (;;) {
      if (P.budget >= n) break;
      if (P.denied && Date.now() - P.denied < 2000) { const k = P.budget; P.budget = 0; st.dstat -= n - k; return k; }
      await refill(n);
    }
    P.budget -= n;
    if (P.budget < P.grant / 2) refill(0);
    return n;
  }

  async function dns(data) {
    let i = 0;
    while (i + 2 <= data.length) {
      const l = (data[i] << 8) | data[i + 1];
      const qd = data.subarray(i + 2, i + 2 + l);
      i += 2 + l;
      const a = await doh(qd);
      if (!a) continue;
      const k = await take(a.length);
      if (k < a.length) return shut();
      const o = new Uint8Array(2 + a.length);
      o[0] = a.length >> 8; o[1] = a.length & 255; o.set(a, 2);
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
      async write(chunk) {
        st.got = true;
        const k = await take(chunk.length);
        if (k <= 0) return shut();
        send(k < chunk.length ? chunk.subarray(0, k) : chunk);
        if (k < chunk.length) shut();
      },
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
    if (st.closed) return;
    if (st.udp) { const k = await take(c.length); if (k < c.length) return shut(); return dns(c); }
    if (st.writer) {
      const k = await take(c.length);
      if (k <= 0) return shut();
      await st.writer.write(k < c.length ? c.subarray(0, k) : c);
      if (k < c.length) shut();
      return;
    }
    const h = parseVless(c);
    if (!h) return shut();
    let u = await getUser(env, h.uuid);
    if (!u || !u.enabled) return shut();
    if (u.start_on_use && !u.expire && u.exp_days) {
      const r = await env.DB.prepare('UPDATE zx_users SET expire=? WHERE id=? AND expire=0 RETURNING expire').bind(now() + u.exp_days * 86400, u.id).first();
      u = { ...u, expire: r ? r.expire : u.expire };
      cache.delete(u.id);
    }
    if (u.expire && u.expire <= now()) return shut();
    if (!(await ipOk(env, u, ip))) return shut();
    if (!targetAllowed(h.addr, h.port) && h.cmd === 1) return shut();
    st.user = u; st.ver = h.ver;
    const P = poolOf(u.id);
    P.conns++; P.dead = false; P.limited = !!(u.quota || u.daily_quota);
    st.P = P;
    st.timer = setInterval(() => {
      dailyPend += st.dstat; st.dstat = 0;
      ctx.waitUntil((async () => { await flushPool(env, P, false); await flushDaily(env, false); if (P.dead) shut(); })());
    }, tick);
    if (P.limited && !P.budget) { await refill(1); if (P.denied && !P.budget) return shut(); }
    if (h.cmd === 2) {
      if (h.port !== 53) return shut();
      st.udp = true;
      const k = await take(h.payload.length);
      if (k < h.payload.length) return shut();
      return dns(h.payload);
    }
    if (h.cmd !== 1) return shut();
    if (h.payload.length) {
      const k = await take(h.payload.length);
      if (k < h.payload.length) return shut();
    }
    return open(h.addr, h.port, h.payload, false);
  }

  server.addEventListener('message', (e) => { if (typeof e.data !== 'string') enqueue(new Uint8Array(e.data)); });
  server.addEventListener('close', shut);
  server.addEventListener('error', shut);
  if (early) { try { const d = b64uDecode(early); if (d.length >= 24) enqueue(d); } catch (e) { /* not early data */ } }
  return new Response(null, { status: 101, webSocket: client, ...(early ? { headers: { 'Sec-WebSocket-Protocol': early } } : {}) });
}
