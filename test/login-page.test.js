// test/login-page.test.js — the LOGIN PAGE submit path, end-to-end, for every role. Renders the ACTUAL
// served '/' (the injected auth shim + index.html's own inline scripts) in one DOM sandbox with
// real-browser timing (shim runs while document.body is null, as it does in <head>), triggers the login
// overlay via the page's first /api/exec fetch, then clicks כניסה and asserts login completes.
//
// '/' is now a BARE managers-only landing (the standalone coordinator request form was removed): its only
// job is to bring an unauthenticated visitor to the login overlay and then forward a signed-in user to
// /dashboard. This proves, for coordinator/maintenance/field_ops/ops_manager, that the overlay
// appears, the click posts /api/login, the session is saved, the overlay closes, and the page then
// forwards to /dashboard. (The overlay itself is role-agnostic — one password field, no picker; the
// single-login contract is enforced at the server and covered by login-single.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { _CLIENT_SHIM } from '../src/server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(root, 'src/index.html'), 'utf8');
// index.html's own inline <script> blocks (run after the shim, at end of <body>).
const PAGE_SCRIPTS = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

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

function loadLoginPage(role, pathname) {
  const calls = [], store = {};
  // The bare landing has no form elements; getElementById is only used by the shim (e.g. ezone-ver),
  // which creates its own nodes. An empty id map (getElementById → null) is all the page needs.
  const ids = {};
  const nav = makeEl('nav');
  let body = null; // real browser: null while <head> scripts run
  const domL = {};
  const document = {
    get body() { return body; }, createElement: makeEl, getElementById: (id) => ids[id] || null,
    querySelector: (sel) => (sel === '.nav' ? nav : null), querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); },
  };
  let replacedTo = null;
  const location = { pathname: pathname || '/', href: pathname || '/', reload() {}, replace(u) { replacedTo = u; } };
  const realFetch = (input) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    calls.push(u);
    if (u.indexOf('/api/login') === 0) return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, token: 'TOK', role, scope: role === 'coordinator' ? 'רמות השבים' : '', expiresInDays: 7 }) });
    if (u.indexOf('/api/data') === 0) return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, data: [] }) });
    return Promise.resolve({ status: 404, json: () => Promise.resolve({ ok: false }) });
  };
  const windowObj = { fetch: realFetch, addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); } };
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

async function flush(n) { for (let i = 0; i < (n || 8); i++) await Promise.resolve(); }

for (const role of ['coordinator', 'maintenance', 'field_ops', 'ops_manager']) {
  test(`login page submit works end-to-end for ${role}`, async () => {
    const ctx = loadLoginPage(role, '/');
    await flush();
    const btn = ctx.body._find((c) => c.tagName === 'button' && c.textContent === 'כניסה');
    assert.ok(btn, `${role}: the כניסה login overlay must appear`);
    btn.click();
    await flush(16);
    assert.ok(ctx.calls.some((u) => u.indexOf('/api/login') === 0), `${role}: clicking כניסה must POST /api/login`);
    assert.ok('ezone_session' in ctx.store, `${role}: a session must be saved on success`);
    assert.ok(!ctx.body._find((c) => c.tagName === 'button' && c.textContent === 'כניסה'), `${role}: the overlay must close`);
    // Once authenticated, the bare landing forwards to the dashboard (its only job).
    assert.equal(ctx.replacedTo, '/dashboard', `${role}: after login, '/' forwards to /dashboard`);
  });
}

test('the nav redirect never fires on a logged-out view (login page is never bounced)', async () => {
  // On a page a role could not open, a LOGGED-OUT visitor (no session) must still get the login overlay,
  // not a redirect — the redirect only applies to an authenticated known role.
  const ctx = loadLoginPage('coordinator', '/dashboard');
  await flush();
  // No session yet → shim must not have redirected; the login overlay must be present.
  assert.equal(ctx.replacedTo, null, 'a logged-out visitor is never redirected (overlay owns the screen)');
  const btn = ctx.body._find((c) => c.tagName === 'button' && c.textContent === 'כניסה');
  assert.ok(btn, 'the login overlay appears even on a restricted page when logged out');
});
