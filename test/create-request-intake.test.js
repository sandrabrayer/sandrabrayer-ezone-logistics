// test/create-request-intake.test.js — the secret-gated coordinator request intake (server-to-server).
//
// The external ezone-coordinators app POSTs a finished createRequest into Logistics DIRECTLY (no
// Logistics session), authenticated by the CREATE_REQUEST_SECRET Script Property. This loads the REAL
// apps-script .gs files in a sandbox with stubbed Apps Script globals (as the runtime shares ONE global
// scope, we concatenate digest.gs + Code.gs like the runtime does) and asserts the REAL handler:
//   fail-closed  — unset secret / wrong secret → rejected with NO writes (Requests + AuditLog untouched);
//   strict input — non-canonical house, bad category, oversized description, missing created_by rejected;
//   success      — a normal-lifecycle דרישה row is appended (house id → name), an AuditLog row records the
//                  coordinator + source=coordinators, and amount-based approval routing is applied;
//   discriminator— doPost routes a createRequest WITH a secret to the intake, and one WITHOUT to the token
//                  gate (so the in-app manager path is untouched); and the manager handler still creates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HEADERS } from '../src/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' +
  readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');

// Read-only sheet (getDataRange only) — used for the stable reference sheets (Config / Houses).
function sheetOf(rows2d) { return { getDataRange: () => ({ getValues: () => rows2d.map((r) => r.slice()) }) }; }

// Mutable sheet supporting the read + append ops the write path uses (appendRequest / writeAuditEntry).
function mutableSheet(header) {
  const data = [header.slice()];
  return {
    _data: data,
    getDataRange: () => ({ getValues: () => data.map((r) => r.slice()) }),
    getLastColumn: () => header.length,
    getLastRow: () => data.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        const out = [];
        for (let i = 0; i < (nr || 1); i++) { const row = []; for (let j = 0; j < (nc || 1); j++) row.push((data[r - 1 + i] || [])[c - 1 + j]); out.push(row); }
        return out;
      },
      setValue: (v) => { data[r - 1][c - 1] = v; },
    }),
    appendRow: (row) => { data.push(row.slice()); },
    // header-keyed rows (excluding the header) — for assertions.
    rows: () => data.slice(1).map((r) => { const o = {}; header.forEach((h, i) => { o[h] = r[i]; }); return o; }),
  };
}

const okCache = () => ({ getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) });

// A fresh sandbox "deployment". `props` seeds Script Properties (CREATE_REQUEST_SECRET / SESSION_SECRET /
// DIGEST_SHEET_ID). DIGEST_SHEET_ID stays unset so rebuildDigest() is a no-op (not provisioned).
function deploy(props) {
  const requests = mutableSheet(HEADERS.Requests);
  const audit = mutableSheet(['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note']);
  const sheets = {
    Requests: requests,
    AuditLog: audit,
    Config: sheetOf([['key', 'value'], ['approval_threshold', '3000'], ['sla_days', 'חירום:1|דחוף:3|רגיל:14']]),
    Houses: sheetOf([['name', 'cluster', 'status'], ['רמות השבים', 'sharon', 'open'], ['שדה אליעזר', 'north', 'pre-opening']]),
  };
  const captured = { logs: [] };
  const scriptProps = props || {};
  const sandbox = {
    Logger: { log: (m) => captured.logs.push(String(m)) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => ({ _text: s }), _text: s }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in scriptProps ? scriptProps[k] : null) }) },
    CacheService: okCache(),
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {},
    console,
  };
  const keys = Object.keys(sandbox);
  const ret = 'return { handleCreateRequestIntake_, handleCreateRequest_, validateIntakeRequest_, canonicalHouseIdToName_, doPost };';
  const api = new Function(...keys, CODE + '\n;' + ret)(...keys.map((k) => sandbox[k]));
  return { api, requests, audit, captured };
}

// A valid intake payload (canonical house id, valid category/urgency, real description + coordinator name).
const okPayload = () => ({
  house: 'ramot-hashavim',
  category: 'תיקון',
  urgency: 'רגיל',
  description: 'ברז דולף במטבח',
  location_in_house: 'מטבח',
  estimated_cost: 250,
  created_by: 'שירה',
});
const parse = (res) => JSON.parse(res._text);
const SECRET = 's3cr3t-intake-key';

// ---- fail-closed on the secret ----

