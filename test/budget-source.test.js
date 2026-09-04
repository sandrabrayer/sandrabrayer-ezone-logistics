// test/budget-source.test.js — Olga's עמידה בתקציב screen made AUDITABLE (PR 4), on the REAL Code.gs handler
// plus static guards on the page / help / schema.
//
//   Code.gs (managementData → readBudgetAdherence_) in a sandbox:
//     - `budget.source` = { spreadsheet: <TITLE>, tabs: ['Budgets','Requests'], generatedAt: <ISO>, timezone }
//       and the WHOLE managementData JSON never contains the spreadsheet id (contract guard);
//     - `budget.period` defaults to the CURRENT month in Asia/Jerusalem (not UTC);
//     - `budget.periods` lists ONLY months with a mapped Budgets row or spend (the selector contents);
//     - `budget.adherence` carries the server rows incl. a no-budget house, usedEstimated, skipped, and the
//       unmapped-house warning lists — computed by the same rule the src mirror is tested with.
//   Static guards:
//     - Code.gs currentPeriod_ goes through periodInJerusalem; readBudgetAdherence_ never calls getId();
//     - management.html has NO client-side spend recomputation, renders the server rows, shows the
//       "מקור הנתונים" line + ⓘ tooltip + a רענן button that reloads with ?fresh=1, the "כולל אומדנים"
//       marker, "לא הוגדר תקציב", and the warning line;
//     - the help page documents how Olga fills the Budgets tab (canonical id, YYYY-MM);
//     - HEADERS.Budgets = house | period | amount | notes on BOTH schema.js and setup.gs (setupSheet ensures them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HEADERS } from '../src/schema.js';
import { periodInJerusalem } from '../src/budget.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE_GS = readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');
const GS = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' + CODE_GS;
const SETUP_GS = readFileSync(join(root, 'apps-script/setup.gs'), 'utf8');
const MGMT_HTML = readFileSync(join(root, 'src/management.html'), 'utf8');
const HELP_HTML = readFileSync(join(root, 'src/help.html'), 'utf8');

const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789SECRET';
const SHEET_TITLE = 'EZone Logistics — לוגיסטיקה';

function sheetOf(rows2d) { return { getDataRange: () => ({ getValues: () => rows2d.map((r) => r.slice()) }) }; }

