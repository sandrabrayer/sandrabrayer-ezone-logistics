// server.js — zero-dependency Node server for the frontend AND the auth/data gateway.
//
// Increment 30 brought auth to the ezone-managers / ezone-staffing standard; PR 1 (single login) collapsed
// it to ONE password for the whole app:
//   - fail-closed startup: the server REFUSES TO START if any required secret is missing/empty
//   - POST /api/login { pin } → HMAC-signed session token for the ONE app identity (רועי / ops_manager);
//     no per-person picker, no Users-sheet read on the login path
//   - approve / reject additionally require the APPROVER_CODE (אולגה) — verified here AND in Code.gs
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
// ONE shared access code for the whole login roster (replaces the per-user pin_hash + the tier-B APP_PIN).
// Trimmed so a trailing newline/space in the Railway variable can't make every login fail (a live-only
// failure mode). Fail-closed: the server refuses to start if it is unset (see the startup block).
const SHARED_ACCESS_CODE = (process.env.SHARED_ACCESS_CODE || '').trim();
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 0;

// Single login (PR 1): ONE password (SHARED_ACCESS_CODE) for the whole app — no per-person picker and no
// Users-sheet read on the login path. Every session is issued for this ONE identity: name רועי (stamped as
// created_by / AuditLog `by` on non-approval actions) with role ops_manager (so every manager-tier page and
// write is reachable with the one password). The role alone NEVER approves: approve/reject are additionally
// gated by APPROVER_CODE below, and a verified approval is recorded as אולגה (Code.gs).
const SESSION_IDENTITY = Object.freeze({ name: 'רועי', role: 'ops_manager', scope: '' });
// The approver code (אולגה). Required on every approve/reject that needs a human approver (emergency = auto
// approval is unchanged and needs no code). Verified here with a constant-time compare AND independently in
// Code.gs against the APPROVER_CODE Script Property — the Node layer is never trusted. Trimmed like the
// login code; fail-closed at startup (server refuses to start without it) and at runtime (checkPin fails
// closed on an empty expected value). Never logged.
const APPROVER_CODE = (process.env.APPROVER_CODE || '').trim();
const APPROVER_ACTIONS = new Set(['approve', 'reject']);

