// test/dashboard-approve-gate.test.js — renders the REAL dashboard.html inline scripts in a DOM sandbox
// (adapted from login-page.test.js) with a mocked pageData response, and asserts the UI half of the
// approval gate (chain B v3 — אולגה approves everything):
//   1. NO error banner on load — the dashboard's only load-time call is the pageData GET; nothing 403-able
//      fires, so #msg stays empty (the production "הפעולה נכשלה — Forbidden…" banner came from CLICKING
//      approve on a request the role could not approve, which is now prevented, not from load).
//   2. field_ops sees a DISABLED "ממתין לאישור אולגה" on EVERY non-emergency request (no field_ops tier)
//      — no clickable-then-403.
//   3. ops_manager sees a real אישור on any amount, and the delete button only shows for the exec role
//      (field_ops never sees מחיקה); a stale ceo token gets nothing.
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

// A pending (status דרישה) request at a given cost — the field the approval router reads.
const req = (id, cost) => ({ id, house: 'רמות השבים', status: 'דרישה', urgency: 'רגיל', estimated_cost: cost, created_at: '2026-08-01', created_by: 'שירה' });

function renderDashboard(role, requests) {
  const ids = {};
  const getEl = (id) => (ids[id] || (ids[id] = (() => { const e = makeEl('div'); e.id = id; return e; })()));
  const body = makeEl('body');
  const domL = {};
  const document = {
    get body() { return body; }, createElement: makeEl, getElementById: getEl,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); },
  };
  const calls = [], posts = [];
  const fetchMock = (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    calls.push(u);
    if (init && String(init.method || 'GET').toUpperCase() === 'POST') { try { posts.push(JSON.parse(init.body)); } catch (e) { posts.push({ _raw: init.body }); } }
    if (u.includes('pageData')) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: { requests, config: { approval_threshold: 3000 }, houses: [], findings: [], inspections: [] } }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  };
  const windowObj = { fetch: fetchMock, __ROLE__: role, __EXEC_URL__: '/api/exec', __STAFF_TOKEN__: '1', addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); } };
  const sandbox = {
    window: windowObj, document, navigator: {}, get fetch() { return windowObj.fetch; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { pathname: '/dashboard', reload() {}, replace() {} },
    Promise, JSON, Date, console, setTimeout, prompt: (q) => (promptAnswers && promptAnswers(q)) || '', confirm: () => true,
  };
  vm.createContext(sandbox);
  for (const s of PAGE_SCRIPTS) vm.runInContext(s, sandbox);
  (domL.DOMContentLoaded || []).forEach((fn) => fn({}));
  return { ids, calls, posts, sandbox, board: getEl('board'), msg: getEl('msg'), attention: getEl('attention') };
}
let promptAnswers = null; // per-test prompt() stub: (question) => answer
const flush = async (n = 16) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test('no error banner on dashboard load (the only load-time call is the pageData GET)', async () => {
  const ctx = renderDashboard('field_ops', [req('R-LOW', 500), req('R-HIGH', 9000)]);
  await flush();
  assert.ok(ctx.calls.some((u) => u.includes('pageData')), 'the dashboard loaded via pageData');
  assert.ok(!ctx.calls.some((u) => /\/api\/(action|exec)$/.test(u)), 'no write action was posted on load');
  assert.equal(ctx.msg.textContent, '', 'the #msg error banner is empty after a clean load');
  assert.ok(!/\berr\b/.test(ctx.msg.className), 'no error styling on the banner');
});

