// test/dashboard-spinner.test.js — the in-flight spinner on the dashboard action buttons
// (same pattern as the #79 login button, src/server.js setLoading) and the חסום→תקוע rename.
//
// Part 1 (functional): runs the REAL dashboard.html inline scripts in a DOM sandbox and drives an
// action through the shared post() path with a button whose state it can observe — asserting the
// button is disabled + shows a spinner while the POST is in flight, is RESTORED on failure (so it
// can be retried), and is likewise restored after a successful write.
// Part 2 (static): the חסום button is relabelled תקוע with an explanatory tooltip, every action
// button forwards its element to its handler, and the three modal confirms spin their own button
// and only dismiss on success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(root, 'src/dashboard.html'), 'utf8');
const PAGE_SCRIPTS = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// A minimal element good enough for the dashboard scripts' load/render + who()/showMsg.
function makeEl(tag) {
  const attrs = {}, listeners = {};
  const node = {
    tagName: tag, _id: '', className: '', textContent: '', value: '', type: '', disabled: false,
    selectedIndex: 0, style: {}, children: [], parentNode: null,
    get id() { return this._id; }, set id(v) { this._id = v; },
    set innerHTML(v) { this._h = v; if (v === '') this.children = []; }, get innerHTML() { return this._h || ''; },
    setAttribute(k, v) { if (k === 'id') this._id = v; attrs[k] = v; },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    appendChild(c) { c.parentNode = node; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); return c; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    click() { (listeners.click || []).forEach((fn) => fn({})); },
    focus() {}, classList: { add() {}, remove() {} }, querySelectorAll() { return []; }, querySelector() { return null; },
  };
  return node;
}

// A button whose loading state the test can observe (classList + attributes + disabled + innerHTML).
function makeButton(label) {
  const classes = new Set(), attrs = {};
  return {
    disabled: false, _h: label,
    get innerHTML() { return this._h; }, set innerHTML(v) { this._h = v; },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: (k) => { delete attrs[k]; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
}

const req = (id, cost) => ({ id, house: 'רמות השבים', status: 'דרישה', urgency: 'רגיל', estimated_cost: cost, created_at: '2026-08-01', created_by: 'שירה' });
const flush = async (n = 24) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// Boots the dashboard scripts. `writeResponder` returns the JSON body for a write POST (non-pageData);
// return a pending Promise-resolver hook by using the exposed `pending`.
function boot(role) {
  const ids = {};
  const getEl = (id) => (ids[id] || (ids[id] = (() => { const e = makeEl('div'); e.id = id; return e; })()));
  const body = makeEl('body');
  const domL = {};
  const document = {
    get body() { return body; }, createElement: makeEl, getElementById: getEl,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); },
  };
  let resolveWrite = null;
  const fetchMock = (input) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (u.includes('pageData')) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: { requests: [req('R1', 500)], config: { approval_threshold: 3000 }, houses: [], findings: [], inspections: [] } }) });
    }
    // A write POST — stays pending until the test resolves it, so the in-flight state is observable.
    return new Promise((resolve) => { resolveWrite = (body) => resolve({ json: () => Promise.resolve(body) }); });
  };
  const windowObj = { fetch: fetchMock, __ROLE__: role, __EXEC_URL__: '/api/exec', __STAFF_TOKEN__: '1', addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); } };
  const sandbox = {
    window: windowObj, document, navigator: {}, get fetch() { return windowObj.fetch; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { pathname: '/dashboard', reload() {}, replace() {} },
    Promise, JSON, Date, console, setTimeout, prompt: () => 'x', confirm: () => true,
  };
  vm.createContext(sandbox);
  for (const s of PAGE_SCRIPTS) vm.runInContext(s, sandbox);
  (domL.DOMContentLoaded || []).forEach((fn) => fn({}));
  return { window: windowObj, getEl, resolveWrite: (body) => resolveWrite(body) };
}

// ---- Part 1: functional spinner behaviour ----

test('an action button is disabled + shows a spinner while its POST is in flight', async () => {
  const ctx = boot('ceo');
  await flush(); // let the initial pageData load settle
  const btn = makeButton('אישור');
  ctx.window.doApprove('R1', btn); // routes through post() with this button
  // Synchronously after the call, setBtnLoading has run (before the first await in post()).
  assert.equal(btn.disabled, true, 'button disabled during the POST');
  assert.ok(btn.classList.contains('busy'), 'busy class applied (keeps it readable, not dimmed)');
  assert.equal(btn.getAttribute('aria-busy'), 'true', 'aria-busy set for a11y');
  assert.match(btn.innerHTML, /act-spin/, 'a spinner is shown inside the button');
});

test('on write FAILURE the button is restored (re-enabled + label back) so it can be retried', async () => {
  const ctx = boot('ceo');
  await flush();
  const btn = makeButton('אישור');
  ctx.window.doApprove('R1', btn);
  ctx.resolveWrite({ ok: false, error: 'boom' }); // server rejects the write
  await flush();
  assert.equal(btn.disabled, false, 're-enabled after failure');
  assert.equal(btn.innerHTML, 'אישור', 'original label restored');
  assert.ok(!btn.classList.contains('busy'), 'busy class removed');
  assert.equal(btn.getAttribute('aria-busy'), null, 'aria-busy cleared');
});

