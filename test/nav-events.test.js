// test/nav-events.test.js — the /events nav link ("אירועים חריגים") is a DISPLAY-ONLY convenience the
// auth shim injects for every role that MAY report an event (everyone except maintenance). The server +
// Code.gs enforce the real create/edit rules. Here we drive the real injected shim in a DOM sandbox and
// assert the link appears for reporters and is absent for maintenance and for a logged-out session.
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
  const location = { pathname: pathname || '/dashboard', reload() {} };
  const sandbox = { window, document, localStorage, sessionStorage, location, Promise, JSON, Date, console };
  const code = _CLIENT_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, '');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return nav.querySelector('a[href="/events"]');
}

test('every reporting role (coordinator, field_ops, ops_manager, ceo) sees the "אירועים חריגים" nav link', () => {
  for (const role of ['coordinator', 'field_ops', 'ops_manager', 'ceo']) {
    const link = runShim(role, '/dashboard');
    assert.ok(link, `${role} must see the /events nav link`);
    assert.equal(link.textContent, 'אירועים חריגים');
    assert.equal(link.getAttribute('href'), '/events');
  }
});

test('maintenance does NOT see the /events nav link', () => {
  assert.equal(runShim('maintenance', '/dashboard'), null);
});

test('logged-out (no session) → no /events nav link', () => {
  assert.equal(runShim('', '/dashboard'), null);
});

test('on the /events page the injected link is marked active', () => {
  const link = runShim('coordinator', '/events');
  assert.ok(link);
  assert.equal(link.className, 'active');
});
