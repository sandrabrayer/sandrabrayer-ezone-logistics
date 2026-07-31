// test/session-signout.test.js — drives the REAL injected auth shim (exported from server.js) in a
// minimal DOM sandbox to prove the sign-out flow: one click clears the persisted token and the NEXT
// data call is unauthenticated (blocked behind the login prompt, no Bearer sent). Tokens are stateless
// HMAC, so a client-side clear is a complete sign-out — there is no server session to revoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { _CLIENT_SHIM } from '../src/server.js';

// Build a tiny DOM/window/storage sandbox, run the shim, and return handles to poke at it.
function runShim(seedSession) {
  const store = {};
  if (seedSession) store['ezone_session'] = JSON.stringify(seedSession);
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

  const byId = {};
  function makeEl(tag) {
    const listeners = {};
    const e = {
      tagName: tag, style: {}, children: [], _id: '', textContent: '', disabled: false,
      get id() { return this._id; }, set id(v) { this._id = v; },
      setAttribute(k, v) { if (k === 'id') this._id = v; this[k] = v; },
      appendChild(c) { this.children.push(c); if (c._id) byId[c._id] = c; },
      addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      removeChild() {}, focus() {},
      click() { (listeners.click || []).forEach((f) => f({})); },
    };
    return e;
  }
  const body = makeEl('body');
  const document = {
    body,
    createElement: makeEl,
    getElementById: (id) => byId[id] || null,
    addEventListener: () => {},
  };

  const fetchCalls = [];
  const recorder = (url, opts) => {
    fetchCalls.push({ url, opts: opts || {} });
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, data: [] }) });
  };
  let reloads = 0;
  const location = { reload() { reloads += 1; } };
  const window = { fetch: recorder };

  const sandbox = { window, document, localStorage, sessionStorage, location, Promise, JSON, Date, console };
  const code = _CLIENT_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, '');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  return {
    window, document, location,
    dataCalls: () => fetchCalls.filter((c) => String(c.url).startsWith('/api/data')),
    storedToken: () => (store['ezone_session'] ? JSON.parse(store['ezone_session']).token : null),
    signOutBtn: () => document.getElementById('ezone-signout'),
  };
}

const SESSION = { token: 'TESTTOKEN', role: 'ops_manager', scope: '', exp: Date.now() + 30 * 864e5 };

test('a rehydrated session mounts the sign-out control and sends the Bearer token', async () => {
  const h = runShim(SESSION);
  // Rehydrated: the sign-out button is mounted and the session flag is set.
  assert.ok(h.signOutBtn(), 'sign-out control must be mounted when a session is active');
  assert.equal(h.window.__STAFF_TOKEN__, '1');
  // A data call before sign-out carries the Bearer token.
  await h.window.fetch('/api/exec?action=requests');
  const before = h.dataCalls();
  assert.equal(before.length, 1);
  assert.equal(before[0].url, '/api/data?action=requests');
  assert.equal(before[0].opts.headers.Authorization, 'Bearer TESTTOKEN');
});

test('sign-out clears the persisted token and the NEXT data call is unauthenticated', async () => {
  const h = runShim(SESSION);
  assert.equal(h.storedToken(), 'TESTTOKEN', 'token persisted before sign-out');
  await h.window.fetch('/api/exec?action=requests');           // authenticated call works
  const authedCalls = h.dataCalls().length;
  assert.equal(authedCalls, 1);

  // Sign out.
  h.signOutBtn().click();

  // Stored token is GONE, the in-memory session flag is cleared, and the page was reloaded.
  assert.equal(h.storedToken(), null, 'persisted token must be removed on sign-out');
  assert.equal(h.window.__STAFF_TOKEN__, '', 'in-memory session flag cleared');

  // The next data call does NOT reach the backend with a token — it is blocked behind the login
  // prompt (ensureAuth has no token → opens login), i.e. unauthenticated.
  h.window.fetch('/api/exec?action=requests');
  await Promise.resolve();
  assert.equal(h.dataCalls().length, authedCalls, 'no authenticated data call after sign-out');
});
