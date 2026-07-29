// server.js — zero-dependency Node server for the frontend AND the auth/data gateway.
//
// Increment 30 brought auth to the ezone-managers / ezone-staffing standard:
//   - fail-closed startup: the server REFUSES TO START if any required secret is missing/empty
//   - POST /api/login { name, pin } → HMAC-signed session token carrying name + role + issued-at
//   - rate-limited login (8 attempts / 15 min per IP, fail-closed, in-memory)
//   - Bearer-gated data gateway: /api/data (reads) and /api/action (writes) proxy to Apps Script;
//     the actor is resolved from the verified token, never from a client-supplied field, and the
//     token is FORWARDED so apps-script/Code.gs verifies it independently (Node is never trusted).
//
// Secrets live ONLY in Railway env vars (and, for the shared SESSION_SECRET, the Apps Script Script
// Properties) — never in the repo, never injected into page HTML.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { signToken, verifyToken, checkPin } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tiny .env loader (no dependency). Only used locally; Railway injects real env vars.
function loadEnv() {
  const path = join(__dirname, '..', '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const EXEC_URL = process.env.APPS_SCRIPT_EXEC_URL || '';
const APP_PIN = process.env.APP_PIN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 0;

const PUBLIC = join(__dirname, 'public');

const HEAD_INJECT =
  '<link rel="manifest" href="/manifest.json">'
  + '<meta name="theme-color" content="#071410">'
  + '<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32-v1.png">'
  + '<link rel="apple-touch-icon" href="/icon-v1-192.png">'
  + '<meta name="apple-mobile-web-app-capable" content="yes">'
  + '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
  + '<meta name="apple-mobile-web-app-title" content="Logistics">';

// Client auth shim (increment 30). Injected into every page's <head> so it runs BEFORE the page's
// own inline scripts. It replaces the old shared-code gate with an identity login overlay and keeps
// the session token IN MEMORY ONLY (never localStorage/sessionStorage, so it can't leak). Existing
// pages still call `fetch(window.__EXEC_URL__ ...)`; the shim points that sentinel at a Bearer-gated
// proxy and rewrites GET→/api/data, POST→/api/action, attaching Authorization on every call. The
// legacy per-page staffGate() is neutralized by pre-setting its sessionStorage flag (a non-secret
// '1', not the token). Names are not secret, so the login picker lists them; the server still
// verifies name+PIN and resolves the role from the Users sheet.
const LOGIN_NAMES = ['רועי', 'אולגה', 'סנדרה', 'רמי', 'צחי', 'שירה', 'יעקב', 'אורן', 'אביב'];
const CLIENT_SHIM = `<script>(function(){
  var TOKEN=null,authPromise=null,origFetch=window.fetch.bind(window);
  window.__EXEC_URL__='/api/exec'; window.__STAFF_TOKEN__='';
  try{sessionStorage.setItem('ezone_staff_token','1');}catch(e){}
  var NAMES=${JSON.stringify(LOGIN_NAMES)};
  function el(t,s,txt){var e=document.createElement(t);if(s)e.setAttribute('style',s);if(txt!=null)e.textContent=txt;return e;}
  function doLogin(){return new Promise(function(resolve){
    function mount(){
      var ov=el('div','position:fixed;inset:0;z-index:99999;background:#071410;display:flex;align-items:center;justify-content:center;direction:rtl;font-family:system-ui,Arial,sans-serif');
      var card=el('div','background:#0e211b;border:1px solid #143a30;border-radius:14px;padding:24px;width:min(92vw,340px);box-shadow:0 10px 40px rgba(0,0,0,.5)');
      var h=el('div','color:#eef1f5;font-size:1.15rem;font-weight:800;margin-bottom:14px','כניסה — לוגיסטיקה');
      var sel=el('select','width:100%;min-height:44px;font-size:16px;margin-bottom:10px;border-radius:8px;padding:6px');
      NAMES.forEach(function(n){var o=el('option',null,n);o.value=n;sel.appendChild(o);});
      var pin=el('input','width:100%;min-height:44px;font-size:16px;margin-bottom:10px;border-radius:8px;padding:6px');
      pin.type='password';pin.setAttribute('inputmode','numeric');pin.setAttribute('autocomplete','off');pin.placeholder='קוד גישה';
      var btn=el('button','width:100%;min-height:44px;font-size:16px;font-weight:700;border:0;border-radius:8px;background:#00bfa5;color:#04150f;cursor:pointer','כניסה');
      var err=el('div','color:#ff8a80;font-size:.9rem;margin-top:10px;min-height:1.1em','');
      card.appendChild(h);card.appendChild(sel);card.appendChild(pin);card.appendChild(btn);card.appendChild(err);ov.appendChild(card);
      document.body.appendChild(ov);pin.focus();
      function attempt(){
        err.textContent='';btn.disabled=true;
        origFetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:sel.value,pin:pin.value})})
        .then(function(r){return r.json().then(function(j){return{s:r.status,j:j};});})
        .then(function(res){
          btn.disabled=false;
          if(res.s===200&&res.j&&res.j.token){TOKEN=res.j.token;window.__STAFF_TOKEN__='1';if(ov.parentNode)ov.parentNode.removeChild(ov);resolve();}
          else if(res.s===429){err.textContent='יותר מדי ניסיונות. נסו שוב מאוחר יותר.';}
          else{err.textContent='שם או קוד שגויים';pin.value='';pin.focus();}
        }).catch(function(){btn.disabled=false;err.textContent='שגיאת רשת';});
      }
      btn.addEventListener('click',attempt);
      pin.addEventListener('keydown',function(e){if(e.key==='Enter')attempt();});
    }
    if(document.body)mount();else document.addEventListener('DOMContentLoaded',mount);
  });}
  function ensureAuth(){if(TOKEN)return Promise.resolve();if(!authPromise)authPromise=doLogin();return authPromise;}
  function route(url,init){
    var method=String((init&&init.method)||'GET').toUpperCase();
    return ensureAuth().then(function(){
      var headers=Object.assign({},(init&&init.headers)||{});headers['Authorization']='Bearer '+TOKEN;
      var ni=Object.assign({},init,{headers:headers});
      var target;
      if(method==='POST'){target='/api/action';}
      else{var qs=url.indexOf('?')>=0?url.slice(url.indexOf('?')):'';target='/api/data'+qs;}
      return origFetch(target,ni).then(function(r){
        if(r.status===401){TOKEN=null;authPromise=null;return ensureAuth().then(function(){headers['Authorization']='Bearer '+TOKEN;return origFetch(target,Object.assign({},init,{headers:headers}));});}
        return r;
      });
    });
  }
  window.fetch=function(input,init){
    var url=(typeof input==='string')?input:((input&&input.url)||'');
    if(url.indexOf('/api/exec')===0)return route(url,init||{});
    return origFetch(input,init);
  };
})();</script>`;

const PUBLIC_ASSETS = {
  '/manifest.json':        { file: 'manifest.json',        type: 'application/manifest+json; charset=utf-8' },
  '/sw.js':                { file: 'sw.js',                type: 'application/javascript; charset=utf-8', noCache: true },
  '/icon-v1-192.png':      { file: 'icon-v1-192.png',      type: 'image/png' },
  '/icon-v1-512.png':      { file: 'icon-v1-512.png',      type: 'image/png' },
  '/icon-v1-maskable.png': { file: 'icon-v1-maskable.png', type: 'image/png' },
};

const HTML_ROUTES = {
  '/': 'index.html', '/index.html': 'index.html',
  '/dashboard': 'dashboard.html', '/dashboard.html': 'dashboard.html',
  '/inspection': 'inspection.html', '/inspection.html': 'inspection.html',
  '/inventory': 'inventory.html', '/inventory.html': 'inventory.html',
  '/reports': 'reports.html', '/reports.html': 'reports.html',
  '/workorders': 'workorders.html', '/workorders.html': 'workorders.html',
};

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendPng(res, name, cacheControl) {
  let body;
  try {
    body = readFileSync(join(__dirname, 'icons', name));
  } catch (e) {
    return false;
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': cacheControl });
  res.end(body);
  return true;
}

// ---- login rate limiter (in-memory, fail-closed): 8 attempts / 15 min per IP ----
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 8;

function rateLimitLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + LOGIN_WINDOW_MS;
  }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count <= LOGIN_MAX;
}

function clientIp(req) {
  // Behind Railway's proxy the socket address is the proxy for everyone, so honor the first
  // X-Forwarded-For hop when present; otherwise fall back to the socket address.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function readJsonBody(req, limitBytes) {
  return new Promise((resolve) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > (limitBytes || 65536)) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// Resolve a user's role from the Users sheet (source of truth), read via Apps Script. Fail-closed:
// returns null if the user is absent, inactive, or the roster can't be read. Never trusts a
// client-supplied role.
async function resolveUserRole(name) {
  if (!EXEC_URL || !name) return null;
  let rows;
  try {
    const r = await fetch(`${EXEC_URL}?action=users`, { method: 'GET', redirect: 'follow', headers: { Accept: 'application/json' } });
    const j = await r.json();
    rows = (j && j.data) || [];
  } catch (e) {
    return null;
  }
  for (const u of rows) {
    if (String(u.name) !== String(name)) continue;
    const active = u.active === true || u.active === 'TRUE' || u.active === 'true' || u.active === 1 || u.active === '1';
    if (!active) return null;
    return String(u.role || '') || null;
  }
  return null;
}

// Verify the Bearer token; returns the decoded actor { name, role, ... } and the raw token, or null.
function authFromRequest(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const token = m ? m[1] : '';
  const actor = verifyToken(SESSION_SECRET, token);
  return actor ? { actor, token } : null;
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (!rateLimitLogin(ip)) {
    return sendJson(res, 429, { ok: false, error: 'יותר מדי ניסיונות. נסו שוב מאוחר יותר.' });
  }
  const body = await readJsonBody(req, 4096);
  const name = (body && typeof body.name === 'string') ? body.name : '';
  const pin = (body && body.pin != null) ? String(body.pin) : '';
  if (!checkPin(pin, APP_PIN)) {
    // Log the failure WITHOUT echoing the PIN.
    console.warn(`[login] failed attempt from ${ip} for name=${JSON.stringify(name)}`);
    return sendJson(res, 401, { ok: false, error: 'קוד שגוי' });
  }
  const role = await resolveUserRole(name);
  if (!role) {
    console.warn(`[login] no active user/role for name=${JSON.stringify(name)} from ${ip}`);
    return sendJson(res, 401, { ok: false, error: 'משתמש לא מזוהה או לא פעיל' });
  }
  const token = signToken(SESSION_SECRET, SESSION_DAYS, { name, role });
  return sendJson(res, 200, { ok: true, token, name, role, expiresInDays: SESSION_DAYS });
}

// Read proxy — Bearer-gated. Forwards an allowlisted set of query keys to Apps Script.
const ALLOWED_QUERY_KEYS = new Set(['action', 'house', 'month', 'week_start', 'id']);

async function handleData(req, res, url) {
  const auth = authFromRequest(req);
  if (!auth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  const qs = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()) {
    if (ALLOWED_QUERY_KEYS.has(k)) qs.set(k, v);
  }
  const target = `${EXEC_URL}${qs.toString() ? `?${qs.toString()}` : ''}`;
  try {
    const upstream = await fetch(target, { method: 'GET', redirect: 'follow', headers: { Accept: 'application/json' } });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch (err) {
    return sendJson(res, 502, { ok: false, error: 'upstream_error' });
  }
}

// Write proxy — Bearer-gated. The actor is taken from the verified token (never the client body);
// the token is forwarded so Code.gs verifies it independently and enforces the role rules.
async function handleAction(req, res) {
  const auth = authFromRequest(req);
  if (!auth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  const body = await readJsonBody(req, 65536);
  if (!body || typeof body.action !== 'string') {
    return sendJson(res, 400, { ok: false, error: 'missing action' });
  }
  const upstreamBody = JSON.stringify({ action: body.action, payload: body.payload || {}, token: auth.token });
  try {
    const upstream = await fetch(EXEC_URL, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: upstreamBody,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch (err) {
    return sendJson(res, 502, { ok: false, error: 'upstream_error' });
  }
}

export async function requestHandler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;

  // ---- API gateway (auth + data proxy) ----
  if (path === '/api/login' && req.method === 'POST') return handleLogin(req, res);
  if (path === '/api/data' && req.method === 'GET') return handleData(req, res, url);
  if (path === '/api/action' && req.method === 'POST') return handleAction(req, res);
  if (path === '/api/health') return sendJson(res, 200, { ok: true, ts: Date.now() });
  if (path.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'not found' });

  // Static: brand PWA assets (manifest.json, sw.js, recoloured teal icons) from src/public/.
  const asset = PUBLIC_ASSETS[path];
  if (asset) {
    let body;
    try {
      body = readFileSync(join(PUBLIC, asset.file));
    } catch (e) {
      return notFound(res);
    }
    const headers = { 'Content-Type': asset.type };
    if (asset.noCache) headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    return res.end(body);
  }

  if (path === '/manifest.webmanifest') {
    try {
      const body = readFileSync(join(__dirname, 'manifest.webmanifest'));
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      return res.end(body);
    } catch (e) { return notFound(res); }
  }

  if (path === '/favicon.ico') {
    if (sendPng(res, 'favicon-32-v1.png', 'public, max-age=86400')) return;
    return notFound(res);
  }

  if (path.startsWith('/icons/')) {
    const name = path.slice('/icons/'.length);
    if (/^[A-Za-z0-9._-]+\.png$/.test(name)
        && sendPng(res, name, 'public, max-age=31536000, immutable')) {
      return;
    }
    return notFound(res);
  }

  // HTML routes — inject the PWA head links. (No secret is injected: data goes through the
  // Bearer-gated /api proxy, so the /exec URL never reaches the page source.)
  const file = HTML_ROUTES[path];
  if (file) {
    let html = readFileSync(join(__dirname, file), 'utf8');
    html = html.replace('</head>', HEAD_INJECT + CLIENT_SHIM + '</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(html);
  }

  notFound(res);
}

const server = createServer(requestHandler);

function fatal(msg) {
  console.error(`[fatal] ${msg}`);
  process.exit(1);
}

// Only validate + bind when run directly (node src/server.js / npm start). Importing the module —
// e.g. from the test suite — gets requestHandler without the startup checks or a listener.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  // Fail closed: refuse to start if any required secret/config is missing or empty. No defaults,
  // no fallbacks — a missing SESSION_SECRET before deploy is intended to stop the server, not to
  // silently run without auth.
  if (!SESSION_SECRET) fatal('SESSION_SECRET is required');
  if (SESSION_SECRET.length < 32) fatal('SESSION_SECRET must be at least 32 chars');
  if (!process.env.SESSION_DAYS || !(SESSION_DAYS > 0)) fatal('SESSION_DAYS is required (a positive number)');
  if (!EXEC_URL) fatal('APPS_SCRIPT_EXEC_URL is required');
  if (!APP_PIN) fatal('APP_PIN is required');

  server.listen(PORT, () => {
    console.log(`EZone Logistics gateway on http://localhost:${PORT}`);
  });
}

export { loginAttempts as _loginAttempts };
