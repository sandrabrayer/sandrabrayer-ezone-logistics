// test/login-page.test.js — the dedicated managers-login page (/login, the "כניסת מנהלים" path) end-to-end,
// for every role. The server injects __FORCE_LOGIN__ (auto-open the overlay) + __LOGIN_NAMES__ (the LIVE,
// normalized active roster as the dropdown) into the auth shim on this route; on success the shim sends the
// user to their authenticated home (dashboard for managers, /status for a coordinator). This renders the
// ACTUAL injected shim in a DOM sandbox with real-browser timing (shim runs while document.body is null,
// as it does in <head>) and proves: the overlay auto-appears, the dropdown is the injected roster, כניסה
// posts /api/login, the session is saved, the overlay closes, and the user is redirected to their home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { _CLIENT_SHIM } from '../src/server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(root, 'src/login.html'), 'utf8');
// login.html's own inline <script> blocks (run after the shim, at end of <body>).
const PAGE_SCRIPTS = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// The live active roster the server injects into /login (window.__LOGIN_NAMES__). All 9 seeded users.
const ROSTER = ['רועי', 'אולגה', 'סנדרה', 'רמי', 'צחי', 'שירה', 'יעקב', 'אורן', 'אביב'];

const HOME_BY_ROLE = { coordinator: '/status', maintenance: '/dashboard', field_ops: '/dashboard', ops_manager: '/dashboard', ceo: '/dashboard' };

function makeEl(tag) {
  const attrs = {}, listeners = {};
  const node = {
    tagName: tag, _id: '', className: '', textContent: '', value: '', type: '', disabled: false,
    selectedIndex: 0, style: {}, children: [], parentNode: null,
    get id() { return this._id; }, set id(v) { this._id = v; },
    set innerHTML(v) { this._h = v; if (v === '') this.children = []; }, get innerHTML() { return this._h || ''; },
    setAttribute(k, v) { if (k === 'id') this._id = v; attrs[k] = v; },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    appendChild(c) { c.parentNode = node; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); c.parentNode = null; return c; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    click() { (listeners.click || []).forEach((fn) => fn({})); },
    focus() {}, querySelectorAll() { return []; },
    querySelector(sel) { const m = sel && sel.match(/^a\[href="([^"]+)"\]$/); if (m) return this.children.find((c) => c.tagName === 'a' && c.getAttribute && c.getAttribute('href') === m[1]) || null; return null; },
    _find(pred) { for (const c of this.children) { if (pred(c)) return c; const r = c._find && c._find(pred); if (r) return r; } return null; },
  };
  return node;
}

// Render /login for `role`: shim (with __FORCE_LOGIN__ + __LOGIN_NAMES__ injected) + login.html's scripts.
// `seedSession` seeds a persisted session (to prove an already-logged-in visitor skips straight to home).
function loadLoginPage(role, seedSession) {
  const calls = [], store = {};
  if (seedSession) store.ezone_session = JSON.stringify(seedSession);
  const nav = makeEl('nav');
  let body = null; // real browser: null while <head> scripts run
  const domL = {};
  const document = {
    get body() { return body; }, createElement: makeEl, getElementById: () => null,
    querySelector: (sel) => (sel === '.nav' ? nav : null), querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); },
  };
  let replacedTo = null;
  const location = { pathname: '/login', href: '/login', reload() {}, replace(u) { replacedTo = u; } };
  const realFetch = (input) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    calls.push(u);
    if (u.indexOf('/api/login') === 0) return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, token: 'TOK', role, scope: role === 'coordinator' ? 'רמות השבים' : '', expiresInDays: 7 }) });
    if (u.indexOf('/api/data') === 0) return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, data: [] }) });
    return Promise.resolve({ status: 404, json: () => Promise.resolve({ ok: false }) });
  };
  const windowObj = { fetch: realFetch, __FORCE_LOGIN__: true, __LOGIN_NAMES__: ROSTER.slice(), addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); } };
  const sandbox = {
    window: windowObj, document, navigator: {}, get fetch() { return windowObj.fetch; },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location, Promise, JSON, Date, console, setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(_CLIENT_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, ''), sandbox); // <head>: body null
  body = makeEl('body');                                                                       // <body> parsed
  for (const s of PAGE_SCRIPTS) vm.runInContext(s, sandbox);                                    // page inline scripts
  (domL.DOMContentLoaded || []).forEach((fn) => fn({}));
  return { sandbox, get body() { return body; }, nav, calls, store, get replacedTo() { return replacedTo; } };
}

async function flush(n) { for (let i = 0; i < (n || 12); i++) await Promise.resolve(); }

for (const role of ['coordinator', 'maintenance', 'field_ops', 'ops_manager', 'ceo']) {
  test(`/login submit works end-to-end for ${role} and redirects to their home`, async () => {
    const ctx = loadLoginPage(role);
    await flush();
    const btn = ctx.body._find((c) => c.tagName === 'button' && c.textContent === 'כניסה');
    assert.ok(btn, `${role}: the כניסה login overlay must auto-appear on /login`);
    // The dropdown is the injected LIVE roster (data-driven), not a partial/hardcoded list.
    const sel = ctx.body._find((c) => c.tagName === 'select');
    assert.ok(sel, `${role}: the roster dropdown must render`);
    assert.deepEqual(sel.children.map((o) => o.value), ROSTER, `${role}: dropdown must list the full active roster`);
    btn.click();
    await flush();
    assert.ok(ctx.calls.some((u) => u.indexOf('/api/login') === 0), `${role}: clicking כניסה must POST /api/login`);
    assert.ok('ezone_session' in ctx.store, `${role}: a session must be saved on success`);
    assert.ok(!ctx.body._find((c) => c.tagName === 'button' && c.textContent === 'כניסה'), `${role}: the overlay must close`);
    assert.equal(ctx.replacedTo, HOME_BY_ROLE[role], `${role}: must be sent to their authenticated home`);
  });
}

test('/login with an EXISTING valid session skips the overlay and goes straight home', async () => {
  const seed = { token: 'T', role: 'ceo', scope: '', exp: Date.now() + 30 * 864e5 };
  const ctx = loadLoginPage('ceo', seed);
  await flush();
  assert.ok(!ctx.body._find((c) => c.tagName === 'button' && c.textContent === 'כניסה'), 'no overlay when already logged in');
  assert.equal(ctx.replacedTo, '/dashboard', 'an already-authenticated visitor is sent straight to their home');
});

test('a logged-out visitor on /login is never redirected — the overlay owns the screen', async () => {
  const ctx = loadLoginPage('field_ops');
  await flush();
  const btn = ctx.body._find((c) => c.tagName === 'button' && c.textContent === 'כניסה');
  assert.ok(btn, 'the login overlay appears for a logged-out visitor');
  assert.equal(ctx.replacedTo, null, 'no redirect before a successful login');
});
