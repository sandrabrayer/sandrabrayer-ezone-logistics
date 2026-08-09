// test/dashboard-notfound-refresh.test.js — acting on a request that was DELETED since the board
// rendered. The server answers { ok:false, error:'Request not found' }; the dashboard must (a) show a
// Hebrew message (not the raw English), (b) refresh() the board so the dead card disappears, and (c)
// clear the error banner — auto after ~6s, or immediately on the next successful action (a stuck error
// banner earlier caused a "broken on load" misdiagnosis). Drives the REAL post()/showMsg in a DOM sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(root, 'src/dashboard.html'), 'utf8');
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
    removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); return c; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    click() { (listeners.click || []).forEach((fn) => fn({})); },
    focus() {}, classList: { add() {}, remove() {} }, querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  return node;
}

// Boot the dashboard. `postResponses` is a queue consumed one-per-POST; a GET (pageData) always succeeds
// and bumps pageDataCount (so a refresh is observable). Timers are captured so the ~6s auto-clear is
// deterministic (flushTimers runs the pending callbacks).
function boot(postResponses) {
  const ids = {};
  const getEl = (id) => (ids[id] || (ids[id] = (() => { const e = makeEl('div'); e.id = id; return e; })()));
  const body = makeEl('body');
  const domL = {};
  const document = {
    get body() { return body; }, createElement: makeEl, getElementById: getEl,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); },
  };
  let pageDataCount = 0;
  const queue = (postResponses || []).slice();
  const fetchMock = (input) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (u.includes('pageData')) {
      pageDataCount++;
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: { requests: [], houses: [], findings: [], inspections: [], config: { approval_threshold: 3000 } } }) });
    }
    const r = queue.length ? queue.shift() : { ok: true };
    return Promise.resolve({ json: () => Promise.resolve(r) });
  };
  // Controllable timers.
  const timers = []; let tid = 0;
  const setTimeout_ = (fn) => { const id = ++tid; timers.push({ id, fn }); return id; };
  const clearTimeout_ = (id) => { const i = timers.findIndex((t) => t.id === id); if (i !== -1) timers.splice(i, 1); };
  const flushTimers = () => { const pending = timers.splice(0); pending.forEach((t) => t.fn()); };

  const windowObj = { fetch: fetchMock, __ROLE__: 'ops_manager', __EXEC_URL__: '/api/exec', __STAFF_TOKEN__: '1', addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); } };
  const sandbox = {
    window: windowObj, document, navigator: {}, get fetch() { return windowObj.fetch; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { pathname: '/dashboard', reload() {}, replace() {} },
    Promise, JSON, Date, console, prompt: () => '', confirm: () => true,
    setTimeout: setTimeout_, clearTimeout: clearTimeout_,
  };
  vm.createContext(sandbox);
  for (const s of PAGE_SCRIPTS) vm.runInContext(s, sandbox);
  (domL.DOMContentLoaded || []).forEach((fn) => fn({}));
  return { sandbox, getEl, flushTimers, pageData: () => pageDataCount };
}
const flush = async (n = 24) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test('"Request not found" → Hebrew message AND a board refresh (the dead card disappears)', async () => {
  const ctx = boot([{ ok: false, error: 'Request not found' }]);
  await flush();
  const before = ctx.pageData(); // initial load
  await ctx.sandbox.post('approve', { id: 'R-GONE' }, null);
  await flush();
  const msg = ctx.getEl('msg');
  assert.equal(msg.textContent, 'הדרישה כבר לא קיימת — הלוח רוענן', 'Hebrew message, not the raw English');
  assert.match(msg.className, /\berr\b/);
  assert.equal(ctx.pageData(), before + 1, 'the board is refreshed (pageData re-fetched) so the stale card goes');
});

test('the error banner clears on the next successful action', async () => {
  const ctx = boot([{ ok: false, error: 'Request not found' }, { ok: true }]);
  await flush();
  await ctx.sandbox.post('approve', { id: 'R-GONE' }, null); // error
  await flush();
  assert.match(ctx.getEl('msg').textContent, /לא קיימת/);
  await ctx.sandbox.post('approve', { id: 'R-OK' }, null);   // success replaces it
  await flush();
  const msg = ctx.getEl('msg');
  assert.equal(msg.textContent, 'בוצע.', 'the success banner replaces the lingering error');
  assert.match(msg.className, /\bok\b/);
});

test('an error banner auto-clears after the timeout (no longer sticks forever)', async () => {
  const ctx = boot([{ ok: false, error: 'הפעולה נכשלה משום מה' }]);
  await flush();
  await ctx.sandbox.post('approve', { id: 'R-1' }, null);
  await flush();
  assert.notEqual(ctx.getEl('msg').textContent, '', 'error is shown first');
  assert.match(ctx.getEl('msg').className, /\berr\b/);
  ctx.flushTimers(); // simulate the ~6s elapsing
  const msg = ctx.getEl('msg');
  assert.equal(msg.textContent, '', 'the banner text is cleared');
  assert.equal(msg.className, 'msg', 'the banner styling is reset (no err/ok)');
});
