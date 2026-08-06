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
import { signToken, verifyToken, checkPin, verifyPin, rosterProof } from './auth.js';
import { ROLE, isManagerRole, houseInScope, canManage } from './roles.js';
import { canRead, canWriteAction, canOpenPage, navByRole } from './access.js';

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
// FALLBACK login-roster names only. The picker is normally built from the LIVE active roster
// (getLoginNames → doGet('users')); this hardcoded list is used solely when that read is unavailable
// (a deploy-order window or an upstream outage) so the login page can never present an empty picker.
// It mirrors the seeded SEED_USERS (setup.gs); a guard test asserts the two stay in sync.
const DEFAULT_LOGIN_NAMES = ['רועי', 'אולגה', 'סנדרה', 'רמי', 'צחי', 'שירה', 'יעקב', 'אורן', 'אביב'];
// buildClientShim(names) → the injected <head> shim, with `names` as the login picker's roster. Built
// per-request from the live active roster so the picker always reflects who can actually log in (a
// renamed/added/deactivated user in the Users sheet is reflected within one micro-cache TTL) — no more
// hardcoded roster drift where the dropdown lists a name that no longer matches a roster row.
function buildClientShim(names) {
  return `<script>(function(){
  var TOKEN=null,authPromise=null,origFetch=window.fetch.bind(window);
  window.__EXEC_URL__='/api/exec'; window.__STAFF_TOKEN__='';
  try{sessionStorage.setItem('ezone_staff_token','1');}catch(e){}
  var NAMES=${JSON.stringify(names)};
  // Role → ordered nav links the role may open (from src/access.js — single source of truth, no drift).
  // Display only; the server + Code.gs data gates are the authority.
  var NAV_BY_ROLE=${JSON.stringify(navByRole())};
  // Session persistence (bug fix): the token is kept in localStorage so ONE login is valid across
  // every page AND every tab until it expires — navigating no longer re-prompts. localStorage is
  // shared across tabs (sessionStorage is not) and survives full-page navigations. The stored value
  // carries an expiry mirrored from the server's SESSION_DAYS; the server token's own exp claim stays
  // authoritative (an expired/invalid token → 401 → we clear and re-login). No password is ever stored.
  var STORE_KEY='ezone_session';
  function loadSession(){
    try{
      var raw=localStorage.getItem(STORE_KEY); if(!raw)return null;
      var s=JSON.parse(raw);
      if(!s||!s.token||!(s.exp>Date.now())){localStorage.removeItem(STORE_KEY);return null;}
      return s;
    }catch(e){return null;}
  }
  function saveSession(tok,role,scope,days){
    try{
      var d=Number(days)>0?Number(days):7;
      localStorage.setItem(STORE_KEY,JSON.stringify({token:tok,role:role||'',scope:scope||'',exp:Date.now()+d*864e5}));
    }catch(e){}
  }
  function clearSession(){try{localStorage.removeItem(STORE_KEY);}catch(e){}}
  function applySession(s){TOKEN=s.token;window.__STAFF_TOKEN__='1';window.__ROLE__=s.role||'';window.__SCOPE__=s.scope||'';}
  // Rehydrate any still-valid session BEFORE the page's own scripts run, so a manager who logged in on
  // one page arrives at the request list already authenticated (and reads all houses, as their role).
  var _boot=loadSession(); if(_boot)applySession(_boot);
  function el(t,s,txt){var e=document.createElement(t);if(s)e.setAttribute('style',s);if(txt!=null)e.textContent=txt;return e;}
  // Sign-out (התנתקות): tokens are STATELESS HMAC — there is no server-side session to revoke, so
  // clearing the persisted token client-side is a complete sign-out. Clear localStorage + the in-memory
  // token, then reload → the shim finds no session and shows the login prompt. A fixed control is
  // injected on EVERY page (the shim runs on all routes), so sign-out is always one tap away.
  function signOut(){clearSession();TOKEN=null;authPromise=null;window.__STAFF_TOKEN__='';window.__ROLE__='';window.__SCOPE__='';try{location.reload();}catch(e){}}
  function mountSignOut(){
    function m(){
      if(!document.body||document.getElementById('ezone-signout'))return;
      var b=el('button','position:fixed;bottom:12px;inset-inline-start:12px;z-index:99998;min-height:36px;padding:6px 14px;border-radius:999px;border:1px solid #143a30;background:#0e211b;color:#eef1f5;font-family:system-ui,Arial,sans-serif;font-size:13px;font-weight:700;cursor:pointer;direction:rtl;opacity:.9;box-shadow:0 4px 14px rgba(0,0,0,.4)','התנתקות');
      b.id='ezone-signout';b.setAttribute('type','button');b.setAttribute('aria-label','התנתקות');
      b.addEventListener('click',signOut);
      document.body.appendChild(b);
    }
    if(document.body)m();else document.addEventListener('DOMContentLoaded',m);
  }
  // Role-based nav — render ONLY the links the session role may open (from NAV_BY_ROLE), and REDIRECT
  // away from a page the role may not open. Both layers are DISPLAY/UX only: the server + Code.gs data
  // gates are the security authority (a coordinator who bypasses this still gets 403 on every disallowed
  // action). The static per-page .nav markup is replaced wholesale so every page shows exactly the
  // permitted set — no per-page edits, and a restricted role never briefly sees links it can't open.
  function norm(p){p=String(p||'/');var q=p.indexOf('?');if(q!==-1)p=p.slice(0,q);if(p==='/index.html'||p==='/index')return '/';p=p.replace(/\\.html$/,'');return p===''?'/':p;}
  function navLinks(){var r=String(window.__ROLE__||'');return NAV_BY_ROLE[r]||[{href:'/',label:'דרישה חדשה'}];}
  function allowedHere(){var here=norm(location.pathname);return navLinks().some(function(l){return l.href===here;});}
  function mountNav(){
    function m(){
      var role=String(window.__ROLE__||''),here=norm(location.pathname);
      // Only bounce a KNOWN, authenticated role off a page it may not open. NEVER redirect a logged-out
      // view (role==='' — the login overlay owns the screen) and never redirect the request form '/'
      // itself. This guarantees the redirect logic can never fire on, or interfere with, the login page.
      if(role && here!=='/' && !allowedHere()){try{location.replace('/');}catch(e){}return;}
      var nav=document.querySelector('.nav'); if(!nav)return;
      nav.innerHTML='';
      navLinks().forEach(function(l){
        var a=document.createElement('a');a.setAttribute('href',l.href);a.textContent=l.label;
        if(norm(l.href)===here)a.className='active';
        nav.appendChild(a);
      });
    }
    if(document.body)m();else document.addEventListener('DOMContentLoaded',m);
  }
  if(_boot){mountSignOut();mountNav();}
  function doLogin(){return new Promise(function(resolve){
    function mount(){
      var ov=el('div','position:fixed;inset:0;z-index:99999;background:#071410;display:flex;align-items:center;justify-content:center;direction:rtl;font-family:system-ui,Arial,sans-serif');
      var card=el('div','background:#0e211b;border:1px solid #143a30;border-radius:14px;padding:24px;width:min(92vw,340px);box-shadow:0 10px 40px rgba(0,0,0,.5)');
      var h=el('div','color:#eef1f5;font-size:1.15rem;font-weight:800;margin-bottom:14px','כניסה — לוגיסטיקה');
      var sel=el('select','width:100%;min-height:44px;font-size:16px;margin-bottom:10px;border-radius:8px;padding:6px');
      NAMES.forEach(function(n){var o=el('option',null,n);o.value=n;sel.appendChild(o);});
      var pin=el('input','width:100%;min-height:44px;font-size:16px;margin-bottom:10px;border-radius:8px;padding:6px');
      pin.type='password';pin.setAttribute('autocomplete','off');pin.placeholder='סיסמה או קוד גישה';
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
          if(res.s===200&&res.j&&res.j.token){saveSession(res.j.token,res.j.role,res.j.scope,res.j.expiresInDays);applySession({token:res.j.token,role:res.j.role,scope:res.j.scope});if(ov.parentNode)ov.parentNode.removeChild(ov);mountSignOut();mountNav();resolve();}
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
        if(r.status===401){TOKEN=null;authPromise=null;clearSession();return ensureAuth().then(function(){headers['Authorization']='Bearer '+TOKEN;return origFetch(target,Object.assign({},init,{headers:headers}));});}
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
}

// The default shim (fallback names), exported for the shim-behavior tests that run it in a sandbox.
const CLIENT_SHIM = buildClientShim(DEFAULT_LOGIN_NAMES);

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
  '/management': 'management.html', '/management.html': 'management.html',
  '/events': 'events.html', '/events.html': 'events.html',
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

// Single active-user predicate — the ONE place that decides who is in the login roster. Used by BOTH
// the login PICKER (server-injected name list) and the login VERIFICATION (handleLogin), so the two can
// never disagree about who is active. Tolerant of how the Users.active cell reads back (boolean TRUE from
// a checkbox, or the text 'TRUE'/'true'/'1' from a hand edit); trims stray whitespace on string values.
function isActiveUser(u) {
  if (!u) return false;
  const a = u.active;
  if (a === true || a === 1) return true;
  const s = String(a == null ? '' : a).trim().toUpperCase();
  return s === 'TRUE' || s === '1';
}

// The login-roster name list, derived from the LIVE users read — the single shared users-read path the
// login picker and login verification both go through. Returns the ACTIVE users' names (trimmed, de-duped,
// blanks dropped), in sheet order. On an empty/failed roster read the caller falls back to
// DEFAULT_LOGIN_NAMES so the picker is never blank. Names are non-secret (the picker has always listed
// them); pin_hash is never touched here.
function loginRosterNames(users) {
  if (!Array.isArray(users)) return [];
  const seen = new Set();
  const out = [];
  for (const u of users) {
    if (!isActiveUser(u)) continue;
    const name = String((u && u.name) == null ? '' : u.name).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Read a data action from Apps Script (server-to-server). Returns the `data` array, or null on any
// failure. `extra` adds query params (e.g. the roster proof). Used for the login roster + read scoping.
async function fetchAppsScriptData(action, extra) {
  if (!EXEC_URL) return null;
  const qs = new URLSearchParams({ action });
  if (extra) for (const [k, v] of Object.entries(extra)) qs.set(k, v);
  try {
    const r = await fetch(`${EXEC_URL}?${qs.toString()}`, {
      method: 'GET', redirect: 'follow', headers: { Accept: 'application/json' },
    });
    const j = await r.json();
    return (j && j.data) || null;
  } catch (e) {
    return null;
  }
}

// ---- Node micro-cache for STABLE reference reads (perf round-2) ----
// houses/config/technicians change rarely and are fetched on nearly every page load. Cache them in
// process memory (~120 s TTL) so tab switches skip the Node→Apps Script hop (one 302 + Apps Script
// cold-start each). NEVER cache users (auth roster, must stay live per the #60 fix) or requests (change
// constantly — write→read freshness). A hand edit to Houses/Config propagates within the TTL. (Node's
// built-in fetch/undici already keeps Node→Apps Script connections alive by default, so no Agent change.)
const NODE_CACHEABLE = new Set(['houses', 'config', 'technicians']);
const NODE_CACHE_TTL_MS = 120000;
const nodeCache = new Map(); // action -> { value, exp }

function nodeCacheGet(action) {
  const e = nodeCache.get(action);
  if (e && e.exp > Date.now()) return e.value;
  if (e) nodeCache.delete(action);
  return null;
}
function nodeCachePut(action, value) {
  if (!NODE_CACHEABLE.has(action)) return; // hard guard: never users/requests/etc.
  nodeCache.set(action, { value, exp: Date.now() + NODE_CACHE_TTL_MS });
}
function _resetNodeCache() { nodeCache.clear(); loginNamesCache = null; }

// ---- Login-picker roster names (server-injected into the shim) ----
// The picker needs the roster BEFORE any login, so it can't go through the Bearer-gated /api/data users
// read. We fetch the PUBLIC roster (no proof → pin_hash already stripped by Code.gs), keep only ACTIVE
// names, and cache that NAME LIST briefly. This is safe to cache where the auth roster is not: it holds
// no secret (names only), and login VERIFICATION still reads the roster LIVE with the proof (handleLogin)
// — so a just-added user is verifiable immediately even if the picker lists them a TTL later. A blank/failed
// read is NOT cached and falls back to DEFAULT_LOGIN_NAMES, so the picker is never empty and self-heals.
let loginNamesCache = null; // { value: string[], exp: number } | null
async function getLoginNames() {
  if (loginNamesCache && loginNamesCache.exp > Date.now()) return loginNamesCache.value;
  const users = await fetchAppsScriptData('users'); // public read (pin_hash stripped upstream)
  const names = loginRosterNames(users);
  if (!names.length) return DEFAULT_LOGIN_NAMES; // roster unavailable/empty → fallback, don't cache
  loginNamesCache = { value: names, exp: Date.now() + NODE_CACHE_TTL_MS };
  return names;
}

// Fetch several read-sheets from Apps Script in ONE round-trip via the `bundle` action. Returns a map
// { action: rows[] } or null when bundle is unavailable (unknown action / upstream error). null triggers
// the individual-read FALLBACK in handlePageData — see fetchActionsIndividually.
async function fetchBundle(actions) {
  if (!EXEC_URL || !actions.length) return {};
  const qs = new URLSearchParams({ action: 'bundle', sheets: actions.join(',') });
  try {
    const r = await fetch(`${EXEC_URL}?${qs.toString()}`, { method: 'GET', redirect: 'follow', headers: { Accept: 'application/json' } });
    const j = await r.json();
    // A bundle-aware Apps Script returns { ok:true, data:{…} }. An OLD deploy (deploy-order window) that
    // doesn't know `bundle` returns { ok:false, error:'Unknown or missing action' } → null → fall back.
    return (j && j.ok && j.data && typeof j.data === 'object') ? j.data : null;
  } catch (e) {
    return null;
  }
}

// FALLBACK for a mixed-version deploy window: when the `bundle` action is unavailable (new Node reached an
// old Apps Script that predates it), fetch each action the PROVEN individual way, in parallel. Returns a
// { action: data } map, or null only if EVERY individual read also failed (genuine upstream outage). This
// is why a deploy-order skew can no longer take the app down — pageData degrades to the pre-aggregation
// behavior instead of 502ing. (The login path never comes here; it reads the roster directly.)
async function fetchActionsIndividually(actions) {
  const results = await Promise.all(actions.map((a) => fetchAppsScriptData(a)));
  if (results.every((r) => r === null)) return null; // upstream truly down → let caller 502
  const out = {};
  actions.forEach((a, i) => { out[a] = results[i] == null ? (a === 'config' ? {} : []) : results[i]; });
  return out;
}

// The read-actions each page needs for its initial render. pageData collapses these into ONE browser
// call and ONE Apps Script call. The SAME per-action role gate (canRead) + requests scope-filter as the
// individual reads are applied below — enforcement/scoping is identical, just aggregated.
const PAGE_ACTIONS = {
  dashboard: ['requests', 'config', 'houses', 'findings', 'inspections'],
  workorders: ['requests', 'findings', 'inspections', 'houses'],
  reports: ['findings', 'houses', 'inspections'],
  inventory: ['houses', 'inventoryItems', 'inventoryCounts'],
  inspection: ['houses', 'checklist'],
  events: ['config', 'houses'],
};

// One aggregated read for a page: Bearer-gated, role-gated per action (identical to handleData), stable
// sheets served from the Node micro-cache, the rest fetched in ONE bundle call, requests scope-filtered
// for tier B exactly as the individual `requests` read. Never returns users.
async function handlePageData(res, actor, page) {
  const actions = PAGE_ACTIONS[page];
  if (!actions) return sendJson(res, 400, { ok: false, error: 'unknown page' });
  // Same read gate as the individual endpoints — a role that may not read one of the page's actions is
  // refused the whole aggregate (matches: it could not load that page's data individually either).
  for (const a of actions) {
    if (!canRead(actor.role, a)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  const data = {};
  const toFetch = [];
  for (const a of actions) {
    const cached = NODE_CACHEABLE.has(a) ? nodeCacheGet(a) : null;
    if (cached) data[a] = cached; else toFetch.push(a);
  }
  // `degraded` is set when this request had to take the individual-read FALLBACK because the live Apps
  // Script did not answer `bundle`. It is surfaced on the 200 response (and warn-logged) so a stale
  // deployment is OBSERVABLE instead of silently making every tab switch N slow round-trips: the
  // post-deploy smoke test fails on it, telling us clasp CI hasn't published the current Code.gs. It is
  // NOT sticky — the next request re-attempts bundle, so the moment the deploy lands the flag clears.
  let degraded = false;
  if (toFetch.length) {
    // ONE bundle round-trip; if bundle is unavailable (deploy-order window with an old Apps Script),
    // fall back automatically to the individual reads so a mixed-version deploy can never 502 the page.
    let bundle = await fetchBundle(toFetch);
    if (!bundle) {
      degraded = true;
      console.warn('[pageData] bundle unavailable — individual-read fallback taken (live Apps Script lacks `bundle`? check clasp CI deploy)');
      bundle = await fetchActionsIndividually(toFetch);
    }
    if (!bundle) return sendJson(res, 502, { ok: false, error: 'upstream_error' });
    for (const a of toFetch) {
      data[a] = Array.isArray(bundle[a]) ? bundle[a] : (bundle[a] || (a === 'config' ? {} : []));
      nodeCachePut(a, data[a]); // no-op unless a is cacheable
    }
  }
  // Scope requests for tier B exactly as handleData does (managers get the unfiltered list).
  if (Array.isArray(data.requests) && !isManagerRole(actor.role)) {
    if (actor.role !== ROLE.COORDINATOR && actor.role !== ROLE.MAINTENANCE) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }
    const houses = data.houses || nodeCacheGet('houses') || (await fetchAppsScriptData('houses')) || [];
    const clusterOf = {};
    for (const h of houses) clusterOf[String(h.name)] = String(h.cluster || '');
    data.requests = data.requests.filter((r) =>
      houseInScope(actor.role, actor.scope, r.house, clusterOf[String(r.house)] || ''));
  }
  const out = { ok: true, data };
  if (degraded) out.degraded = true; // only present when the fallback was taken — clients may ignore it
  return sendJson(res, 200, out);
}

// Verify the Bearer token; returns the decoded actor { name, role, scope, ... } and the raw token,
// or null.
function authFromRequest(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const token = m ? m[1] : '';
  const actor = verifyToken(SESSION_SECRET, token);
  return actor ? { actor, token } : null;
}

// Two access tiers (increment 31). tier A (רועי, אולגה) each have a personal password in the
// Users.pin_hash column; tier B (coordinators + maintenance) share APP_PIN; סנדרה (ceo, no pin_hash)
// and any manager without a pin_hash have NO login path. All failures return the SAME generic 401 —
// never revealing which tier a name belongs to. The PIN/password is never logged.
async function handleLogin(req, res) {
  const ip = clientIp(req);
  const generic401 = () => sendJson(res, 401, { ok: false, error: 'שם או סיסמה שגויים' });
  if (!rateLimitLogin(ip)) {
    return sendJson(res, 429, { ok: false, error: 'יותר מדי ניסיונות. נסו שוב מאוחר יותר.' });
  }
  const body = await readJsonBody(req, 4096);
  const name = (body && typeof body.name === 'string') ? body.name : '';
  const pw = (body && body.pin != null) ? String(body.pin) : '';

  // Read the roster WITH pin_hash via the server-to-server proof (Apps Script returns hashes only to
  // this proof; public reads get them stripped).
  const users = await fetchAppsScriptData('users', { auth: rosterProof(SESSION_SECRET) });
  if (!users) { console.warn(`[login] roster unavailable for ${ip}`); return generic401(); }
  const user = users.find((u) => String(u.name) === String(name) && isActiveUser(u));

  let ok = false;
  if (user) {
    const pinHash = String(user.pin_hash || '');
    if (pinHash) {
      // tier A — verify against THIS user's personal password hash.
      ok = verifyPin(pw, pinHash);
    } else if (user.role === ROLE.COORDINATOR || user.role === ROLE.MAINTENANCE) {
      // tier B — the shared PIN (only these roles; ceo/managers without a hash have no path).
      ok = checkPin(pw, APP_PIN);
    }
  }
  if (!ok) {
    console.warn(`[login] failed attempt from ${ip} for name=${JSON.stringify(name)}`);
    return generic401();
  }

  const scope = String(user.house || ''); // '' for managers (all houses); house/cluster for tier B
  const token = signToken(SESSION_SECRET, SESSION_DAYS, { name, role: user.role, scope });
  // role + scope are the user's OWN, non-secret facts — returned so the UI can adapt (e.g. lock the
  // request form to their house). They are never the security control: the server filters reads and
  // 403s out-of-scope writes regardless of what the browser does.
  return sendJson(res, 200, { ok: true, token, name, role: user.role, scope, expiresInDays: SESSION_DAYS });
}

// Read proxy — Bearer-gated + role/scope-enforced. Forwards an allowlisted set of query keys.
const ALLOWED_QUERY_KEYS = new Set(['action', 'house', 'month', 'week_start', 'id']);
// Per-role read visibility lives in src/access.js canRead(): houses/config/requests are open to every
// role (requests scope-filtered below); users + the manager-only reads (technicians, checklist,
// inspections, findings, inventoryItems, inventoryCounts, events) are manager-tier. This is the
// session-aware server-side read gate — the Apps Script doGet carries no identity, so it lives here.

async function handleData(req, res, url) {
  const auth = authFromRequest(req);
  if (!auth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  const { actor } = auth;
  const action = url.searchParams.get('action') || '';
  const manager = isManagerRole(actor.role);

  // Aggregated per-page read (perf round-2): ONE call for a page's whole dataset. Role-gated + scoped
  // identically to the individual reads (inside handlePageData).
  if (action === 'pageData') {
    return handlePageData(res, actor, url.searchParams.get('page') || '');
  }

  // Role-based read gate (src/access.js). A role that may not read this action gets 403 — no upstream call.
  if (!canRead(actor.role, action)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  // Stable reference reads (houses/config/technicians) are served from the Node micro-cache so tab
  // switches skip the Apps Script hop. Never users/requests (not in NODE_CACHEABLE).
  if (NODE_CACHEABLE.has(action)) {
    const hit = nodeCacheGet(action);
    if (hit !== null) return sendJson(res, 200, { ok: true, data: hit });
  }

  const qs = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()) {
    if (ALLOWED_QUERY_KEYS.has(k)) qs.set(k, v);
  }
  const target = `${EXEC_URL}${qs.toString() ? `?${qs.toString()}` : ''}`;
  let payload;
  try {
    const upstream = await fetch(target, { method: 'GET', redirect: 'follow', headers: { Accept: 'application/json' } });
    payload = await upstream.json();
  } catch (err) {
    return sendJson(res, 502, { ok: false, error: 'upstream_error' });
  }

  // Populate the micro-cache for stable reads on a successful upstream response.
  if (NODE_CACHEABLE.has(action) && payload && payload.ok && 'data' in payload) {
    nodeCachePut(action, payload.data);
  }

  // Post-process per action for scope/secret hygiene.
  if (payload && payload.ok && Array.isArray(payload.data)) {
    if (action === 'users') {
      // The roster is manager-only, and pin_hash is NEVER exposed to the browser.
      if (!manager) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      payload.data = payload.data.map((u) => { const c = Object.assign({}, u); delete c.pin_hash; return c; });
    } else if (action === 'requests' && !manager) {
      // Managers (field_ops / ops_manager / ceo) never reach here — they get the unfiltered list above.
      // Tier B sees ONLY their in-scope houses. Any OTHER role is an invalid session for a scoped read:
      // fail CLOSED with a loud 403 rather than silently returning an empty filtered list (which is how
      // a role/roster mismatch used to hide as "manager sees nothing").
      if (actor.role !== ROLE.COORDINATOR && actor.role !== ROLE.MAINTENANCE) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' });
      }
      const houses = (await fetchAppsScriptData('houses')) || [];
      const clusterOf = {};
      for (const h of houses) clusterOf[String(h.name)] = String(h.cluster || '');
      payload.data = payload.data.filter((r) =>
        houseInScope(actor.role, actor.scope, r.house, clusterOf[String(r.house)] || ''));
    } else if (action === 'preventiveDaily' && !manager) {
      // The daily preventive checklist is scoped for a maintenance lead exactly like requests: only rows for
      // houses in their cluster scope. (canRead already refused every non-maintenance non-manager role.)
      const houses = (await fetchAppsScriptData('houses')) || [];
      const clusterOf = {};
      for (const h of houses) clusterOf[String(h.name)] = String(h.cluster || '');
      payload.data = payload.data.filter((r) =>
        houseInScope(actor.role, actor.scope, r.house, clusterOf[String(r.house)] || ''));
    }
  }
  return sendJson(res, 200, payload);
}

// Exec-only writes (ops_manager + ceo), beyond managementData/updateEvent: the /management readiness
// checklists (opening / emergency) and the compliance-entry delete. Mirrored by canManage in Code.gs.
// Exec-only writes (ops_manager + ceo): the training-log delete + the (legacy) compliance delete. The
// readiness writes (add/update/deleteReadinessItem) are NO LONGER here — they moved to manager-tier
// (field_ops edits the opening/emergency checklists from /workorders), gated by canWriteAction + Code.gs.
const MANAGE_ONLY_ACTIONS = new Set(['deleteCompliance', 'deleteTraining']);

// Write proxy — Bearer-gated. The actor is taken from the verified token (never the client body);
// the token is forwarded so Code.gs verifies it independently and enforces the role rules.
async function handleAction(req, res) {
  const auth = authFromRequest(req);
  if (!auth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  const { actor } = auth;
  const body = await readJsonBody(req, 65536);
  if (!body || typeof body.action !== 'string') {
    return sendJson(res, 400, { ok: false, error: 'missing action' });
  }
  // Role-based write gate (src/access.js, mirrored in Code.gs). Tier B is limited to createRequest
  // (+ createEvent for coordinators); every other write is refused here with no upstream call. Manager
  // roles pass and are then subject to the precise per-action checks below + in each Code.gs handler.
  if (!canWriteAction(actor.role, body.action)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  // /management is exec-only (ops_manager + ceo). Enforced here (server-side) AND independently in
  // Code.gs — field_ops and every tier-B role get 403 with no data read.
  if (body.action === 'managementData' && !canManage(actor.role)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  // Exceptional-events register (אירועים חריגים). Reporting is closed to maintenance; editing/closing an
  // event is exec-only. Enforced here (server-side) AND independently in Code.gs (which also enforces the
  // coordinator own-house-only scope on create). A blocked role gets 403 with no upstream call.
  if (body.action === 'createEvent' && actor.role === ROLE.MAINTENANCE) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  if (body.action === 'updateEvent' && !canManage(actor.role)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  // /management readiness checklists + compliance delete are exec-only (ops_manager + ceo), same as
  // managementData. Enforced here (server-side) AND independently in Code.gs. field_ops passes the tier
  // gate above but is NOT an exec, so it gets 403 here with no upstream call.
  if (MANAGE_ONLY_ACTIONS.has(body.action) && !canManage(actor.role)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
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
    // Build the shim with the LIVE active-roster names (cached; falls back to DEFAULT_LOGIN_NAMES if the
    // roster read is unavailable) so the login picker always matches who can actually log in.
    const shim = buildClientShim(await getLoginNames());
    html = html.replace('</head>', HEAD_INJECT + shim + '</head>');
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
// Exported so a guard test can enumerate EVERY served HTML route and assert each carries the auth
// shim (a page missing it would re-prompt for login — the bug this guards against).
export { HTML_ROUTES as _HTML_ROUTES };
// Exported so a test can run the shim in a sandbox and exercise the sign-out flow (clear + reload).
export { CLIENT_SHIM as _CLIENT_SHIM };
// Exported so tests can reset the Node micro-cache between cases (deterministic cache/TTL assertions).
export { _resetNodeCache, PAGE_ACTIONS as _PAGE_ACTIONS };
// Exported for the login-roster tests: the shared active-user filter, the roster→names derivation, the
// per-request shim builder, and the hardcoded fallback list (asserted in sync with the seed).
export { isActiveUser, loginRosterNames, buildClientShim, getLoginNames, DEFAULT_LOGIN_NAMES as _DEFAULT_LOGIN_NAMES };
