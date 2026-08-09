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
import { isDigestTicket } from '../src/digest.js';

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

// ---- Behavioral drift guards: logic parity between src modules and their apps-script mirrors ----
// The MIRROR:<name> text guards above catch drift in blocks written VERBATIM on both sides. The digest
// filter and the transition table can't be verbatim-fenced — apps-script/digest.gs uses GAS idioms (var,
// isNaN, a .replace trim, Date-cell handling) and the transition table uses arrays vs Sets — so text
// comparison would false-positive on legitimate idiom differences. Instead we compare BEHAVIOR: run the
// same inputs through both copies and assert identical results. Any real logic divergence fails the build.

// digest.gs is pure data + function declarations at top level (no Apps Script calls run on load), so it
// evaluates in a sandbox exactly like setup.gs. We pull out the mirror function and exercise it.
function loadDigestGs() {
  const src = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8');
  // eslint-disable-next-line no-new-func
  const fn = new Function(src + '\n;return { digestIncludeTicket_: digestIncludeTicket_ };');
  return fn();
}

test('digest inclusion does NOT drift: src isDigestTicket ⇄ apps-script digestIncludeTicket_ (behavioral matrix)', () => {
  const { digestIncludeTicket_ } = loadDigestGs();
  const NOW = '2026-08-09T12:00:00.000Z';
  const nowMs = new Date(NOW).getTime();
  const stamp = (n) => new Date(nowMs - n * 86400000).toISOString();
  // Every status × dated/undated (rejected_at and completed_at independently) × window, over three
  // now-shapes (ISO string / ms number / Date) — the request-row data both copies actually see.
  const statuses = ['דרישה', 'ממתין לאישור', 'מאושר', 'נדחה לתאריך', 'בביצוע',
    'הושלם', 'סגור', 'לא מאושר', '', 'unknown-status'];
  const dates = ['', undefined, null, 'not-a-date', stamp(0), stamp(6), stamp(7), stamp(8), stamp(30)];
  const windows = [undefined, null, 0, -3, 'x', 7, 14, 30];
  const nows = [NOW, nowMs, new Date(NOW)];
  let checked = 0;
  for (const status of statuses) {
    for (const completed_at of dates) {
      for (const rejected_at of dates) {
        const req = { status, completed_at, rejected_at };
        for (const w of windows) {
          for (const nowArg of nows) {
            const a = isDigestTicket(req, nowArg, w);
            const b = digestIncludeTicket_(req, nowArg, w);
            assert.equal(a, b,
              `DRIFT: status=${status} completed_at=${completed_at} rejected_at=${rejected_at} w=${w} now=${typeof nowArg}`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 2000, `matrix ran (${checked} cases)`);
});

// ---- Approval status-transition edges must not drift (extends the MIRROR:approval routing guard) ----
// MIRROR:approval fences the amount-routing block only. The allowed-transition table lives outside it and
// is written with different idioms on each side (src: `new Set([S.X])`, Code.gs: `[ST.X]`), so we compare
// the resolved Hebrew edge sets rather than the text. Divergence in what transitions are legal fails here.
function statusMap(src, name) {
  const m = src.match(new RegExp('\\b' + name + '\\s*=\\s*\\{([\\s\\S]*?)\\}'));
  assert.ok(m, `no ${name} status map found`);
  const map = {};
  const re = /(\w+)\s*:\s*'([^']+)'/g;
  let x;
  while ((x = re.exec(m[1]))) map[x[1]] = x[2];
  return map;
}
function transitionEdges(src, mapName, transVar) {
  const map = statusMap(src, mapName);
  const edges = {};
  // TRANSITIONS[S.FROM] = new Set([S.A, S.B]);  OR  TRANSITIONS_[ST.FROM] = [ST.A, ST.B];
  const re = new RegExp(transVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '\\[' + mapName + '\\.(\\w+)\\]\\s*=\\s*(?:new Set\\()?\\[([^\\]]*)\\]', 'g');
  let x;
  while ((x = re.exec(src))) {
    const from = map[x[1]];
    assert.ok(from, `unmapped from-status ${x[1]}`);
    const tos = (x[2].match(new RegExp(mapName + '\\.(\\w+)', 'g')) || [])
      .map((t) => {
        const key = t.split('.')[1];
        assert.ok(map[key], `unmapped to-status ${key}`);
        return map[key];
      })
      .sort();
    edges[from] = tos;
  }
  return edges;
}

test('status-transition edges do NOT drift: src/approval.js ⇄ apps-script/Code.gs (Hebrew edge sets)', () => {
  const approval = readFileSync(join(root, 'src/approval.js'), 'utf8');
  const codeGs = readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');
  const a = transitionEdges(approval, 'S', 'TRANSITIONS');
  const b = transitionEdges(codeGs, 'ST', 'TRANSITIONS_');
  assert.ok(Object.keys(a).length >= 8, 'src transition table parsed all from-statuses');
  assert.deepEqual(a, b, 'the allowed status transitions diverge between src/approval.js and Code.gs');
  // Lock the safety-critical invariant on BOTH sides: rejected + closed are terminal (no outgoing edges).
  assert.deepEqual(a['לא מאושר'], []);
  assert.deepEqual(a['סגור'], []);
});
