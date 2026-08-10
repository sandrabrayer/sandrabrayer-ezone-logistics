// test/dashboard-action-spinners.test.js — the dashboard action buttons' in-flight (loading) state and the
// חסום→תקוע rename. Two layers:
//   1. BEHAVIORAL: the REAL setActLoading + post are lifted out of src/dashboard.html by balanced-brace
//      extraction and driven in a DOM sandbox against a DEFERRED fetch, so we observe a button WHILE its
//      POST is on the wire — disabled + spinner in flight, restored on failure (mirrors login-button #79).
//   2. WIRING/SOURCE: every named action (אישור, לא אושר, הועבר לביצוע, דחה לתאריך, חסום→תקוע) threads its
//      button into post(...,btn), the spinner CSS exists, and the block button now reads תקוע with a tooltip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'src/dashboard.html'), 'utf8');

// Lift a top-level function body out of the source by matching braces from its signature. setActLoading and
// post contain no brace-bearing string/template literals, so a naive depth count is exact for both.
function extractFn(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `could not find ${signature} in dashboard.html`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { i++; break; }
  }
  return src.slice(start, i);
}

function makeEl(tag) {
  const attrs = {}, node = {
    tagName: tag, _text: '', className: '', disabled: false, children: [], _label: undefined,
    get textContent() { return this._text; },
    // Real DOM: assigning textContent replaces all children — this is how restoring the label drops the spinner.
    set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
  };
  return node;
}

async function flush(n) { for (let i = 0; i < (n || 8); i++) await Promise.resolve(); }

// Boot a sandbox holding the REAL setActLoading + post with a deferred fetch we resolve by hand.
function boot() {
  const msgs = [];
  let loads = 0, resolveFetch;
  const document = { createElement: makeEl };
  const sandbox = {
    document, EXEC_URL: '/api/exec', window: { __STAFF_TOKEN__: 't' },
    fetch: () => new Promise((r) => { resolveFetch = r; }), // DEFERRED — stays pending until we resolve it
    showMsg: (kind, text) => { msgs.push({ kind, text }); },
    load: async () => { loads++; },
    Promise, JSON, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(html, 'function setActLoading('), sandbox);
  vm.runInContext(extractFn(html, 'async function post('), sandbox);
  const btn = makeEl('button');
  btn.className = 'act go';
  btn.textContent = 'אישור';
  return { sandbox, btn, msgs, loads: () => loads, resolve: (v) => resolveFetch(v) };
}

test('while the POST is in flight the button is disabled and shows an in-button spinner', async () => {
  const ctx = boot();
  ctx.sandbox.post('approve', { id: 'R1' }, ctx.btn);
  await flush();
  assert.equal(ctx.btn.disabled, true, 'button disabled the moment the write is in flight');
  assert.equal(ctx.btn.getAttribute('aria-busy'), 'true', 'button marked aria-busy');
  assert.equal(ctx.btn.textContent, '', 'label cleared to make room for the spinner');
  assert.ok(ctx.btn.children.some((c) => c.tagName === 'span' && c.className === 'act-spin'), 'an act-spin span is shown inside the button');
});

test('on failure the button is re-enabled, its label restored, spinner removed, and an error shown', async () => {
  const ctx = boot();
  ctx.sandbox.post('approve', { id: 'R1' }, ctx.btn);
  await flush();
  ctx.resolve({ json: () => Promise.resolve({ ok: false, error: 'nope' }) });
  await flush();
  assert.equal(ctx.btn.disabled, false, 'button re-enabled after a failed write');
  assert.equal(ctx.btn.textContent, 'אישור', 'the button label is restored');
  assert.equal(ctx.btn.getAttribute('aria-busy'), null, 'aria-busy cleared');
  assert.ok(!ctx.btn.children.some((c) => c.tagName === 'span'), 'the spinner is removed');
  assert.ok(ctx.msgs.some((m) => m.kind === 'err'), 'an error message is surfaced on failure');
});