test('fail-closed: CREATE_REQUEST_SECRET UNSET → rejected, and NO row is written', () => {
  const d = deploy({}); // no CREATE_REQUEST_SECRET
  const res = parse(d.api.handleCreateRequestIntake_({ secret: 'anything', payload: okPayload() }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Unauthorized');
  assert.equal(d.requests.rows().length, 0, 'no request appended');
  assert.equal(d.audit.rows().length, 0, 'no audit row appended');
});

test('fail-closed: WRONG secret → rejected, and NO row is written', () => {
  const d = deploy({ CREATE_REQUEST_SECRET: SECRET });
  const res = parse(d.api.handleCreateRequestIntake_({ secret: SECRET + 'x', payload: okPayload() }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Unauthorized');
  assert.equal(d.requests.rows().length, 0);
  assert.equal(d.audit.rows().length, 0);
});

test('fail-closed: EMPTY provided secret never satisfies a set secret', () => {
  const d = deploy({ CREATE_REQUEST_SECRET: SECRET });
  for (const bad of [{ secret: '', payload: okPayload() }, { payload: okPayload() }]) {
    const res = parse(d.api.handleCreateRequestIntake_(bad));
    assert.equal(res.ok, false);
    assert.equal(res.error, 'Unauthorized');
  }
  assert.equal(d.requests.rows().length, 0);
});

// ---- strict validation (secret is correct; the payload is off-contract) ----

test('rejects a NON-CANONICAL house (a display name or unknown id) with no write', () => {
  const d = deploy({ CREATE_REQUEST_SECRET: SECRET });
  for (const house of ['רמות השבים', 'ramot', 'nope', '', undefined]) {
    const res = parse(d.api.handleCreateRequestIntake_({ secret: SECRET, payload: { ...okPayload(), house } }));
    assert.equal(res.ok, false, `house="${house}" must be rejected`);
    assert.match(res.error, /house/);
  }
  assert.equal(d.requests.rows().length, 0);
});

test('rejects a bad category and a bad urgency', () => {
  const d = deploy({ CREATE_REQUEST_SECRET: SECRET });
  const badCat = parse(d.api.handleCreateRequestIntake_({ secret: SECRET, payload: { ...okPayload(), category: 'משהו' } }));
  assert.equal(badCat.ok, false); assert.match(badCat.error, /category/);
  const badUrg = parse(d.api.handleCreateRequestIntake_({ secret: SECRET, payload: { ...okPayload(), urgency: 'מתישהו' } }));
  assert.equal(badUrg.ok, false); assert.match(badUrg.error, /urgency/);
  assert.equal(d.requests.rows().length, 0);
});

test('rejects a missing description and an OVERSIZED description', () => {
  const d = deploy({ CREATE_REQUEST_SECRET: SECRET });
  const missing = parse(d.api.handleCreateRequestIntake_({ secret: SECRET, payload: { ...okPayload(), description: '   ' } }));
  assert.equal(missing.ok, false); assert.match(missing.error, /description/);
  const huge = parse(d.api.handleCreateRequestIntake_({ secret: SECRET, payload: { ...okPayload(), description: 'x'.repeat(2001) } }));
  assert.equal(huge.ok, false); assert.match(huge.error, /description too long/);
  assert.equal(d.requests.rows().length, 0);
});

test('rejects a missing created_by and a non-numeric estimated_cost', () => {
  const d = deploy({ CREATE_REQUEST_SECRET: SECRET });
  const noBy = parse(d.api.handleCreateRequestIntake_({ secret: SECRET, payload: { ...okPayload(), created_by: '' } }));
  assert.equal(noBy.ok, false); assert.match(noBy.error, /created_by/);
  const badCost = parse(d.api.handleCreateRequestIntake_({ secret: SECRET, payload: { ...okPayload(), estimated_cost: 'abc' } }));
  assert.equal(badCost.ok, false); assert.match(badCost.error, /estimated_cost/);
  assert.equal(d.requests.rows().length, 0);
});

// ---- successful create + audit + routing ----

test('success: appends a normal-lifecycle דרישה row (house id → name), with the coordinator as created_by', () => {
  const d = deploy({ CREATE_REQUEST_SECRET: SECRET });
  const res = parse(d.api.handleCreateRequestIntake_({ secret: SECRET, payload: okPayload() }));
  assert.equal(res.ok, true);
  assert.match(res.id, /^REQ-/);
  const rows = d.requests.rows();
  assert.equal(rows.length, 1, 'exactly one request appended');
  const row = rows[0];
  assert.equal(row.status, 'דרישה', 'enters the normal lifecycle at status דרישה');
  assert.equal(row.house, 'רמות השבים', 'canonical id ramot-hashavim mapped to the Hebrew house name');
  assert.equal(row.created_by, 'שירה', 'created_by is the coordinator from the payload');
  assert.equal(row.category, 'תיקון');
  assert.equal(row.urgency, 'רגיל');
  assert.equal(row.estimated_cost, 250);
  assert.equal(row.blocked, 'FALSE');
  assert.equal(row.id, res.id);
});

test('success: writes an AuditLog row tagged source=coordinators, by the coordinator, to status דרישה', () => {
  const d = deploy({ CREATE_REQUEST_SECRET: SECRET });
  const res = parse(d.api.handleCreateRequestIntake_({ secret: SECRET, payload: okPayload() }));
  const audit = d.audit.rows();
  assert.equal(audit.length, 1, 'exactly one audit row');
  const a = audit[0];
  assert.equal(a.request_id, res.id);
  assert.equal(a.from_status, '');
  assert.equal(a.to_status, 'דרישה');
  assert.equal(a.by, 'שירה');
  assert.match(String(a.note), /source=coordinators/);
});

test('routing (chain B v3) is applied: any non-emergency amount → ops_manager (approval_required TRUE), emergency → auto', () => {
  // approval_required is TRUE for every request that needs a human approver — i.e. everything but חירום.
  const over = deploy({ CREATE_REQUEST_SECRET: SECRET });
  const r1 = parse(over.api.handleCreateRequestIntake_({ secret: SECRET, payload: { ...okPayload(), estimated_cost: 5000 } }));
  assert.equal(r1.ok, true);
  assert.equal(over.requests.rows()[0].approval_required, true, 'cost 5000 → ops_manager → approval_required true');

  const low = deploy({ CREATE_REQUEST_SECRET: SECRET });
  low.api.handleCreateRequestIntake_({ secret: SECRET, payload: { ...okPayload(), estimated_cost: 500 } });
  assert.equal(low.requests.rows()[0].approval_required, true, 'cost 500 → ops_manager too (no field_ops tier) → approval_required true');

  const blank = deploy({ CREATE_REQUEST_SECRET: SECRET });
  blank.api.handleCreateRequestIntake_({ secret: SECRET, payload: { ...okPayload(), estimated_cost: '' } });
  assert.equal(blank.requests.rows()[0].approval_required, true, 'blank cost → ops_manager → approval_required true');

  const emer = deploy({ CREATE_REQUEST_SECRET: SECRET });
  emer.api.handleCreateRequestIntake_({ secret: SECRET, payload: { ...okPayload(), estimated_cost: 9000, urgency: 'חירום' } });
  assert.equal(emer.requests.rows()[0].approval_required, false, 'emergency bypasses approval (auto) → approval_required false');
});

// ---- doPost discriminator + manager path intact ----

test('doPost routes a createRequest WITH a secret to the intake (creates the request)', () => {
  const d = deploy({ CREATE_REQUEST_SECRET: SECRET });
  const res = parse(d.api.doPost({ postData: { contents: JSON.stringify({ action: 'createRequest', secret: SECRET, payload: okPayload() }) } }));
  assert.equal(res.ok, true);
  assert.equal(d.requests.rows().length, 1);
});

test('doPost routes a createRequest with a WRONG secret to a fail-closed reject (no write)', () => {
  const d = deploy({ CREATE_REQUEST_SECRET: SECRET });
  const res = parse(d.api.doPost({ postData: { contents: JSON.stringify({ action: 'createRequest', secret: 'nope', payload: okPayload() }) } }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Unauthorized');
  assert.equal(d.requests.rows().length, 0);
});

test('doPost does NOT treat a secret-less createRequest as intake — it falls to the token gate (Unauthorized without a token)', () => {
  // No `secret` field + no session token → the intake branch is skipped and the token gate rejects. This
  // proves the in-app manager createRequest path (token, no secret) is untouched by the intake branch.
  const d = deploy({}); // SESSION_SECRET unset → verifyToken_ fails closed
  const res = parse(d.api.doPost({ postData: { contents: JSON.stringify({ action: 'createRequest', payload: okPayload() }) } }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Unauthorized');
  assert.equal(d.requests.rows().length, 0, 'no write on the unauthenticated token path');
});

test("managers' in-app create path is intact: handleCreateRequest_ still appends a request", () => {
  // The manager modal path stamps created_by from the session identity and files for any house.
  const d = deploy({ CREATE_REQUEST_SECRET: SECRET });
  const actor = { name: 'אולגה', role: 'ops_manager', scope: '' };
  const res = parse(d.api.handleCreateRequest_({ house: 'רמות השבים', category: 'רכישה', urgency: 'רגיל', description: 'ריהוט חדר', estimated_cost: 800 }, actor));
  assert.equal(res.ok, true);
  const rows = d.requests.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'דרישה');
  assert.equal(rows[0].created_by, 'אולגה', 'manager path stamps created_by from the token identity');
  assert.equal(rows[0].house, 'רמות השבים');
});