// ---- version truth (deploy provenance) ----
// COMMIT: the git SHA this Node build was deployed from. Railway injects RAILWAY_GIT_COMMIT_SHA into the
// container at build/run time; 'unknown' locally. Surfaced at GET /version and stamped into the service-
// worker cache name so every deploy self-invalidates. BOOT_AT: when THIS instance started (≈ deploy time).
const COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown').trim() || 'unknown';
const BOOT_AT = new Date().toISOString();

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
// verifies the ONE shared password (single login, PR 1): the overlay is a single password field — no name
// picker — and the server issues the one app identity. Built once at module load (no per-request roster
// read: serving a page no longer waits on Apps Script).
function buildClientShim() {
  return `<script>(function(){
  var TOKEN=null,authPromise=null,origFetch=window.fetch.bind(window);
  window.__EXEC_URL__='/api/exec'; window.__STAFF_TOKEN__='';
  try{sessionStorage.setItem('ezone_staff_token','1');}catch(e){}
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
  function navLinks(){var r=String(window.__ROLE__||'');return NAV_BY_ROLE[r]||[];}
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
  // Version footer — small gray text on EVERY page (incl. the login screen), so anyone can see at a glance
  // which commit is live on each leg: Node (Railway) and Apps Script (Sheets backend). Non-secret; fetched
  // from /version. pointer-events:none so it never blocks the UI. Pinned to the bottom-LEFT corner: the
  // sign-out control lives at the RTL inline-start (right edge on this Hebrew app), and the footer's own
  // direction:ltr made inset-inline-end resolve to that same right edge, so it used to sit UNDER the
  // sign-out button. Anchoring the footer with left:12px moves it to the opposite corner so both are always
  // visible on every page; the app's RTL layout is untouched (only this fixed overlay changes side).
  function mountVersion(){
    function m(){
      if(!document.body||document.getElementById('ezone-ver'))return;
      var v=el('div','position:fixed;bottom:12px;left:12px;z-index:99997;font-family:system-ui,Arial,sans-serif;font-size:11px;line-height:1.3;color:#7a8794;direction:ltr;opacity:.75;pointer-events:none;text-align:start','…');
      v.id='ezone-ver';document.body.appendChild(v);
      origFetch('/version').then(function(r){return r.json();}).then(function(j){
        var n=String((j&&j.node&&j.node.commit)||'?').slice(0,7),g=String((j&&j.appsScript&&j.appsScript.commit)||'?').slice(0,7);
        v.textContent='node '+n+' · gs '+g;
      }).catch(function(){v.textContent='node ? · gs ?';});
    }
    if(document.body)m();else document.addEventListener('DOMContentLoaded',m);
  }
  mountVersion();
  if(_boot){mountSignOut();mountNav();}
  function doLogin(){return new Promise(function(resolve){
    function mount(){
      var ov=el('div','position:fixed;inset:0;z-index:99999;background:#071410;display:flex;align-items:center;justify-content:center;direction:rtl;font-family:system-ui,Arial,sans-serif');
      var card=el('div','background:#0e211b;border:1px solid #143a30;border-radius:14px;padding:24px;width:min(92vw,340px);box-shadow:0 10px 40px rgba(0,0,0,.5)');
      var h=el('div','color:#eef1f5;font-size:1.15rem;font-weight:800;margin-bottom:14px','כניסה — לוגיסטיקה');
      var pin=el('input','width:100%;min-height:44px;font-size:16px;margin-bottom:10px;border-radius:8px;padding:6px');
      pin.type='password';pin.setAttribute('autocomplete','off');pin.placeholder='קוד גישה';
      var btn=el('button','width:100%;min-height:44px;font-size:16px;font-weight:700;border:0;border-radius:8px;background:#00bfa5;color:#04150f;cursor:pointer','כניסה');
      var err=el('div','color:#ff8a80;font-size:.9rem;margin-top:10px;min-height:1.1em','');
      // Spinner keyframes — a <style> inside the overlay applies globally (inline styles can't do @keyframes).
      card.appendChild(el('style',null,'@keyframes ezspin{to{transform:rotate(360deg)}}'));
      card.appendChild(h);card.appendChild(pin);card.appendChild(btn);card.appendChild(err);ov.appendChild(card);
      document.body.appendChild(ov);pin.focus();
      // In-progress state for the login button: disable + show a spinner INSIDE the button. setLoading(false)
      // restores the label and re-enables; on success we DON'T restore — the button keeps spinning through
      // the redirect so there's no dead moment.
      var _btnLabel=btn.textContent;
      function setLoading(on){
        if(on){
          btn.disabled=true;btn.style.cursor='default';btn.style.opacity='.9';btn.textContent='';
          var sp=el('span','display:inline-block;width:16px;height:16px;box-sizing:border-box;border:2px solid rgba(4,21,15,.35);border-top-color:#04150f;border-radius:50%;animation:ezspin .6s linear infinite;vertical-align:middle');
          sp.setAttribute('aria-hidden','true');btn.setAttribute('aria-busy','true');btn.appendChild(sp);
        }else{
          btn.disabled=false;btn.style.cursor='pointer';btn.style.opacity='1';btn.removeAttribute('aria-busy');btn.textContent=_btnLabel;
        }
      }
      function attempt(){
        if(btn.disabled)return; // already in-flight — guards an Enter-key double-submit while the button spins
        err.textContent='';setLoading(true);
        origFetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:pin.value})})
        .then(function(r){return r.json().then(function(j){return{s:r.status,j:j};});})
        .then(function(res){
          if(res.s===200&&res.j&&res.j.token){
            // SUCCESS — keep the button disabled + spinning through the redirect; no dead moment.
            saveSession(res.j.token,res.j.role,res.j.scope,res.j.expiresInDays);applySession({token:res.j.token,role:res.j.role,scope:res.j.scope});
            if(ov.parentNode)ov.parentNode.removeChild(ov);mountSignOut();mountNav();resolve();return;
          }
          setLoading(false); // FAILURE — restore the button, then surface the error
          if(res.s===429){err.textContent='יותר מדי ניסיונות. נסו שוב מאוחר יותר.';}
          else{err.textContent='קוד גישה שגוי';pin.value='';pin.focus();}
        }).catch(function(){setLoading(false);err.textContent='שגיאת רשת';});
      }
      btn.addEventListener('click',attempt);
      pin.addEventListener('keydown',function(e){if(e.key==='Enter')attempt();});
    }
    if(document.body)mount();else document.addEventListener('DOMContentLoaded',mount);
  });}
  function ensureAuth(){if(TOKEN)return Promise.resolve();if(!authPromise)authPromise=doLogin();return authPromise;}
  // /help is the one HTML route the server gates on the session token (401 + loader shell without it).
  // The shell's loader fetches '/help' through this wrapper, so the Bearer token is attached (after the
  // login overlay when no session is stored) and the full guide replaces the shell. Same 401-retry as
  // the data routes: an expired token clears the session and re-prompts once.
  function helpRoute(init){
    return ensureAuth().then(function(){
      var headers=Object.assign({},(init&&init.headers)||{});headers['Authorization']='Bearer '+TOKEN;
      return origFetch('/help',Object.assign({},init,{headers:headers})).then(function(r){
        if(r.status===401){TOKEN=null;authPromise=null;clearSession();return ensureAuth().then(function(){headers['Authorization']='Bearer '+TOKEN;return origFetch('/help',Object.assign({},init,{headers:headers}));});}
        return r;
      });
    });
  }
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
    if(url==='/help'||url==='/help.html'||url.indexOf('/help?')===0)return helpRoute(init||{});
    return origFetch(input,init);
  };
})();</script>`;
}

