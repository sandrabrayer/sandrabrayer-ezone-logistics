// test/mirror-drift.test.js — the guard that the pure logic in src/roles.js + src/approval.js is
// mirrored VERBATIM (logic-for-logic) inside apps-script/Code.gs. Drift between the Node modules and
// the Apps Script copy has caused bugs before; this test fails loudly the moment they diverge.
//
// Each mirrored region is fenced by matching markers in BOTH files:
//   // === MIRROR:<name> START ===  ...  // === MIRROR:<name> END ===
// We extract the fenced text from each side, strip comments + collapse whitespace (so comment and
// formatting differences are allowed, but any change to the actual code fails), and assert equality.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function readBlock(file, name) {
  const src = readFileSync(join(root, file), 'utf8');
  const start = `// === MIRROR:${name} START ===`;
  const end = `// === MIRROR:${name} END ===`;
  const i = src.indexOf(start);
  const j = src.indexOf(end);
  assert.ok(i !== -1, `missing "${start}" in ${file}`);
  assert.ok(j !== -1 && j > i, `missing "${end}" in ${file}`);
  return src.slice(i + start.length, j);
}

// Strip line + block comments, drop a leading `export ` keyword, and collapse all whitespace so the
// comparison is on code/logic only.
function normalize(block) {
  return block
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/\/\/[^\n]*/g, ' ')         // line comments
    .replace(/\bexport\s+/g, ' ')        // ESM export keyword (Code.gs has none)
    .replace(/\s+/g, ' ')                // collapse whitespace
    .trim();
}

