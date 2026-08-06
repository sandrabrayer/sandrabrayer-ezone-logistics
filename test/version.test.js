// test/version.test.js — version truth (deploy provenance) across both legs.
//
// Node leg: GET /version returns { node:{commit,builtAt}, appsScript:{commit} }; the service worker's
// cache name is stamped with the running commit (so every deploy self-invalidates); the injected shim
// renders a version footer that reads /version. Apps Script leg: doGet('version') returns DEPLOY_COMMIT
// (the SHA the Deploy workflow stamps in at deploy time).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SECRET = 'k'.repeat(40);
const NODE_SHA = 'abc1234deadbeefcafe';
const GS_SHA = 'feed5678babe';

// Fake Apps Script upstream. action=version → { commit }; asUnreachable simulates no-data (older deploy
// without the version action, or an unreachable /exec → fetchAppsScriptData returns null).
let asUnreachable = false;
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (u.searchParams.get('action') === 'version') {
    return res.end(JSON.stringify(asUnreachable ? { ok: false, error: 'Unknown or missing action' } : { ok: true, data: { commit: GS_SHA } }));
  }
  res.end(JSON.stringify({ ok: true, data: [] }));
});

let mod, gateway, base;

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.APPS_SCRIPT_EXEC_URL = `http://127.0.0.1:${upstream.address().port}/exec`;
  process.env.SESSION_SECRET = SECRET;
  process.env.SHARED_ACCESS_CODE = '2026';
  process.env.SESSION_DAYS = '7';
  process.env.RAILWAY_GIT_COMMIT_SHA = NODE_SHA; // read at module load → COMMIT
  mod = await import('../src/server.js');
  gateway = http.createServer(mod.requestHandler);
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => upstream.close(r));
});

beforeEach(() => { asUnreachable = false; mod._resetVersionCache(); });

// ---- Node /version ----

test('GET /version returns the Node commit + builtAt AND the live Apps Script commit', async () => {
  const r = await fetch(`${base}/version`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store', 'version must never be cached by the browser');
  const j = await r.json();
  assert.equal(j.node.commit, NODE_SHA, 'node commit comes from RAILWAY_GIT_COMMIT_SHA');
  assert.match(String(j.node.builtAt), /^\d{4}-\d\d-\d\dT/, 'builtAt is an ISO timestamp');
  assert.equal(j.appsScript.commit, GS_SHA, 'appsScript commit comes from the live action=version');
});

test('GET /version reports appsScript "unreachable" when /exec has no version (never throws)', async () => {
  asUnreachable = true;
  const j = await (await fetch(`${base}/version`)).json();
  assert.equal(j.node.commit, NODE_SHA, 'the node leg is unaffected by an unreachable Apps Script');
  assert.equal(j.appsScript.commit, 'unreachable');
});

// ---- service worker cache-name stamping ----

test('GET /sw.js stamps the running commit into the SW cache name (every deploy self-invalidates)', async () => {
  const r = await fetch(`${base}/sw.js`);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.ok(body.includes(`var CACHE = 'ezone-logistics-${NODE_SHA}';`), 'cache name must carry the running commit');
  assert.ok(!/var CACHE = 'ezone-logistics-v3';/.test(body), 'the static v3 name must be replaced');
});

// ---- shim version footer ----

test('the injected shim renders a version footer that reads /version on every page', () => {
  const shim = mod.buildClientShim(['רועי']);
  assert.match(shim, /id=.?ezone-ver/, 'footer element id present');
  assert.match(shim, /mountVersion\(\)/, 'footer mounts unconditionally (shows on the login page too)');
  assert.ok(shim.includes("origFetch('/version')"), 'footer fetches /version');
});

test('a served HTML page carries the version footer (injected shim)', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes('ezone-ver') && html.includes("origFetch('/version')"), 'the / page must include the version footer');
});

// ---- Apps Script doGet('version') ----

test("Apps Script doGet('version') returns { ok:true, data:{ commit: DEPLOY_COMMIT } }", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const CODE = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
    readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');
  const sandbox = {
    Logger: { log: () => {} },
    console,
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ _text: s, setMimeType: () => ({ _text: s }) }) },
    SpreadsheetApp: {}, CacheService: {}, PropertiesService: {}, Utilities: {}, UrlFetchApp: {},
  };
  const keys = Object.keys(sandbox);
  const factory = new Function(...keys, CODE + '\n;return { doGet: doGet, DEPLOY_COMMIT: DEPLOY_COMMIT };');
  const api = factory(...keys.map((k) => sandbox[k]));
  const out = api.doGet({ parameter: { action: 'version' } });
  const j = JSON.parse(out._text);
  assert.equal(j.ok, true);
  assert.equal(j.data.commit, api.DEPLOY_COMMIT, 'version echoes the DEPLOY_COMMIT constant');
  assert.equal(j.data.commit, 'DEV', 'the committed placeholder is DEV (CI stamps the real SHA at deploy)');
});