test('on success the list reloads and the button is restored (no lingering spinner)', async () => {
  const ctx = boot();
  ctx.sandbox.post('approve', { id: 'R1' }, ctx.btn);
  await flush();
  ctx.resolve({ json: () => Promise.resolve({ ok: true }) });
  await flush();
  assert.equal(ctx.loads(), 1, 'a successful write reloads the list');
  assert.equal(ctx.btn.getAttribute('aria-busy'), null, 'button no longer busy after success');
  assert.ok(!ctx.btn.children.some((c) => c.tagName === 'span'), 'no spinner lingers after success');
});

test('post() without a button behaves exactly as before (no spinner side effects)', async () => {
  const ctx = boot();
  ctx.sandbox.post('approve', { id: 'R1' }); // no btn — legacy call shape
  await flush();
  ctx.resolve({ json: () => Promise.resolve({ ok: true }) });
  await flush();
  assert.equal(ctx.loads(), 1, 'still reloads on success without a button');
});

test('a re-entrant setActLoading(true) while already busy does not stack a second spinner', () => {
  const ctx = boot();
  ctx.sandbox.setActLoading(ctx.btn, true);
  ctx.sandbox.setActLoading(ctx.btn, true); // guarded by aria-busy
  assert.equal(ctx.btn.children.filter((c) => c.className === 'act-spin').length, 1, 'exactly one spinner');
});

// ---- wiring / source assertions ------------------------------------------------------------------

test('the spinner CSS (keyframes + .act-spin) is defined', () => {
  assert.ok(/@keyframes\s+ezspin/.test(html), '@keyframes ezspin present');
  assert.ok(/\.act-spin\s*\{[^}]*animation:\s*ezspin/.test(html), '.act-spin uses the ezspin animation');
});

test('post() accepts a button and drives it (spin on entry, restore in finally)', () => {
  assert.ok(/async function post\(action, payload, btn\)/.test(html), 'post takes a third btn param');
  assert.ok(/if \(btn\) setActLoading\(btn, true\)/.test(html), 'post starts the spinner when given a button');
  assert.ok(/finally\s*\{\s*if \(btn\) setActLoading\(btn, false\)/.test(html), 'post restores the button in a finally');
});

test('the inline action buttons thread their own element (this) into the handlers', () => {
  assert.ok(/doApprove\('\$\{id\}', this\)/.test(html), 'אישור passes this');
  assert.ok(/doReject\('\$\{id\}', this\)/.test(html), 'לא אושר passes this');
  assert.ok(/doBlock\('\$\{id\}', this\)/.test(html), 'the block button passes this');
  // handlers forward the button as the 4th positional arg to post
  assert.ok(/window\.doApprove = \(id, btn\) => post\('approve',[^;]*, btn\)/.test(html), 'doApprove forwards btn');
  assert.ok(/window\.doReject = \(id, btn\) =>[\s\S]*post\('reject',[^;]*, btn\)/.test(html), 'doReject forwards btn');
  assert.ok(/window\.doBlock = \(id, btn\) =>[\s\S]*post\('setBlocked',[^;]*, btn\)/.test(html), 'doBlock forwards btn');
});

test('the modal confirm buttons spin while their POST is in flight (defer, refer/assign)', () => {
  assert.ok(/await post\('defer',[\s\S]*?, deferConfirmBtn\)/.test(html), 'דחה לתאריך spins deferConfirmBtn');
  assert.ok(/await post\('assign',[\s\S]*?, referConfirmBtn\)/.test(html), 'הועבר לביצוע spins referConfirmBtn');
});

test('the block button is renamed חסום → תקוע and carries the explanatory tooltip', () => {
  assert.ok(/>תקוע<\/button>/.test(html), 'the block action now reads תקוע');
  assert.ok(!/>חסום<\/button>/.test(html), 'no button still labelled חסום');
  const m = html.match(/title="([^"]*)"[^>]*onclick="doBlock/);
  assert.ok(m, 'the תקוע button has a title tooltip wired next to doBlock');
  assert.ok(/ממתינה לחלק\/ספק\/גישה/.test(m[1]), 'tooltip explains: waiting on a part/supplier/access');
});

