// test/login-freeze.test.js — regression guard for the login-page freeze. Two independent hangs are fixed:
//
//   CLIENT: the shim's /api/login fetch had no timeout, so a stalled network left the כניסה button disabled
//           and the overlay stuck forever (the page "froze"). timedFetch now aborts on a timeout; the .catch
//           re-enables the button and shows 'שגיאת רשת'. Proven here by driving the REAL injected shim with a
//           fetch that never resolves and firing the abort timer.
//
//   SERVER (verified server-side, not UI-only): readJsonBody had no time bound, so a client that opened a
//           POST and never finished the body left the handler's await pending forever. It is now bounded by
//           BODY_TIMEOUT_MS. Proven here by opening a raw socket with a short server-side timeout and a body
//           that never completes, and asserting the server tears the request down (does not hang open).
// Env is set BEFORE importing server.js (it reads env at module-load time). APPS_SCRIPT_EXEC_URL is left
// empty so the login roster read returns null instantly — this test measures the BODY read timeout, not
// upstream latency. BODY_TIMEOUT_MS is tiny so the test doesn't wait the real 15s. server.js is imported
// DYNAMICALLY (below) so these run first (static imports are hoisted above top-level statements).
process.env.APPS_SCRIPT_EXEC_URL = '';
process.env.APP_PIN = '123456';
process.env.SESSION_SECRET = 'k'.repeat(32);
process.env.SESSION_DAYS = '7';
process.env.BODY_TIMEOUT_MS = '300';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import net from 'node:net';
import { createServer } from 'node:http';

const { _CLIENT_SHIM, requestHandler } = await import('../src/server.js');

// ---------- CLIENT: a hung /api/login no longer freezes the overlay ----------

function makeEl(tag) {
  const listeners = {};
  const node = {
    tagName: tag, _id: '', className: '', textContent: '', value: '', type: '', disabled: false,
    style: {}, children: [], parentNode: null,
    get id() { return this._id; }, set id(v) { this._id = v; },
    set innerHTML(v) { this._h = v; if (v === '') this.children = []; }, get innerHTML() { return this._h || ''; },
    setAttribute(k, v) { if (k === 'id') this._id = v; this[k] = v; },
    getAttribute(k) { return k in this ? this[k] : null; },
    appendChild(c) { c.parentNode = node; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); return c; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    click() { (listeners.click || []).forEach((fn) => fn({})); },
    focus() {}, querySelectorAll() { return []; }, querySelector() { return null; },
    _find(pred) { for (const c of this.children) { if (pred(c)) return c; const r = c._find && c._find(pred); if (r) return r; } return null; },
  };
  return node;
}

test('CLIENT: a hung /api/login aborts on timeout — button re-enabled, error shown (no freeze)', async () => {
  const timers = [];
  const store = {};
  let body = null;
  const domL = {};
  const document = {
    get body() { return body; }, createElement: makeEl, getElementById: () => null,
    querySelector: (sel) => (sel === '.nav' ? makeEl('nav') : null), querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); },
  };
  const location = { pathname: '/login', href: '/login', reload() {}, replace() {} };
  // /api/login NEVER resolves on its own; it only rejects when its AbortSignal fires.
  const realFetch = (url, init) => new Promise((resolve, reject) => {
    if (String(url).indexOf('/api/login') === 0) {
      const sig = init && init.signal;
      if (sig) sig.onabort = () => reject(new Error('AbortError'));
      return; // hang until aborted
    }
    resolve({ status: 404, json: () => Promise.resolve({ ok: false }) });
  });
  function FakeAbortController() { this.signal = { aborted: false, onabort: null }; }
  FakeAbortController.prototype.abort = function abort() { this.signal.aborted = true; if (typeof this.signal.onabort === 'function') this.signal.onabort(); };

  const windowObj = { fetch: realFetch, __FORCE_LOGIN__: true, __LOGIN_NAMES__: ['רועי', 'שירה'], addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); } };
  const sandbox = {
    window: windowObj, document, navigator: {}, get fetch() { return windowObj.fetch; },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location, Promise, JSON, Date, console,
    AbortController: FakeAbortController,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(_CLIENT_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, ''), sandbox);
  body = makeEl('body');
  (domL.DOMContentLoaded || []).forEach((fn) => fn({}));
  for (let i = 0; i < 8; i++) await Promise.resolve();

  const btn = body._find((c) => c.tagName === 'button' && c.textContent === 'כניסה');
  assert.ok(btn, 'the login overlay must appear');
  btn.click();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(btn.disabled, true, 'button disabled while the request is in flight');

  // Fire the abort timer (the timeout) — simulate the hung request being cut off.
  assert.ok(timers.length >= 1, 'timedFetch must arm a timeout for the login request');
  timers.forEach((fn) => fn());
  for (let i = 0; i < 8; i++) await Promise.resolve();

  assert.equal(btn.disabled, false, 'button MUST be re-enabled after the timeout (no freeze)');
  const card = btn.parentNode;
  const err = card.children[card.children.indexOf(btn) + 1];
  assert.equal(err.textContent, 'שגיאת רשת', 'a network error is surfaced to the user');
});

// ---------- SERVER: a stalled request body cannot hang the handler ----------

let app, port;
before(async () => {
  app = createServer(requestHandler);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  port = app.address().port;
});
after(async () => { await new Promise((r) => app.close(r)); });

test('SERVER: a POST whose body never completes is torn down (readJsonBody is time-bounded, no hang)', async () => {
  await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      // Announce a 1000-byte body but send only a few bytes, then stall forever.
      sock.write('POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n');
      sock.write('{"name":');
    });
    let settled = false;
    const done = (fn) => { if (settled) return; settled = true; clearTimeout(guard); fn(); };
    // The server must end the request within a small multiple of BODY_TIMEOUT_MS — either by responding or
    // by closing the socket. If it HANGS (the bug), neither fires and the guard rejects.
    sock.on('data', () => done(() => { sock.destroy(); resolve(); }));   // got a response
    sock.on('close', () => done(resolve));                               // server tore the connection down
    sock.on('error', () => done(resolve));
    const guard = setTimeout(() => done(() => { sock.destroy(); reject(new Error('server hung on a stalled body')); }), 3000);
  });
});
