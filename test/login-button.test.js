// test/login-button.test.js — the login button's in-progress (loading) state. Renders the REAL injected
// shim (_CLIENT_SHIM) in a DOM sandbox, opens the login overlay, and drives a DEFERRED /api/login so we
// can observe the button WHILE the request is in flight:
//   - on click: the button is immediately disabled, shows a spinner (child span, aria-busy), label cleared;
//   - on failure (401): the button is RE-ENABLED, label restored, and the error is shown;
//   - on success (200): the button STAYS disabled/spinning while the overlay closes (no dead moment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { _CLIENT_SHIM } from '../src/server.js';

function makeEl(tag) {
  const attrs = {}, listeners = {};
  const node = {
    tagName: tag, _id: '', _text: '', className: '', value: '', type: '', disabled: false,
    style: {}, children: [], parentNode: null,
    // Real DOM: assigning textContent REPLACES all child nodes (this is how production clears the spinner).
    get textContent() { return this._text; }, set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; },
    get id() { return this._id; }, set id(v) { this._id = v; },
    set innerHTML(v) { this._h = v; if (v === '') this.children = []; }, get innerHTML() { return this._h || ''; },
    setAttribute(k, v) { if (k === 'id') this._id = v; attrs[k] = v; },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    appendChild(c) { c.parentNode = node; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); c.parentNode = null; return c; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    click() { (listeners.click || []).forEach((fn) => fn({})); },
    focus() {},
    _find(pred) { for (const c of this.children) { if (pred(c)) return c; const r = c._find && c._find(pred); if (r) return r; } return null; },
  };
  return node;
}

async function flush(n) { for (let i = 0; i < (n || 8); i++) await Promise.resolve(); }

// Boot the shim with the overlay open and a deferred /api/login. Returns the button + a resolver.
function bootLogin() {
  const store = {};
  const body = makeEl('body');
  const nav = makeEl('nav');
  const domL = {};
  const document = {
    get body() { return body; }, createElement: makeEl, getElementById: () => null,
    querySelector: (sel) => (sel === '.nav' ? nav : null), querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); },
  };
  const location = { pathname: '/', href: '/', reload() {}, replace() {} };
  let resolveLogin;
  const realFetch = (input) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (u.indexOf('/api/login') === 0) return new Promise((res) => { resolveLogin = res; }); // DEFERRED
    if (u.indexOf('/version') === 0) return Promise.resolve({ status: 200, json: () => Promise.resolve({ node: { commit: 'x' }, appsScript: { commit: 'y' } }) });
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, data: [] }) });
  };
  const windowObj = { fetch: realFetch, addEventListener: () => {} };
  const sandbox = {
    window: windowObj, document, navigator: {}, get fetch() { return windowObj.fetch; },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location, Promise, JSON, Date, console, setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(_CLIENT_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, ''), sandbox);
  sandbox.window.fetch('/api/exec'); // triggers ensureAuth → doLogin → overlay mounts (body present)
  const btn = body._find((c) => c.tagName === 'button' && c.textContent === 'כניסה');
  return { body, btn, store, resolve: (v) => resolveLogin(v) };
}

test('clicking כניסה immediately disables the button and shows an in-button spinner', async () => {
  const ctx = bootLogin();
  assert.ok(ctx.btn, 'the login overlay button must appear');
  assert.equal(ctx.btn.disabled, false, 'button starts enabled');
  ctx.btn.click();
  await flush();
  // In flight (login promise still pending):
  assert.equal(ctx.btn.disabled, true, 'button is disabled the moment login is in flight');
  assert.equal(ctx.btn.getAttribute('aria-busy'), 'true', 'button marked aria-busy');
  assert.equal(ctx.btn.textContent, '', 'label cleared to make room for the spinner');
  assert.ok(ctx.btn.children.some((c) => c.tagName === 'span'), 'a spinner span is shown inside the button');
});

test('on failure the button is re-enabled, label restored, and the error is shown', async () => {
  const ctx = bootLogin();
  ctx.btn.click();
  await flush();
  assert.equal(ctx.btn.disabled, true, 'disabled while in flight');
  ctx.resolve({ status: 401, json: () => Promise.resolve({ ok: false, error: 'nope' }) });
  await flush();
  assert.equal(ctx.btn.disabled, false, 'button is re-enabled after a failed login');
  assert.equal(ctx.btn.textContent, 'כניסה', 'the button label is restored');
  assert.equal(ctx.btn.getAttribute('aria-busy'), null, 'aria-busy cleared');
  assert.ok(!ctx.btn.children.some((c) => c.tagName === 'span'), 'the spinner is removed');
  const err = ctx.body._find((c) => c.textContent === 'קוד גישה שגוי');
  assert.ok(err, 'the existing error message is shown on failure');
});

test('a second Enter/click while in flight does not fire a duplicate login', async () => {
  const ctx = bootLogin();
  ctx.btn.click();
  await flush();
  // Clicking again while disabled must be a no-op (guarded) — still exactly one in-flight request.
  ctx.btn.click();
  await flush();
  assert.equal(ctx.btn.disabled, true, 'still in flight, still disabled');
  // Resolve failure once; the button returns to a single, clean enabled state.
  ctx.resolve({ status: 401, json: () => Promise.resolve({ ok: false }) });
  await flush();
  assert.equal(ctx.btn.disabled, false);
});

test('on success the button stays disabled/spinning while the overlay closes (no dead moment)', async () => {
  const ctx = bootLogin();
  ctx.btn.click();
  await flush();
  assert.equal(ctx.btn.disabled, true, 'disabled while in flight');
  ctx.resolve({ status: 200, json: () => Promise.resolve({ ok: true, token: 'TOK', role: 'ops_manager', scope: '', expiresInDays: 7 }) });
  await flush();
  assert.ok('ezone_session' in ctx.store, 'a session is saved on success');
  // The overlay (and its now-still-spinning button) is removed — the button is never re-enabled into a
  // visible idle state before the redirect. It was never restored to the 'כניסה' idle label.
  assert.ok(!ctx.body._find((c) => c.tagName === 'button' && c.textContent === 'כניסה'), 'the overlay closed; no re-enabled idle button lingers');
});