// The ONE shim, built once. Exported for the shim-behavior tests that run it in a sandbox.
const CLIENT_SHIM = buildClientShim();

// The anonymous /help response body (served with HTTP status 401): a minimal shell that carries the
// injected auth shim and re-fetches /help — the shim attaches the Bearer token (showing the login
// overlay first when no session is stored) and the served guide replaces this shell via document.write.
// It holds NO guide content, so an anonymous caller never sees the help text; API/test callers just see
// the 401 status. This keeps plain <a href="/help"> navigation and browser refresh working while the
// route itself stays token-gated server-side.
const HELP_SHELL = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>EZone לוגיסטיקה — מדריך</title>
<style>body{margin:0;background:#15171c;color:#8b93a0;font-family:'Heebo',"Segoe UI",system-ui,-apple-system,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;font-size:1rem}</style>
</head>
<body>
<p>טוען…</p>
<script>
window.fetch('/help').then(function(r){if(!r.ok)throw new Error('unauthorized');return r.text();}).then(function(t){document.open();document.write(t);document.close();}).catch(function(){document.body.textContent='נדרשת התחברות כדי לצפות בדף זה.';});
</script>
</body>
</html>`;

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

// The live Apps Script deploy commit (action=version → { commit }), cached ~60s so /version and the page
// footer don't hit /exec on every request. 'unreachable' when the /exec can't be reached (never throws).
let _asVersion = { at: 0, commit: null };
async function appsScriptCommit() {
  const now = Date.now();
  if (_asVersion.commit != null && (now - _asVersion.at) < 60000) return _asVersion.commit;
  const data = await fetchAppsScriptData('version'); // null on unreachable / unknown-action (older deploy)
  const commit = (data && data.commit) ? String(data.commit) : (data == null ? 'unreachable' : 'unknown');
  _asVersion = { at: now, commit };
  return commit;
}
function _resetVersionCache() { _asVersion = { at: 0, commit: null }; } // test hook

// ---- Node micro-cache for STABLE reference reads (perf round-2) ----
// houses/config/technicians change rarely and are fetched on nearly every page load. Cache them in
// process memory (~120 s TTL) so tab switches skip the Node→Apps Script hop (one 302 + Apps Script
// cold-start each). NEVER cache users (auth roster, must stay live per the #60 fix) or requests (change
// constantly — write→read freshness). A hand edit to Houses/Config propagates within the TTL. (Node's
// built-in fetch/undici already keeps Node→Apps Script connections alive by default, so no Agent change.)
const NODE_CACHEABLE = new Set(['houses', 'config', 'technicians']);
const NODE_CACHE_TTL_MS = 120000;
// Dynamic reads (perf round-3): the dashboard/workorders HOT sheets that change on writes. Measured, the
// old design fetched these on EVERY tab switch — one blocking Apps Script round-trip (302 + cold start,
// ~1–3s live) per page. They get a SHORT TTL so a burst of tab switches reuses one read, and — unlike the
// stable sheets — the cache is INVALIDATED on every write (handleAction), so the reload a write triggers is
// always fresh. Cross-instance/other-user staleness is bounded to the short TTL. NEVER cache `users` (auth
// roster / holds pin_hash) — it is not in either set. The per-role scope filter still runs on a cache HIT
// (see handleData/handlePageData), so a cached raw `requests` list is never returned unscoped to tier B.
const DYNAMIC_CACHEABLE = new Set(['requests', 'findings', 'inspections']);
const DYNAMIC_CACHE_TTL_MS = 8000;
const nodeCache = new Map(); // action -> { value, exp }

function cacheTtl(action) {
  if (NODE_CACHEABLE.has(action)) return NODE_CACHE_TTL_MS;
  if (DYNAMIC_CACHEABLE.has(action)) return DYNAMIC_CACHE_TTL_MS;
  return 0; // not cacheable (users/etc.)
}
function isCacheable(action) { return cacheTtl(action) > 0; }

function nodeCacheGet(action) {
  const e = nodeCache.get(action);
  if (e && e.exp > Date.now()) return e.value;
  if (e) nodeCache.delete(action);
  return null;
}
function nodeCachePut(action, value) {
  const ttl = cacheTtl(action);
  if (!ttl) return; // hard guard: never users/etc.
  nodeCache.set(action, { value, exp: Date.now() + ttl });
}
// Drop the short-TTL dynamic reads so the next read reflects a just-committed write immediately. The
// stable reference sheets (houses/config/technicians) are untouched — a write never changes them.
function invalidateDynamicCache() {
  for (const a of DYNAMIC_CACHEABLE) nodeCache.delete(a);
}
function _resetNodeCache() { nodeCache.clear(); }

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
    const cached = isCacheable(a) ? nodeCacheGet(a) : null;
    if (cached !== null) data[a] = cached; else toFetch.push(a);
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

// Single login (PR 1): ONE password for the whole app. No name, no roster read — the login path never
// touches Apps Script, so it cannot be broken by an upstream outage, a roster edit, or a deploy window.
// The secret check is a constant-time compare against SHARED_ACCESS_CODE; any failure returns the SAME
// generic 401; the code is never logged. A success issues the ONE app identity (SESSION_IDENTITY).
async function handleLogin(req, res) {
  const ip = clientIp(req);
  const generic401 = () => sendJson(res, 401, { ok: false, error: 'קוד גישה שגוי' });
  if (!rateLimitLogin(ip)) {
    return sendJson(res, 429, { ok: false, error: 'יותר מדי ניסיונות. נסו שוב מאוחר יותר.' });
  }
  const body = await readJsonBody(req, 4096);
  const code = (body && body.pin != null) ? String(body.pin) : '';
  if (!checkPin(code, SHARED_ACCESS_CODE)) {
    console.warn(`[login] failed attempt from ${ip}`);
    return generic401();
  }
  const { name, role, scope } = SESSION_IDENTITY;
  const token = signToken(SESSION_SECRET, SESSION_DAYS, { name, role, scope });
  // role + scope are non-secret facts the UI adapts to; they are never the security control.
  return sendJson(res, 200, { ok: true, token, name, role, scope, expiresInDays: SESSION_DAYS });
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

  // Node micro-cache: stable reference sheets (120s) + hot dynamic sheets (short TTL, write-invalidated) are
  // served from process memory so tab switches skip the Apps Script hop. A cache HIT falls THROUGH to the
  // per-action post-processing below (scope filter / secret hygiene) — so a cached raw `requests` list is
  // never returned unscoped to tier B. `users` is in neither set and always reads live.
  let payload = null;
  if (isCacheable(action)) {
    const hit = nodeCacheGet(action);
    if (hit !== null) payload = { ok: true, data: hit };
  }

  if (!payload) {
    const qs = new URLSearchParams();
    for (const [k, v] of url.searchParams.entries()) {
      if (ALLOWED_QUERY_KEYS.has(k)) qs.set(k, v);
    }
    const target = `${EXEC_URL}${qs.toString() ? `?${qs.toString()}` : ''}`;
    try {
      const upstream = await fetch(target, { method: 'GET', redirect: 'follow', headers: { Accept: 'application/json' } });
      payload = await upstream.json();
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: 'upstream_error' });
    }
    // Populate the cache (stable or dynamic) on a successful upstream response.
    if (isCacheable(action) && payload && payload.ok && 'data' in payload) {
      nodeCachePut(action, payload.data);
    }
  }

  // Post-process per action for scope/secret hygiene.
  if (payload && payload.ok && Array.isArray(payload.data)) {
    if (action === 'users') {
      // The roster is manager-only, and pin_hash is NEVER exposed to the browser.
      if (!manager) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      payload.data = payload.data.map((u) => { const c = Object.assign({}, u); delete c.pin_hash; return c; });
    } else if (action === 'requests' && !manager) {
      // Managers (field_ops / ops_manager) never reach here — they get the unfiltered list above.
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

// Exec-only writes (ops_manager), beyond managementData/updateEvent: the /management readiness
// checklists (opening / emergency) and the compliance-entry delete. Mirrored by canManage in Code.gs.
// Exec-only writes (ops_manager): the training-log delete + the (legacy) compliance delete. The
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
  // Role-based write gate (src/access.js, mirrored in Code.gs). maintenance is limited to createRequest
  // (+ its daily preventive tick); a coordinator session has no write at all (coordinators file via the
  // external ezone-coordinators app, not a Logistics session). Every other write is refused here with no
  // upstream call. Manager roles pass and are subject to the precise per-action checks below + in Code.gs.
  if (!canWriteAction(actor.role, body.action)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  // /management is exec-only (ops_manager). Enforced here (server-side) AND independently in
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
  // /management readiness checklists + compliance delete are exec-only (ops_manager), same as
  // managementData. Enforced here (server-side) AND independently in Code.gs. field_ops passes the tier
  // gate above but is NOT an exec, so it gets 403 here with no upstream call.
  if (MANAGE_ONLY_ACTIONS.has(body.action) && !canManage(actor.role)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  const payload = (body.payload && typeof body.payload === 'object') ? Object.assign({}, body.payload) : {};
  // The actor is the verified token identity, never a client-supplied field: a legacy `by` in the payload is
  // dropped here so no user parameter is ever forwarded (single login — there is no per-user selection).
  delete payload.by;
  // Approver-code gate (PR 1): approve/reject need the APPROVER_CODE unless the request is an emergency
  // (auto approval, unchanged). A supplied code is verified constant-time and a wrong one is refused with NO
  // upstream call; a missing code is refused unless the target request is חירום. Code.gs re-verifies the
  // forwarded code independently, so a bypass of this proxy still cannot approve.
  if (APPROVER_ACTIONS.has(body.action)) {
    const gate = await approverGate(payload);
    if (gate) return sendJson(res, gate.status, { ok: false, error: gate.error });
  }
  const upstreamBody = JSON.stringify({ action: body.action, payload, token: auth.token });
  try {
    const upstream = await fetch(EXEC_URL, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: upstreamBody,
    });
    const text = await upstream.text();
    // A write may have changed requests/findings/inspections — drop the short-TTL dynamic cache so the
    // reload the client fires next reflects the write immediately (post-write freshness on this instance).
    if (upstream.status < 300) invalidateDynamicCache();
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch (err) {
    return sendJson(res, 502, { ok: false, error: 'upstream_error' });
  }
}

// Emergency (חירום) requests are auto-approved by chain B and need no approver code. Node has no request
// identity of its own, so a code-less approve/reject looks the target up (short-TTL cache, else one live
// read) and lets ONLY an emergency through without a code. A request Node cannot see is forwarded and
// Code.gs — which enforces the same rule against its own sheet — decides. Never throws.
async function isEmergencyRequest(id) {
  if (!id) return null;
  const list = nodeCacheGet('requests') || (await fetchAppsScriptData('requests'));
  if (!Array.isArray(list)) return null;
  const r = list.find((x) => x && String(x.id) === String(id));
  if (!r) return null;
  return String(r.urgency) === 'חירום';
}

// Returns null when the write may proceed, else { status, error }. The code is removed from the payload
// when absent (never forwarded as an empty string) and forwarded verbatim when it verified.
async function approverGate(payload) {
  const supplied = payload.approver_code != null ? String(payload.approver_code) : '';
  delete payload.approver_code;
  if (supplied) {
    if (!checkPin(supplied, APPROVER_CODE)) return { status: 403, error: 'approver_code_invalid' };
    payload.approver_code = supplied;
    return null;
  }
  const emergency = await isEmergencyRequest(payload.id);
  if (emergency === true || emergency === null) return null; // auto approval, or unknown → Code.gs decides
  return { status: 403, error: 'approver_code_required' };
}

export async function requestHandler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;

  // ---- API gateway (auth + data proxy) ----
  if (path === '/api/login' && req.method === 'POST') return handleLogin(req, res);
  if (path === '/api/data' && req.method === 'GET') return handleData(req, res, url);
  if (path === '/api/action' && req.method === 'POST') return handleAction(req, res);
  if (path === '/api/health') return sendJson(res, 200, { ok: true, ts: Date.now() });
  // Version truth: the git SHA live on each leg. Non-secret; no auth. node = THIS Railway build
  // (RAILWAY_GIT_COMMIT_SHA); appsScript = the live /exec's action=version (cached ~60s). The footer + the
  // post-deploy CI checks read this to prove the live legs match the merge SHA.
  if (path === '/version') {
    return sendJson(res, 200, { node: { commit: COMMIT, builtAt: BOOT_AT }, appsScript: { commit: await appsScriptCommit() } });
  }
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
    if (path === '/sw.js') {
      // The SW script must NEVER be HTTP-cached — the browser has to re-fetch it on every check so a new
      // deploy is detected promptly and wedged clients heal. (A cacheable /sw.js is the classic trap where
      // the browser keeps the old worker for up to its max-age.) Stronger than plain no-cache.
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      // Stamp the running commit into the SW cache name so EVERY deploy changes it → new byte-content the
      // browser detects → the SW's activate() purges all prior caches. No stale document after a deploy.
      body = Buffer.from(String(body).replace(/var CACHE = '[^']*';/, `var CACHE = 'ezone-logistics-${COMMIT}';`));
    }
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

  // /help (מדריך) — the static in-app guide. Unlike the public HTML routes below, this page is served
  // ONLY to a valid session token: Bearer → 200 + the full guide; anonymous/invalid → 401 + the loader
  // shell (no guide content), whose shim-routed re-fetch attaches the token so real navigation still
  // works. Any authenticated role gets it; the nav shows it to the login roster (see src/access.js).
  if (path === '/help' || path === '/help.html') {
    if (!authFromRequest(req)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(HELP_SHELL.replace('</head>', HEAD_INJECT + CLIENT_SHIM + '</head>'));
    }
    let html = readFileSync(join(__dirname, 'help.html'), 'utf8');
    html = html.replace('</head>', HEAD_INJECT + CLIENT_SHIM + '</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  // HTML routes — inject the PWA head links. (No secret is injected: data goes through the
  // Bearer-gated /api proxy, so the /exec URL never reaches the page source.)
  const file = HTML_ROUTES[path];
  if (file) {
    let html = readFileSync(join(__dirname, file), 'utf8');
    // The shim is a module-load constant: serving a page never waits on an Apps Script roster read.
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
  if (!SHARED_ACCESS_CODE) fatal('SHARED_ACCESS_CODE is required (the shared login code; set it in Railway before deploy)');
  if (!APPROVER_CODE) fatal('APPROVER_CODE is required (the approver code for approve/reject; set it in Railway AND as the APPROVER_CODE Apps Script Script Property before deploy)');

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
export { _resetNodeCache, _resetVersionCache, PAGE_ACTIONS as _PAGE_ACTIONS };
// Exported for the single-login tests: the shim builder and the ONE identity every session is issued for.
export { buildClientShim, SESSION_IDENTITY as _SESSION_IDENTITY, APPROVER_ACTIONS as _APPROVER_ACTIONS };