test('roles.js MIRROR:roles matches apps-script/Code.gs', () => {
  const a = normalize(readBlock('src/roles.js', 'roles'));
  const b = normalize(readBlock('apps-script/Code.gs', 'roles'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test('approval.js MIRROR:approval matches apps-script/Code.gs', () => {
  const a = normalize(readBlock('src/approval.js', 'approval'));
  const b = normalize(readBlock('apps-script/Code.gs', 'approval'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test('sla.js MIRROR:sla matches apps-script/Code.gs (increment 36)', () => {
  const a = normalize(readBlock('src/sla.js', 'sla'));
  const b = normalize(readBlock('apps-script/Code.gs', 'sla'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test('digest-consume.js MIRROR:digestconsume matches apps-script/Code.gs (kitchen digest read)', () => {
  const a = normalize(readBlock('src/digest-consume.js', 'digestconsume'));
  const b = normalize(readBlock('apps-script/Code.gs', 'digestconsume'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test('access.js MIRROR:access matches apps-script/Code.gs (role-based write-action gate)', () => {
  const a = normalize(readBlock('src/access.js', 'access'));
  const b = normalize(readBlock('apps-script/Code.gs', 'access'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test('training-digest.js MIRROR:trainingdigest matches apps-script/Code.gs (coordinators training digest read)', () => {
  const a = normalize(readBlock('src/training-digest.js', 'trainingdigest'));
  const b = normalize(readBlock('apps-script/Code.gs', 'trainingdigest'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test('budget.js MIRROR:budget matches apps-script/Code.gs (budget adherence)', () => {
  const a = normalize(readBlock('src/budget.js', 'budget'));
  const b = normalize(readBlock('apps-script/Code.gs', 'budget'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test('maintenance.js MIRROR:maintenance matches apps-script/Code.gs (preventive maintenance)', () => {
  const a = normalize(readBlock('src/maintenance.js', 'maintenance'));
  const b = normalize(readBlock('apps-script/Code.gs', 'maintenance'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test('compliance.js MIRROR:compliance matches apps-script/Code.gs (compliance tracker)', () => {
  const a = normalize(readBlock('src/compliance.js', 'compliance'));
  const b = normalize(readBlock('apps-script/Code.gs', 'compliance'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test('events.js MIRROR:events matches apps-script/Code.gs (exceptional-events register)', () => {
  const a = normalize(readBlock('src/events.js', 'events'));
  const b = normalize(readBlock('apps-script/Code.gs', 'events'));
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

// ---- schema.js (Node) ⇄ apps-script/setup.gs seeds must not drift (extended inc. 33 for units/par) ----
// setup.gs is Apps Script, not a module — its top-level `var` declarations are plain data, so we
// evaluate the file in a sandbox and pull the seeds out. Function bodies (which reference Apps Script
// globals) are only PARSED here, never run, so no Apps Script stubs are needed.
import { HEADERS as SCHEMA_HEADERS, SEED_HOUSES, SEED_USERS, SEED_INVENTORY_ITEMS, SEED_CONFIG } from '../src/schema.js';

function loadSetupGs() {
  const src = readFileSync(join(root, 'apps-script/setup.gs'), 'utf8');
  // eslint-disable-next-line no-new-func
  const fn = new Function(src + '\n;return { HEADERS: HEADERS, SEED_HOUSES: SEED_HOUSES, SEED_USERS: SEED_USERS, SEED_INVENTORY_ITEMS: SEED_INVENTORY_ITEMS, SEED_CONFIG: SEED_CONFIG };');
  return fn();
}

const norm = (v) => (v === undefined || v === null || v === '') ? '' : String(v);

test('InventoryItems / InventoryCounts headers match between schema.js and setup.gs', () => {
  const gs = loadSetupGs();
  assert.deepEqual(gs.HEADERS.InventoryItems, SCHEMA_HEADERS.InventoryItems);
  assert.deepEqual(gs.HEADERS.InventoryCounts, SCHEMA_HEADERS.InventoryCounts);
  // The increment-33 columns are present on both sides.
  for (const c of ['base_unit', 'allowed_units', 'par_base']) assert.ok(gs.HEADERS.InventoryItems.includes(c));
  for (const c of ['unit_label', 'unit_factor', 'quantity_base']) assert.ok(gs.HEADERS.InventoryCounts.includes(c));
});

test('SEED_INVENTORY_ITEMS mirror: category/item/active AND base_unit/allowed_units/par_base', () => {
  const gs = loadSetupGs();
  const fromSchema = SEED_INVENTORY_ITEMS.map((o) =>
    [o.category, o.item_text, o.active, norm(o.base_unit), norm(o.allowed_units), norm(o.par_base)]);
  const fromGs = gs.SEED_INVENTORY_ITEMS.map((a) =>
    [a[0], a[1], a[2], norm(a[3]), norm(a[4]), norm(a[5])]);
  assert.deepEqual(fromGs, fromSchema);
});

test('SEED_HOUSES and SEED_USERS house names mirror between schema.js and setup.gs', () => {
  const gs = loadSetupGs();
  assert.deepEqual(
    gs.SEED_HOUSES.map((a) => [a[0], a[1], a[2], a[3]]),
    SEED_HOUSES.map((o) => [o.name, o.technician, o.cluster, o.status]));
  assert.deepEqual(
    gs.SEED_USERS.map((a) => [a[0], a[1], a[2]]),
    SEED_USERS.map((o) => [o.name, o.role, o.house]));
});

test('Budgets headers mirror between schema.js and setup.gs (budget module)', () => {
  const gs = loadSetupGs();
  assert.deepEqual(gs.HEADERS.Budgets, SCHEMA_HEADERS.Budgets);
  assert.deepEqual(SCHEMA_HEADERS.Budgets, ['house', 'period', 'amount', 'notes']);
});

test('Requests headers and Config seed mirror between schema.js and setup.gs (increment 36)', () => {
  const gs = loadSetupGs();
  assert.deepEqual(gs.HEADERS.Requests, SCHEMA_HEADERS.Requests);
  for (const c of ['due_at', 'blocked', 'blocked_reason', 'blocked_at']) {
    assert.ok(gs.HEADERS.Requests.includes(c), `Requests missing ${c}`);
  }
  assert.deepEqual(
    gs.SEED_CONFIG.map((a) => [a[0], a[1]]),
    SEED_CONFIG.map((o) => [o.key, o.value]));
  assert.ok(SEED_CONFIG.some((o) => o.key === 'sla_days'));
});

test('MaintenancePlan header + Requests plan_id mirror between schema.js and setup.gs (preventive maintenance)', () => {
  const gs = loadSetupGs();
  assert.deepEqual(gs.HEADERS.MaintenancePlan, SCHEMA_HEADERS.MaintenancePlan);
  assert.deepEqual(SCHEMA_HEADERS.MaintenancePlan,
    ['id', 'house', 'task', 'frequency_months', 'last_done', 'active', 'notes']);
  // plan_id is appended to Requests on BOTH sides (second-to-last, just before compliance_id).
  assert.ok(gs.HEADERS.Requests.includes('plan_id'), 'setup.gs Requests missing plan_id');
});

test('Compliance header + Requests compliance_id + config mirror between schema.js and setup.gs (compliance tracker)', () => {
  const gs = loadSetupGs();
  assert.deepEqual(gs.HEADERS.Compliance, SCHEMA_HEADERS.Compliance);
  assert.deepEqual(SCHEMA_HEADERS.Compliance,
    ['id', 'house', 'item', 'expires_at', 'reminder_days', 'doc_url', 'notes', 'active']);
  // compliance_id is appended to Requests on BOTH sides (now second-to-last, just before rejected_at).
  assert.ok(gs.HEADERS.Requests.includes('compliance_id'), 'setup.gs Requests missing compliance_id');
  assert.equal(gs.HEADERS.Requests[gs.HEADERS.Requests.length - 2], 'compliance_id');
  assert.equal(SCHEMA_HEADERS.Requests[SCHEMA_HEADERS.Requests.length - 2], 'compliance_id');
  // compliance_reminder_days is seeded on both sides (the SEED_CONFIG deep-equal below also covers it).
  assert.ok(gs.SEED_CONFIG.some((a) => a[0] === 'compliance_reminder_days'));
  assert.ok(SEED_CONFIG.some((o) => o.key === 'compliance_reminder_days'));
});

test('Requests rejected_at mirrors between schema.js and setup.gs, appended last (rejection retention)', () => {
  const gs = loadSetupGs();
  // rejected_at is appended to Requests on BOTH sides, at the very end (append-only, never reordered).
  assert.ok(gs.HEADERS.Requests.includes('rejected_at'), 'setup.gs Requests missing rejected_at');
  assert.equal(gs.HEADERS.Requests[gs.HEADERS.Requests.length - 1], 'rejected_at');
  assert.equal(SCHEMA_HEADERS.Requests[SCHEMA_HEADERS.Requests.length - 1], 'rejected_at');
});

test('Events header + event_types config mirror between schema.js and setup.gs (exceptional-events register)', () => {
  const gs = loadSetupGs();
  assert.deepEqual(gs.HEADERS.Events, SCHEMA_HEADERS.Events);
  assert.deepEqual(SCHEMA_HEADERS.Events, [
    'id', 'created_at', 'created_by', 'house', 'occurred_at', 'event_type', 'severity',
    'description', 'immediate_action', 'root_cause', 'lessons', 'corrective_request_id',
    'status', 'closed_at', 'notes',
  ]);
  assert.ok(gs.SEED_CONFIG.some((a) => a[0] === 'event_types'));
  assert.ok(SEED_CONFIG.some((o) => o.key === 'event_types'));
});
