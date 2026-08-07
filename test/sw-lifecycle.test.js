// test/sw-lifecycle.test.js — the service-worker LIFECYCLE that heals wedged clients after a deploy.
// Evaluates the REAL sw.js in a sandbox that captures the install/activate handlers + fakes caches/self,
// and boots the Node server to assert /sw.js is served un-cacheable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SW_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'public', 'sw.js');

// Load sw.js with fakes; returns the captured handlers + a state recorder. openRejects simulates a failed
// shell precache (caches.open throws) to prove install still activates the worker.
function loadSW(opts) {
  const o = opts || {};
  const handlers = {};
  const state = { skipWaiting: 0, claim: 0, deleted: [], put: [] };
  const cacheObj = {
    addAll: () => Promise.reject(new Error('addAll must not gate activation')),
    put: (k) => { state.put.push(String(k)); return Promise.resolve(); },
    match: () => Promise.resolve(null),
  };
  const existing = ['ezone-logistics-v3', 'ezone-logistics-oldsha1234', 'ezone-logistics-v2', 'other-app-cache'];
  const caches = {
    open: () => (o.openRejects ? Promise.reject(new Error('open failed')) : Promise.resolve(cacheObj)),
    keys: () => Promise.resolve(existing.slice()),
    delete: (k) => { state.deleted.push(k); return Promise.resolve(true); },
    match: () => Promise.resolve(null),
  };
  const self = {
    addEventListener: (ev, fn) => { handlers[ev] = fn; },
    skipWaiting: () => { state.skipWaiting++; return Promise.resolve(); },
    clients: { claim: () => { state.claim++; return Promise.resolve(); } },
    location: { origin: 'https://app.example' },
  };
  // fetch used by the best-effort precache; ok:false → nothing cached, but must not throw.
  const sandbox = { self, caches, fetch: () => (o.fetchRejects ? Promise.reject(new Error('net')) : Promise.resolve({ ok: false })), URL, Promise, console };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SW_PATH, 'utf8'), sandbox);
  return { handlers, state, CACHE: sandbox.CACHE };
}

test('install calls skipWaiting UNCONDITIONALLY — a failed shell precache cannot block activation', async () => {
  const { handlers, state } = loadSW({ openRejects: true }); // precache will fail
  assert.ok(handlers.install, 'install handler registered');
  const waited = [];
  handlers.install({ waitUntil: (p) => waited.push(p) });
  assert.equal(state.skipWaiting, 1, 'skipWaiting is called immediately, before/independent of the precache');
  // The precache promise must resolve (be swallowed), never reject — else install fails and the OLD SW stays.
  await Promise.all(waited); // throws if any rejected
});

test('install skipWaiting still fires when even fetch rejects (best-effort precache never throws)', async () => {
  const { handlers, state } = loadSW({ fetchRejects: true });
  const waited = [];
  handlers.install({ waitUntil: (p) => waited.push(p) });
  assert.equal(state.skipWaiting, 1);
  await Promise.all(waited);
});

test('activate deletes EVERY non-current cache and claims all clients (existing tabs heal)', async () => {
  const { handlers, state, CACHE } = loadSW();
  assert.equal(CACHE, 'ezone-logistics-v3', 'the file default cache name (server rewrites it per-commit live)');
  let waited;
  handlers.activate({ waitUntil: (p) => { waited = p; } });
  await waited;
  assert.ok(state.deleted.includes('ezone-logistics-oldsha1234'), 'an old commit-stamped cache is purged');
  assert.ok(state.deleted.includes('ezone-logistics-v2'), 'the legacy v2 cache is purged');
  assert.ok(state.deleted.includes('other-app-cache'), 'any non-current cache is purged');
  assert.ok(!state.deleted.includes(CACHE), 'the CURRENT cache is kept');
  assert.equal(state.claim, 1, 'clients.claim() is called so the new worker controls open tabs immediately');
});

// ---- /sw.js is served un-cacheable so the browser always re-checks the worker ----

let gateway, base;
before(async () => {
  process.env.SESSION_SECRET = 'k'.repeat(40);
  process.env.SHARED_ACCESS_CODE = '2026';
  process.env.SESSION_DAYS = '7';
  process.env.APPS_SCRIPT_EXEC_URL = 'http://127.0.0.1:1/exec';
  const mod = await import('../src/server.js');
  gateway = http.createServer(mod.requestHandler);
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});
after(async () => { await new Promise((r) => gateway.close(r)); });

test('GET /sw.js is served with a no-store / must-revalidate Cache-Control (never HTTP-cached)', async () => {
  const r = await fetch(`${base}/sw.js`);
  assert.equal(r.status, 200);
  const cc = (r.headers.get('cache-control') || '').toLowerCase();
  assert.ok(cc.includes('no-store') || cc.includes('no-cache'), `sw.js must not be cacheable (got "${cc}")`);
  assert.ok(cc.includes('must-revalidate'), `sw.js should force revalidation (got "${cc}")`);
  const body = await r.text();
  assert.ok(/var CACHE = 'ezone-logistics-[^']+';/.test(body), 'sw.js CACHE name is commit-stamped at serve time');
});