function deploy({ budgets, requests } = {}) {
  const sheets = {
    Config: sheetOf([['key', 'value'], ['approval_threshold', '3000']]),
    Houses: sheetOf([['name', 'status'], ['רמות השבים', 'open'], ['רעננה אשר', 'open']]),
    Requests: sheetOf([['id', 'house', 'status', 'created_at', 'completed_at', 'actual_cost', 'estimated_cost']].concat(requests || [])),
    Budgets: sheetOf([['house', 'period', 'amount', 'notes']].concat(budgets || [])),
    MaintenancePlan: sheetOf([['id', 'house', 'task', 'frequency_months', 'last_done', 'active', 'notes']]),
    OpeningChecklist: sheetOf([['id', 'house', 'item', 'done', 'date', 'by']]),
    EmergencyReadiness: sheetOf([['id', 'house', 'item', 'done', 'date', 'by']]),
    PreventiveDaily: sheetOf([['house', 'date', 'item', 'done', 'by']]),
    Trainings: sheetOf([['id', 'topic', 'house', 'date', 'attended', 'by']]),
  };
  const captured = { out: null, logs: [] };
  const sandbox = {
    Logger: { log: (m) => captured.logs.push(String(m)) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => { captured.out = s; return { setMimeType: () => ({ _text: s }) }; } },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null, getName: () => SHEET_TITLE, getId: () => SHEET_ID, getUrl: () => `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Utilities: { formatDate: () => '' },
    console,
  };
  const keys = Object.keys(sandbox);
  const factory = new Function(...keys, GS + '\n;return { handleManagementData_, currentPeriod_, readBudgetAdherence_ };');
  const api = factory(...keys.map((k) => sandbox[k]));
  const mgmt = (period) => { api.handleManagementData_(period ? { period } : {}, { name: 'רועי', role: 'ops_manager' }); return { raw: captured.out, json: JSON.parse(captured.out) }; };
  return { api, mgmt, captured };
}

const BUDGETS = [
  ['ramot-hashavim', '2026-08', '1000', ''],
  ['raanana-asher', '2026-07', '2000', ''],
  ['typo-house', '2026-08', '500', ''],          // unmapped id → warning
  ['ramot-hashavim', '2026/06', '1', ''],        // malformed → skipped
];
const REQUESTS = [
  ['R1', 'רמות השבים', 'הושלם', '2026-07-20T08:00:00.000Z', '2026-08-02T08:00:00.000Z', 300, 250],  // Aug spend, actual
  ['R2', 'רעננה אשר', 'בביצוע', '2026-08-10T08:00:00.000Z', '', '', 400],                          // Aug spend, estimated, NO Aug budget
  ['R3', 'רעננה אשר', 'לא מאושר', '2026-08-11T08:00:00.000Z', '', '', 9000],                       // rejected
  ['R4', 'בית לא מוכר', 'דרישה', '2026-08-12T08:00:00.000Z', '', '', 10],                          // unmapped request house
];

test('Code.gs: budget.source names the spreadsheet TITLE + the two tabs + generatedAt (ISO) + the time zone', () => {
  const { json } = deploy({ budgets: BUDGETS, requests: REQUESTS }).mgmt('2026-08');
  assert.equal(json.ok, true);
  const src = json.data.budget.source;
  assert.equal(src.spreadsheet, SHEET_TITLE);
  assert.deepEqual(src.tabs, ['Budgets', 'Requests']);
  assert.match(src.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.now() - new Date(src.generatedAt).getTime()) < 5000, 'generatedAt is now');
  assert.equal(src.timezone, 'Asia/Jerusalem');
});

test('CONTRACT GUARD: the managementData payload never contains the spreadsheet id (or its URL)', () => {
  const { raw } = deploy({ budgets: BUDGETS, requests: REQUESTS }).mgmt('2026-08');
  assert.ok(!raw.includes(SHEET_ID), 'sheet id must never leave the server');
  assert.ok(!raw.includes('docs.google.com'), 'no spreadsheet URL either');
  const fn = CODE_GS.slice(CODE_GS.indexOf('function readBudgetAdherence_('), CODE_GS.indexOf('function handleManagementData_('));
  assert.ok(!/getId\(|getUrl\(/.test(fn), 'readBudgetAdherence_ never reads the id / url');
  assert.match(fn, /getName\(\)/, 'it reads the title');
});

test('Code.gs: the default period is the CURRENT month in Asia/Jerusalem (currentPeriod_ goes through periodInJerusalem)', () => {
  const { api } = deploy();
  assert.equal(api.currentPeriod_(), periodInJerusalem(new Date()));
  const fn = CODE_GS.slice(CODE_GS.indexOf('function currentPeriod_('), CODE_GS.indexOf('var BUDGET_SOURCE_TABS_'));
  assert.match(fn, /periodInJerusalem\(new Date\(\)\)/);
  assert.ok(!/getUTCMonth|getUTCFullYear/.test(fn), 'no UTC month any more');
  const { json } = deploy({ budgets: BUDGETS, requests: REQUESTS }).mgmt();
  assert.equal(json.data.budget.period, periodInJerusalem(new Date()));
});

test('Code.gs: the month selector (budget.periods) lists ONLY months with a mapped budget row or spend', () => {
  const { json } = deploy({ budgets: BUDGETS, requests: REQUESTS }).mgmt('2026-08');
  // 2026-08 (budget + spend), 2026-07 (budget only); NOT 2026/06 (malformed), NOT typo-house's month alone, NOT the current month by itself
  assert.deepEqual(json.data.budget.periods, ['2026-08', '2026-07']);
});

test('Code.gs: the server rows carry a no-budget house, the estimate marker, skipped count and both unmapped lists', () => {
  const dep = deploy({ budgets: BUDGETS, requests: REQUESTS });
  const { json } = dep.mgmt('2026-08');
  const captured = dep.captured;
  const adh = json.data.budget.adherence;
  assert.equal(adh.period, '2026-08');
  const ramot = adh.houses.find((h) => h.id === 'ramot-hashavim');
  const asher = adh.houses.find((h) => h.id === 'raanana-asher');
  assert.deepEqual({ budget: ramot.budget, actual: ramot.actual, over: ramot.over, usedEstimated: ramot.usedEstimated, budgetDefined: ramot.budgetDefined },
    { budget: 1000, actual: 300, over: false, usedEstimated: false, budgetDefined: true });
  assert.deepEqual({ actual: asher.actual, usedEstimated: asher.usedEstimated, budgetDefined: asher.budgetDefined, budget: asher.budget },
    { actual: 400, usedEstimated: true, budgetDefined: false, budget: undefined }, 'spend with no budget row: listed, "not defined", estimate-flagged');
  assert.equal(adh.usedEstimated, true);
  assert.equal(adh.skipped, 1, 'the malformed 2026/06 row');
  assert.deepEqual(adh.unmappedHouses, ['typo-house']);
  assert.deepEqual(adh.unmappedRequestHouses, ['בית לא מוכר']);
  assert.ok(captured.logs.some((l) => /typo-house/.test(l)), 'logged too');
});

// ---- static guards: the page, the help, the schema ----

test('management.html: no client-side spend recomputation; renders the server rows, "לא הוגדר תקציב" and "כולל אומדנים"', () => {
  assert.ok(!/budgetAdherenceByHouse/.test(MGMT_HTML), 'the client recomputation is gone');
  assert.ok(!/completed_at \|\| ''\)\.slice\(0, 7\)/.test(MGMT_HTML), 'no client month bucketing');
  assert.ok(!/COMPLETED\.indexOf/.test(MGMT_HTML), 'no completed-only filter');
  assert.match(MGMT_HTML, /adh\.houses/, 'server rows used as-is');
  assert.match(MGMT_HTML, /לא הוגדר תקציב/);
  assert.match(MGMT_HTML, /כולל אומדנים/);
  assert.match(MGMT_HTML, /budgetDefined === false/);
});

test('management.html: the "מקור הנדתונים" line, the ⓘ rule tooltip, and a רענן button that reloads with ?fresh=1'.replace('הנדתונים', 'הנתונים'), () => {
  assert.match(MGMT_HTML, /מקור הנתונים: נקרא מגיליון/);
  assert.match(MGMT_HTML, /לשוניות \$\{esc\(tabs\)\}/);
  assert.match(MGMT_HTML, /עודכן/);
  assert.match(MGMT_HTML, /class="info" title="\$\{esc\(RULE\)\}"/, 'the tooltip carries the one-sentence rule');
  assert.match(MGMT_HTML, /const RULE = 'ההוצאה לחודש = כל הדרישות שלא נדחו/);
  assert.match(MGMT_HTML, /onclick="refreshBudget\(\)">רענן</);
  assert.match(MGMT_HTML, /window\.refreshBudget = \(\) => load\(_period, true\)/);
  assert.match(MGMT_HTML, /EXEC_URL \+ \(fresh \? '\?fresh=1' : ''\)/);
  assert.match(MGMT_HTML, /timeZone: 'Asia\/Jerusalem'/, 'the client formats the update time in Israel time');
  assert.ok(!/src\.id|source\.id|spreadsheetId/.test(MGMT_HTML), 'the page never expects an id');
});

test('management.html: the warning line surfaces skipped rows and both unmapped lists; the selector keeps a data-less selected month visible', () => {
  assert.match(MGMT_HTML, /id="budget-warnings"/);
  assert.match(MGMT_HTML, /שורות תקציב לא תקינות/);
  assert.match(MGMT_HTML, /מזהי בית לא מוכרים בלשונית Budgets/);
  assert.match(MGMT_HTML, /דרישות עם שם בית לא מוכר/);
  assert.match(MGMT_HTML, /\(אין נתונים\)/);
});

test('help page: documents how Olga fills the Budgets tab (canonical house id, YYYY-MM, amount) and the spend rule', () => {
  assert.match(HELP_HTML, /id="budget"/);
  assert.match(HELP_HTML, /תקציב חודשי/);
  for (const id of ['ramot-hashavim', 'raanana-asher', 'pardes', 'caesarea-ofroni', 'caesarea-rehab', 'sde-eliezer']) assert.ok(HELP_HTML.includes(id), `help lists ${id}`);
  assert.match(HELP_HTML, /YYYY-MM/);
  assert.match(HELP_HTML, /בשעון ישראל/);
  assert.match(HELP_HTML, /לא הוגדר תקציב/);
});

test('Budgets headers house | period | amount | notes on BOTH schema.js and setup.gs; setupSheet writes / appends them', () => {
  assert.deepEqual(HEADERS.Budgets, ['house', 'period', 'amount', 'notes']);
  const gs = new Function(SETUP_GS + '\n;return { HEADERS: HEADERS };')();
  assert.deepEqual(gs.HEADERS.Budgets, ['house', 'period', 'amount', 'notes']);
  const body = SETUP_GS.slice(SETUP_GS.indexOf('function setupSheet('), SETUP_GS.indexOf('function seedIfEmpty_('));
  assert.match(body, /Object\.keys\(HEADERS\)\.forEach/, 'every HEADERS sheet (incl. Budgets) is ensured');
  assert.match(body, /existing\.indexOf\(h\) === -1/, 'missing columns are appended on an existing tab');
});
