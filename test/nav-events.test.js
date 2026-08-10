// test/nav-events.test.js — guards the NAV CLEANUP: the "אירועים חריגים" (/events) link and the standalone
// "דרישה חדשה" (/) link were REMOVED from the role-based nav the auth shim renders. This drives the real
// injected shim in a DOM sandbox and asserts neither link appears for ANY role, and that the shim's
// redirect behavior (bouncing a role off a page it may not open, never off '/') is unchanged.
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
  return nav; // inspect nav.children for rendered links
}
const hrefs = (nav) => nav.children.filter((c) => c.tagName === 'a').map((a) => a.getAttribute('href'));

// Each role is checked on a page IT MAY OPEN (else the shim redirects and renders no nav).
test('NO role sees the removed "אירועים חריגים" (/events) or "דרישה חדשה" (/) nav links', () => {
  const onPage = { coordinator: '/', maintenance: '/dashboard', field_ops: '/dashboard', ops_manager: '/dashboard', ceo: '/dashboard' };
  for (const role of ['coordinator', 'maintenance', 'field_ops', 'ops_manager', 'ceo']) {
    const nav = runShim(role, onPage[role]);
    assert.equal(nav.querySelector('a[href="/events"]'), null, `${role} must NOT see the removed /events link`);
    assert.equal(nav.querySelector('a[href="/"]'), null, `${role} must NOT see a standalone / (request form) link`);
  }
});

test('managers still see their real nav pages (dashboard…management); the removal did not blank the nav', () => {
  const nav = runShim('ops_manager', '/dashboard');
  const got = hrefs(nav);
  assert.deepEqual(got, ['/dashboard', '/workorders', '/inventory', '/inspection', '/reports', '/management', '/help']);
});

test('field_ops nav excludes /management, /events and / ', () => {
  const got = hrefs(runShim('field_ops', '/dashboard'));
  assert.ok(!got.includes('/management') && !got.includes('/events') && !got.includes('/'));
  assert.deepEqual(got, ['/dashboard', '/workorders', '/inventory', '/inspection', '/reports', '/help']);
});

test('logged-out (no session) → no nav links at all', () => {
  assert.deepEqual(hrefs(runShim('', '/')), []);
});

// The shim REDIRECTS a role away from a page it may not open (coordinator landing on /dashboard), but
// never off '/' (the root/login landing). Unchanged by the cleanup.
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

test('coordinator on a disallowed page (/dashboard) is redirected to / and no nav is rendered', () => {
  const { replacedTo, navChildren } = runShimCapturingRedirect('coordinator', '/dashboard');
  assert.equal(replacedTo, '/');
  assert.equal(navChildren, 0);
});

test('field_ops on /management is redirected to / (management is exec-only)', () => {
  const { replacedTo } = runShimCapturingRedirect('field_ops', '/management');
  assert.equal(replacedTo, '/');
});

test('an allowed landing is NOT redirected (coordinator on /)', () => {
  const { replacedTo } = runShimCapturingRedirect('coordinator', '/');
  assert.equal(replacedTo, null);
});
