// test/nav-management.test.js — the /management nav link ("ניהול תפעולי רשת") is a DISPLAY-ONLY
// convenience injected by the auth shim, shown ONLY to exec roles (ops_manager / ceo). The server +
// Code.gs 403 gate remain the authority (covered elsewhere). Here we drive the real injected shim in a
// DOM sandbox and assert the link appears for execs and is absent for everyone else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { _CLIENT_SHIM } from '../src/server.js';

function makeEl(tag) {
  const attrs = {};
  return {
    tagName: tag, _id: '', className: '', textContent: '', style: {}, children: [],
    get id() { return this._id; }, set id(v) { this._id = v; },
    setAttribute(k, v) { if (k === 'id') this._id = v; attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    appendChild(c) { this.children.push(c); },
    addEventListener() {}, focus() {},
    querySelector(sel) {
      const m = sel.match(/^a\[href="([^"]+)"\]$/);
      if (m) return this.children.find((c) => c.tagName === 'a' && c.getAttribute && c.getAttribute('href') === m[1]) || null;
      return null;
    },
  };
}

// Run the shim with a persisted session for `role` on page `pathname`; return the nav's /management link.
function runShim(role, pathname) {
  const store = { ezone_session: JSON.stringify({ token: 'T', role, scope: '', exp: Date.now() + 30 * 864e5 }) };
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const nav = makeEl('nav');
  const body = makeEl('body');
  const document = {
    body, createElement: makeEl, getElementById: () => null,
    querySelector: (sel) => (sel === '.nav' ? nav : null),
    addEventListener() {},
  };
  const window = { fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve({}) }) };
  const location = { pathname: pathname || '/dashboard', reload() {} };
  const sandbox = { window, document, localStorage, sessionStorage, location, Promise, JSON, Date, console };
  const code = _CLIENT_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, '');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { link: nav.querySelector('a[href="/management"]'), window };
}

test('exec roles (ops_manager, ceo) see the "ניהול תפעולי רשת" nav link', () => {
  for (const role of ['ops_manager', 'ceo']) {
    const { link } = runShim(role, '/dashboard');
    assert.ok(link, `${role} must see the /management nav link`);
    assert.equal(link.textContent, 'ניהול תפעולי רשת');
    assert.equal(link.getAttribute('href'), '/management');
  }
});

test('non-exec roles (coordinator, field_ops, maintenance) do NOT see the nav link', () => {
  for (const role of ['coordinator', 'field_ops', 'maintenance']) {
    const { link } = runShim(role, '/dashboard');
    assert.equal(link, null, `${role} must NOT see the /management nav link`);
  }
});

test('on the /management page the injected link is marked active (exec)', () => {
  const { link } = runShim('ceo', '/management');
  assert.ok(link);
  assert.equal(link.className, 'active');
});

test('no session (logged out) → no nav link injected', () => {
  // Empty store: loadSession returns null, so the shim mounts nothing until login.
  const nav = makeEl('nav');
  const document = { body: makeEl('body'), createElement: makeEl, getElementById: () => null, querySelector: (s) => (s === '.nav' ? nav : null), addEventListener() {} };
  const sandbox = {
    window: { fetch: () => Promise.resolve({}) }, document,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { pathname: '/dashboard', reload() {} }, Promise, JSON, Date, console,
  };
  const code = _CLIENT_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, '');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  assert.equal(nav.querySelector('a[href="/management"]'), null);
});
