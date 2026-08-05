// test/nav-events.test.js — the /events nav link ("אירועים חריגים") in the role-based nav the auth shim
// now renders (increment 38). The shim rebuilds .nav from NAV_BY_ROLE for the session role and only shows
// links the role may open; it is DISPLAY-ONLY (server + Code.gs enforce the real rules). Here we drive the
// real injected shim in a DOM sandbox, ON A PAGE EACH ROLE MAY OPEN, and assert the /events link appears
// for reporters (coordinator/field_ops/ops_manager/ceo) and is absent for maintenance and logged-out.
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

function runShim(role, pathname) {
  const store = role ? { ezone_session: JSON.stringify({ token: 'T', role, scope: '', exp: Date.now() + 30 * 864e5 }) } : {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const nav = makeEl('nav');
  const document = {
    body: makeEl('body'), createElement: makeEl, getElementById: () => null,
    querySelector: (sel) => (sel === '.nav' ? nav : null), addEventListener() {},
  };
  const window = { fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve({}) }) };
  const location = { pathname: pathname || '/', reload() {}, replace() {} };
  const sandbox = { window, document, localStorage, sessionStorage, location, Promise, JSON, Date, console };
  const code = _CLIENT_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, '');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return nav.querySelector('a[href="/events"]');
}

// Each role is tested on a page IT MAY OPEN (else the shim redirects and renders no nav).
test('every reporting role (coordinator, field_ops, ops_manager, ceo) sees the "אירועים חריגים" nav link', () => {
  const onPage = { coordinator: '/status', field_ops: '/dashboard', ops_manager: '/dashboard', ceo: '/dashboard' };
  for (const role of ['coordinator', 'field_ops', 'ops_manager', 'ceo']) {
    const link = runShim(role, onPage[role]);
    assert.ok(link, `${role} must see the /events nav link`);
    assert.equal(link.textContent, 'אירועים חריגים');
    assert.equal(link.getAttribute('href'), '/events');
  }
});

test('maintenance does NOT see the /events nav link (on a page it may open)', () => {
  assert.equal(runShim('maintenance', '/dashboard'), null);
});

test('logged-out (no session) → no /events nav link', () => {
  assert.equal(runShim('', '/'), null);
});

test('on the /events page the link is marked active', () => {
  const link = runShim('coordinator', '/events');
  assert.ok(link);
  assert.equal(link.className, 'active');
});

// The shim REDIRECTS a role away from a page it may not open (coordinator landing on /dashboard).
function runShimCapturingRedirect(role, pathname) {
  const store = { ezone_session: JSON.stringify({ token: 'T', role, scope: '', exp: Date.now() + 30 * 864e5 }) };
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const nav = makeEl('nav');
  const document = { body: makeEl('body'), createElement: makeEl, getElementById: () => null, querySelector: (sel) => (sel === '.nav' ? nav : null), addEventListener() {} };
  const window = { fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve({}) }) };
  let replacedTo = null;
  const location = { pathname, reload() {}, replace(u) { replacedTo = u; } };
  const sandbox = { window, document, localStorage, sessionStorage, location, Promise, JSON, Date, console };
  const code = _CLIENT_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, '');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { replacedTo, navChildren: nav.children.length };
}

test('coordinator on a disallowed page (/dashboard) is redirected to their home (/status) and no nav is rendered', () => {
  const { replacedTo, navChildren } = runShimCapturingRedirect('coordinator', '/dashboard');
  assert.equal(replacedTo, '/status');
  assert.equal(navChildren, 0);
});

test('field_ops on /management is redirected to their home (/dashboard) (management is exec-only)', () => {
  const { replacedTo } = runShimCapturingRedirect('field_ops', '/management');
  assert.equal(replacedTo, '/dashboard');
});

test('an allowed page is NOT redirected (coordinator on /status)', () => {
  const { replacedTo } = runShimCapturingRedirect('coordinator', '/status');
  assert.equal(replacedTo, null);
});