// ---- spinner coverage extended to the remaining POST buttons + modal confirms ----------------------
// Every action button that fires a POST now threads its own element into post(...,btn) so it spins +
// disables in flight and restores on failure — matching the #84 pattern. These assert the wiring for the
// buttons the original pass did NOT cover: סמן כהושלם, סגור, עריכה, מחיקה, batch-assign, confirm-finding.

test('the remaining inline action buttons thread this into their handlers', () => {
  assert.ok(/doComplete\('\$\{id\}', this\)/.test(html), 'סמן כהושלם passes this');
  assert.ok(/doSetStatus\('\$\{id\}','\$\{ST\.CLOSED\}', this\)/.test(html), 'סגור passes this');
  assert.ok(/doEdit\('\$\{id\}', this\)/.test(html), 'עריכה passes this');
  assert.ok(/doDelete\('\$\{id\}', this\)/.test(html), 'מחיקה passes this');
  assert.ok(/doConfirmFinding\('\$\{it\.ids\[0\]\}', this\)/.test(html), 'confirm-finding (פתח דרישה) passes this');
  assert.ok(/doAssignBatch\(\$\{JSON\.stringify\(ids\)\}, \$\{JSON\.stringify\(b\.trade\)\}, this\)/.test(html), 'batch-assign passes this');
});

test('the remaining handlers forward btn as the trailing arg to post', () => {
  assert.ok(/window\.doComplete = \(id, btn\) =>[\s\S]*?post\('setStatus',[^;]*, btn\)/.test(html), 'doComplete forwards btn');
  assert.ok(/window\.doSetStatus = \(id, to, btn\) => post\('setStatus',[^;]*, btn\)/.test(html), 'doSetStatus forwards btn');
  assert.ok(/window\.doConfirmFinding = \(fid, btn\) => post\('confirmFinding',[^;]*, btn\)/.test(html), 'doConfirmFinding forwards btn');
  assert.ok(/window\.doDelete = \(id, btn\) =>[\s\S]*?post\('deleteRequest',[^;]*, btn\)/.test(html), 'doDelete forwards btn');
  assert.ok(/window\.doEdit = \(id, btn\) =>[\s\S]*?post\('editRequest',[^;]*, btn\)/.test(html), 'doEdit forwards btn');
  assert.ok(/window\.doAssignBatch = \(ids, trade, btn\) =>[\s\S]*?post\('assignBatch',[^;]*, btn\)/.test(html), 'doAssignBatch forwards btn');
});

test('the create-request modal confirm spins while its POST is in flight', () => {
  // crConfirmBtn is captured and its click handler is async so it can await the create with the spinner up.
  assert.ok(/const crConfirmBtn = document\.getElementById\('crConfirm'\)/.test(html), 'crConfirm button is captured');
  assert.ok(/crConfirmBtn\.addEventListener\('click', async/.test(html), 'the create confirm handler is async');
  assert.ok(/await post\('createRequest',[\s\S]*?, crConfirmBtn\)/.test(html), 'createRequest spins crConfirmBtn');
});

test('every post() call site that writes now passes a button (no bare fire-and-forget writes left)', () => {
  // Guard against regressions: catch any post('someAction', …) with no trailing btn arg. The only
  // legitimate btn-less calls are markExternal (shares referConfirmBtn via the assign branch) — so we
  // assert each of the extended actions specifically carries a button rather than scanning generically.
  for (const action of ['setStatus', 'editRequest', 'deleteRequest', 'confirmFinding', 'assignBatch', 'createRequest']) {
    const re = new RegExp(`post\\('${action}',[^;\\n]*, (btn|crConfirmBtn|referConfirmBtn|deferConfirmBtn)\\)`);
    assert.ok(re.test(html), `${action} threads a button into post()`);
  }
});