test('on write SUCCESS the button is restored after the board reloads', async () => {
  const ctx = boot('ceo');
  await flush();
  const btn = makeButton('אישור');
  ctx.window.doApprove('R1', btn);
  ctx.resolveWrite({ ok: true }); // server accepts; post() then reloads the board
  await flush();
  assert.equal(btn.disabled, false, 're-enabled after a successful write + reload');
  assert.equal(btn.innerHTML, 'אישור', 'label restored');
  assert.ok(!btn.classList.contains('busy'), 'busy class removed');
});

test('post() reports success/failure so modal confirms can close only on success', async () => {
  const ok = boot('ceo'); await flush();
  const pOk = ok.window.doApprove('R1', makeButton('אישור'));
  ok.resolveWrite({ ok: true });
  assert.equal(await pOk, true, 'a successful write resolves post() to true');

  const bad = boot('ceo'); await flush();
  const pBad = bad.window.doApprove('R1', makeButton('אישור'));
  bad.resolveWrite({ ok: false, error: 'nope' });
  assert.equal(await pBad, false, 'a failed write resolves post() to false');
});

// ---- Part 2: static rename + wiring guards ----

test('the block button is relabelled תקוע with an explanatory tooltip, and posts setBlocked', () => {
  assert.match(HTML, />תקוע<\/button>/, 'the block button reads תקוע');
  const btn = HTML.match(/<button class="act"[^>]*onclick="doBlock\('\$\{id\}', this\)">תקוע<\/button>/);
  assert.ok(btn, 'the תקוע button forwards its element to doBlock');
  assert.match(btn[0], /title="[^"]*ממתינה[^"]*"/, 'the תקוע button has a tooltip explaining a stuck request');
  assert.match(HTML, /post\('setBlocked', \{ id, blocked: true/, 'doBlock still posts setBlocked (server contract unchanged)');
  // No user-facing "חסום/חסימה" label survives on the button or the badge (data fields stay `blocked*`).
  assert.doesNotMatch(HTML, />⛔ חסום/, 'the badge no longer reads חסום');
  assert.doesNotMatch(HTML, />חסום<\/button>|>בטל חסימה<\/button>/, 'no חסום/בטל חסימה button labels remain');
});

test('every action button forwards its element (this) to its handler', () => {
  for (const call of [
    /doApprove\('\$\{id\}', this\)/, /doReject\('\$\{id\}', this\)/, /doBlock\('\$\{id\}', this\)/,
    /doUnblock\('\$\{id\}', this\)/, /doComplete\('\$\{id\}', this\)/, /doSetStatus\('\$\{id\}','\$\{ST\.CLOSED\}', this\)/,
    /doEdit\('\$\{id\}', this\)/, /doDelete\('\$\{id\}', this\)/, /doConfirmFinding\('\$\{it\.ids\[0\]\}', this\)/,
  ]) {
    assert.match(HTML, call, `button forwards its element: ${call}`);
  }
});

test('modal confirms spin their own button and dismiss only on success', () => {
  // defer + refer(assign) + create each pass ev.currentTarget to post() and gate the close on the result.
  assert.match(HTML, /deferConfirm'\)\.addEventListener\('click', async \(ev\)/, 'deferConfirm is async and receives the event');
  assert.match(HTML, /post\('defer',[^;]*ev\.currentTarget\)/, 'defer posts with its confirm button');
  assert.match(HTML, /if \(ok\) \{ deferModal\.classList\.remove\('open'\)/, 'defer closes only on success');

  assert.match(HTML, /referConfirm'\)\.addEventListener\('click', async \(ev\)/, 'referConfirm is async and receives the event');
  assert.match(HTML, /post\('assign',[^;]*ev\.currentTarget\)/, 'assign posts with the refer confirm button');
  assert.match(HTML, /if \(await result\) \{ referModal\.classList\.remove\('open'\)/, 'refer closes only on success');

  assert.match(HTML, /crConfirm'\)\.addEventListener\('click', async \(ev\)/, 'crConfirm is async and receives the event');
  assert.match(HTML, /post\('createRequest',[^;]*ev\.currentTarget\)/, 'create posts with its confirm button');
  assert.match(HTML, /if \(ok\) createModal\.classList\.remove\('open'\)/, 'create closes only on success');
});

test('the spinner CSS + keyframes exist (matches the #79 login spinner)', () => {
  assert.match(HTML, /\.act-spin\s*\{/, 'a .act-spin rule exists');
  assert.match(HTML, /@keyframes\s+act-spin/, 'the spin animation is defined');
  assert.match(HTML, /button\.act\.busy[^{]*\{[^}]*opacity:\s*1/, 'busy buttons stay readable (opacity 1)');
});
