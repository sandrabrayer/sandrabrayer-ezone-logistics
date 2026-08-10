// test/dashboard-approve-gate.test.js — renders the REAL dashboard.html inline scripts in a DOM sandbox
// (adapted from login-page.test.js) with a mocked pageData response, and asserts the UI half of the
// approval-threshold fix:
//   1. NO error banner on load — the dashboard's only load-time call is the pageData GET; nothing 403-able
//      fires, so #msg stays empty (the production "הפעולה נכשלה — Forbidden…" banner came from CLICKING
//      approve on an over-threshold request, which is now prevented, not from load).
//   2. field_ops sees a DISABLED "ממתין לאישור אולגה" on an over-threshold request (routed to ops_manager)
//      and a real אישור button on a ≤threshold one — no clickable-then-403.
//   3. an exec (ceo) sees a real אישור on BOTH (the gate is role-specific), and the delete button only shows
//      for execs (field_ops never sees מחיקה).
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
  const calls = [];
  const fetchMock = (input) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    calls.push(u);
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
    Promise, JSON, Date, console, setTimeout, prompt: () => '', confirm: () => true,
  };
  vm.createContext(sandbox);
  for (const s of PAGE_SCRIPTS) vm.runInContext(s, sandbox);
  (domL.DOMContentLoaded || []).forEach((fn) => fn({}));
  return { ids, calls, board: getEl('board'), msg: getEl('msg') };
}
const flush = async (n = 16) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test('no error banner on dashboard load (the only load-time call is the pageData GET)', async () => {
  const ctx = renderDashboard('field_ops', [req('R-LOW', 500), req('R-HIGH', 9000)]);
  await flush();
  assert.ok(ctx.calls.some((u) => u.includes('pageData')), 'the dashboard loaded via pageData');
  assert.ok(!ctx.calls.some((u) => /\/api\/(action|exec)$/.test(u)), 'no write action was posted on load');
  assert.equal(ctx.msg.textContent, '', 'the #msg error banner is empty after a clean load');
  assert.ok(!/\berr\b/.test(ctx.msg.className), 'no error styling on the banner');
});

test('field_ops: over-threshold request shows a DISABLED "ממתין לאישור אולגה"; ≤threshold shows real אישור', async () => {
  const ctx = renderDashboard('field_ops', [req('R-LOW', 500), req('R-HIGH', 9000)]);
  await flush();
  const html = ctx.board.innerHTML;
  assert.ok(/ממתין לאישור אולגה/.test(html), 'over-threshold shows the pending-Olga label');
  assert.ok(/disabled[^>]*ממתין לאישור אולגה|ממתין לאישור אולגה/.test(html) && /disabled/.test(html), 'the label button is disabled');
  assert.ok(/doApprove\('R-LOW'/.test(html), 'the ≤threshold request keeps a real אישור button');
  assert.ok(!/doApprove\('R-HIGH'/.test(html), 'the over-threshold request has NO clickable approve');
  assert.ok(!/doApprove\('R-HIGH'|doReject\('R-HIGH'/.test(html), 'no approve/reject 403-bait for the over-threshold request');
});

test('exec (ceo) may approve BOTH tiers, and only execs see the delete button', async () => {
  const ceo = renderDashboard('ceo', [req('R-LOW', 500), req('R-HIGH', 9000)]);
  await flush();
  const h = ceo.board.innerHTML;
  assert.ok(/doApprove\('R-LOW'/.test(h) && /doApprove\('R-HIGH'/.test(h), 'ceo approves any amount');
  assert.ok(!/ממתין לאישור אולגה/.test(h), 'no pending-Olga label for an exec');
  assert.ok(/doDelete\('R-HIGH', this\)/.test(h), 'exec sees the delete button');

  const roy = renderDashboard('field_ops', [req('R-LOW', 500)]);
  await flush();
  assert.ok(!/doDelete\(/.test(roy.board.innerHTML), 'field_ops never sees the (exec-only) delete button');
});
