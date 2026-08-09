// test/dashboard-filter-once.test.js — regression guard (#75-era, reasserted after the archive/view-toggle
// work): the house filter dropdown is populated EXACTLY ONCE. load() re-runs on every write (post → load)
// and the board re-renders on every view switch; neither may re-append the house options (the bug showed
// every house TWICE). Drives the REAL dashboard.html scripts in a DOM sandbox and counts the options.
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

const HOUSES = [{ name: 'רמות השבים' }, { name: 'רעננה אשר' }, { name: 'קיסריה עפרוני' }];

function boot() {
  const ids = {};
  const getEl = (id) => (ids[id] || (ids[id] = (() => { const e = makeEl('div'); e.id = id; return e; })()));
  const body = makeEl('body');
  const domL = {};
  const document = {
    get body() { return body; }, createElement: makeEl, getElementById: getEl,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); },
  };
  const fetchMock = (input) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (u.includes('pageData')) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: {
        requests: [], houses: HOUSES, findings: [], inspections: [], config: { approval_threshold: 3000 },
      } }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  };
  const windowObj = { fetch: fetchMock, __ROLE__: 'field_ops', __EXEC_URL__: '/api/exec', __STAFF_TOKEN__: '1', addEventListener: (ev, fn) => { (domL[ev] = domL[ev] || []).push(fn); } };
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
  return { ids, getEl, sandbox };
}
const flush = async (n = 24) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test('the house filter is populated exactly once — a reload does not duplicate options', async () => {
  const ctx = boot();
  await flush();
  const filter = ctx.getEl('filterHouse');
  assert.equal(filter.children.length, HOUSES.length, 'one option per house on the first load');

  // A write triggers post() → load() again; the filter must NOT grow.
  await ctx.sandbox.load();
  await flush();
  assert.equal(filter.children.length, HOUSES.length, 'reload must not re-append the house options');

  // A third reload for good measure — still stable.
  await ctx.sandbox.load();
  await flush();
  assert.equal(filter.children.length, HOUSES.length, 'the filter stays stable across repeated reloads');
});

test('switching to the archive view and back does not touch the house filter', async () => {
  const ctx = boot();
  await flush();
  const filter = ctx.getEl('filterHouse');
  const before = filter.children.length;
  assert.equal(before, HOUSES.length);

  ctx.getEl('tabArchive').click(); // view = 'archive' → render(), no re-fetch
  await flush();
  assert.equal(filter.children.length, before, 'archive view switch must not repopulate the filter');

  ctx.getEl('tabBoard').click(); // back to the board
  await flush();
  assert.equal(filter.children.length, before, 'board view switch must not repopulate the filter');
});