test('field_ops: EVERY non-emergency request shows a DISABLED "ממתין לאישור אולגה" — small and large alike (no field_ops tier)', async () => {
  const ctx = renderDashboard('field_ops', [req('R-LOW', 500), req('R-HIGH', 9000), { ...req('R-E', 9000), urgency: 'חירום' }]);
  await flush();
  const html = ctx.board.innerHTML;
  assert.ok(/ממתין לאישור אולגה/.test(html), 'the pending-Olga label is shown');
  assert.ok(/disabled/.test(html), 'the label button is disabled');
  assert.ok(!/doApprove\('R-LOW'/.test(html) && !/doReject\('R-LOW'/.test(html), 'a SMALL request has NO clickable approve/reject for field_ops (tier removed)');
  assert.ok(!/doApprove\('R-HIGH'/.test(html) && !/doReject\('R-HIGH'/.test(html), 'a large request has NO clickable approve/reject for field_ops');
  assert.ok(/doApprove\('R-E'/.test(html), 'an emergency (auto) request keeps a real button for a dispatch-capable role');
});

test('ops_manager approves ANY amount; only the exec role sees the delete button; a stale ceo token gets nothing', async () => {
  const olga = renderDashboard('ops_manager', [req('R-LOW', 500), req('R-HIGH', 9000)]);
  await flush();
  const h = olga.board.innerHTML;
  assert.ok(/doApprove\('R-LOW'/.test(h) && /doApprove\('R-HIGH'/.test(h), 'ops_manager approves any amount');
  assert.ok(!/ממתין לאישור אולגה/.test(h), 'no pending-Olga label for the approver');
  assert.ok(/doDelete\('R-HIGH', this\)/.test(h), 'exec sees the delete button');

  const ceo = renderDashboard('ceo', [req('R-LOW', 500)]);
  await flush();
  assert.ok(!/doApprove\(/.test(ceo.board.innerHTML) && !/doDelete\(/.test(ceo.board.innerHTML), 'ceo is not a role any more: no approve, no delete');

  const roy = renderDashboard('field_ops', [req('R-LOW', 500)]);
  await flush();
  assert.ok(!/doDelete\(/.test(roy.board.innerHTML), 'field_ops never sees the (exec-only) delete button');
});

// ---- Single login (PR 1): no user picker, one attention panel, approver-code prompt, no user param ----

test('the dashboard has NO "משתמש" dropdown: no #who element, no who() helper (בית / אחראי filters stay)', () => {
  assert.ok(!/id="who"/.test(HTML), 'the משתמש <select> is gone');
  assert.ok(!/משתמש:/.test(HTML), 'the משתמש label is gone');
  assert.ok(!/\bwho\(\)/.test(HTML), 'no who() helper remains');
  assert.ok(/id="filterHouse"/.test(HTML) && /id="filterLead"/.test(HTML), 'the בית + אחראי filters are unchanged');
});

test('the attention panel is for the ONE account: header without a "— <name>" suffix, all items shown', async () => {
  const ctx = renderDashboard('ops_manager', [req('R-NEW', 500)]);
  await flush();
  const h = ctx.attention.innerHTML;
  assert.ok(/דורש את תשומת לבך<\/h2>/.test(h), 'the header is exactly "דורש את תשומת לבך" with no name suffix');
  assert.ok(!/— /.test(h.slice(0, h.indexOf('</h2>'))), 'no "— name" in the header');
  assert.ok(/דרישות חדשות שהתקבלו/.test(h), 'the new-requests item is shown without a per-user condition');
  assert.ok(/דרישות ממתינות לאישורך/.test(h), 'the awaiting-approval item is shown');
});

test('the single-login session (ops_manager) sees real אישור on BOTH tiers — no "ממתין לאישור אולגה"', async () => {
  const ctx = renderDashboard('ops_manager', [req('R-LOW', 500), req('R-HIGH', 9000)]);
  await flush();
  const h = ctx.board.innerHTML;
  assert.ok(/doApprove\('R-LOW'/.test(h) && /doApprove\('R-HIGH'/.test(h), 'approve on any amount');
  assert.ok(!/ממתין לאישור אולגה/.test(h));
});

test('אישור asks for the approver code and posts { id, approver_code } — NO user (by) field in the payload', async () => {
  promptAnswers = (q) => (/קוד מאשר/.test(q) ? 'olga-77' : '');
  try {
    const ctx = renderDashboard('ops_manager', [req('R-LOW', 500)]);
    await flush();
    ctx.sandbox.window.doApprove('R-LOW', null);
    await flush();
    const post = ctx.posts.find((p) => p.action === 'approve');
    assert.ok(post, 'an approve was posted');
    assert.deepEqual(post.payload, { approver_code: 'olga-77', id: 'R-LOW' }, 'the payload carries the code and the id only');
    assert.ok(!('by' in post.payload), 'no user parameter is sent');
  } finally { promptAnswers = null; }
});

test('an EMPTY approver code cancels the approval (nothing posted); an emergency request never prompts', async () => {
  const asked = [];
  promptAnswers = (q) => { asked.push(q); return ''; };
  try {
    const emergency = { ...req('R-E', 9000), urgency: 'חירום' };
    const ctx = renderDashboard('ops_manager', [req('R-LOW', 500), emergency]);
    await flush();
    ctx.sandbox.window.doApprove('R-LOW', null);
    await flush();
    assert.equal(ctx.posts.filter((p) => p.action === 'approve').length, 0, 'no code → no post');
    assert.ok(asked.some((q) => /קוד מאשר/.test(q)), 'the code was asked for the normal request');
    asked.length = 0;
    ctx.sandbox.window.doApprove('R-E', null);
    await flush();
    assert.equal(asked.length, 0, 'an emergency (auto) request never prompts for the code');
    const post = ctx.posts.find((p) => p.action === 'approve');
    assert.ok(post && post.payload.id === 'R-E' && !('approver_code' in post.payload), 'the emergency approve is posted code-less');
  } finally { promptAnswers = null; }
});
