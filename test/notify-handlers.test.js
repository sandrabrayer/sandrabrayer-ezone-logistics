// test/notify-handlers.test.js — e-mail notifications on the REAL Code.gs handlers (PR 5), with a MailApp stub.
//
// Locks, on the real write path:
//   - createRequest (manager modal + coordinators intake) → ONE mail to Roy + Olga, Hebrew RTL HTML
//     (dir="rtl"), subject "[לוגיסטיקה] דרישה חדשה · <house> · #<id>", body with description / house /
//     cost / status and the /dashboard?req=<id> deep link, no other request's money;
//   - an emergency request → the emergency_auto event (Roy + Olga);
//   - approve → Roy only; reject → Roy only (with the reason);
//   - DEDUPE: the NotifyLog ledger gets one row per (request, event); a second attempt sends nothing;
//   - notify_enabled = FALSE, or blank recipients → no mail, no NotifyLog row, no log line;
//   - FAIL-SAFE: MailApp throwing (quota / not authorized) → the write still succeeds and the row is written;
//     a missing NotifyLog sheet → the write still succeeds, nothing is sent;
//   - the daily scan mails the deferral wake-up to Roy once per request (second run: nothing), and leaves
//     the request untouched;
//   - HTML escaping of user text; the deep link uses notify_app_url and never a raw description.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE_GS = readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');
const GS = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8') + '\n' + CODE_GS;
const SECRET = 's'.repeat(40);
const APPROVER = 'olga-77';
const ROY = 'roy@example.org', OLGA = 'olga@example.org';
const APP_URL = 'https://ezone-logistics.up.railway.app';

function mutableSheet(header, rows) {
  const data = [header.slice()].concat((rows || []).map((r) => r.slice()));
  return {
    _data: data,
    getDataRange: () => ({ getValues: () => data.map((r) => r.slice()) }),
    getLastColumn: () => header.length,
    getLastRow: () => data.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) { const row = []; for (let j = 0; j < (nc || 1); j++) row.push((data[r - 1 + i] || [])[c - 1 + j]); out.push(row); } return out; },
      setValue: (v) => { data[r - 1][c - 1] = v; },
    }),
    appendRow: (row) => { data.push(row.slice()); },
    deleteRow: (r) => { data.splice(r - 1, 1); },
  };
}
const REQ_HEADER = ['id', 'house', 'category', 'urgency', 'estimated_cost', 'status', 'approval_required', 'approved_by', 'approved_at', 'rejection_reason', 'rejected_at', 'deferred_until', 'due_at', 'created_at', 'created_by', 'description', 'location_in_house', 'actual_cost', 'assigned_to', 'blocked', 'plan_id', 'compliance_id', 'completed_at'];
const row = (id, over) => {
  const base = { id, house: 'רמות השבים', category: 'תיקון', urgency: 'רגיל', estimated_cost: 500, status: 'דרישה', created_at: '2026-08-01T08:00:00.000Z', created_by: 'שירה', description: 'דלת <שבורה> & "רועשת"' };
  const o = Object.assign(base, over || {});
  return REQ_HEADER.map((h) => (h in o ? o[h] : ''));
};

// A sandbox deployment. cfg overrides Config rows; notifyLog=false removes the NotifyLog sheet; mailThrows
// makes MailApp.sendEmail throw.
function deploy({ cfg = {}, notifyLog = true, mailThrows = false, requests = [] } = {}) {
  const config = Object.assign({ archive_after_days: '7', sla_days: 'חירום:1|דחוף:3|רגיל:14', notify_enabled: 'TRUE', notify_email_approver: OLGA, notify_email_field_ops: ROY, notify_app_url: APP_URL, compliance_reminder_days: '30' }, cfg);
  const sheets = {
    Config: mutableSheet(['key', 'value'], Object.entries(config).map(([k, v]) => [k, v])),
    Houses: mutableSheet(['name', 'status', 'cluster'], [['רמות השבים', 'open', 'sharon']]),
    Requests: mutableSheet(REQ_HEADER, requests),
    AuditLog: mutableSheet(['request_id', 'from_status', 'to_status', 'by', 'timestamp', 'note'], []),
    MaintenancePlan: mutableSheet(['id', 'house', 'task', 'frequency_months', 'last_done', 'active', 'notes'], []),
    Compliance: mutableSheet(['id', 'house', 'item', 'expires_at', 'reminder_days', 'doc_url', 'notes', 'active'], []),
  };
  if (notifyLog) sheets.NotifyLog = mutableSheet(['request_id', 'event', 'sent_at'], []);
  const state = { mails: [], logs: [] };
  const props = { SESSION_SECRET: SECRET, APPROVER_CODE: APPROVER, CREATE_REQUEST_SECRET: 'intake-secret' };
  const captured = { out: null };
  const sandbox = {
    Logger: { log: (m) => state.logs.push(String(m)) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => { captured.out = s; return { setMimeType: () => ({ _text: s }) }; } },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null, getName: () => 'EZone Logistics' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => ({ timeBased: () => ({ after: () => ({ create: () => ({}) }), everyMinutes: () => ({ create: () => ({}) }) }) }) },
    MailApp: {
      sendEmail: (opts) => { if (mailThrows) throw new Error('Service invoked too many times for one day: email'); state.mails.push(opts); },
      getRemainingDailyQuota: () => 99,
    },
    Utilities: { formatDate: () => '', newBlob: () => ({ getBytes: () => [] }) },
    Session: { getScriptTimeZone: () => 'Asia/Jerusalem' },
    console,
  };
  const keys = Object.keys(sandbox);
  const factory = new Function(...keys, GS + '\n;return { handleCreateRequest_, handleCreateRequestIntake_, handleApprove_, handleReject_, getRequestById, notifyEvent_, runMaintenanceScan, notifyTestEmail, NOTIFY_EVENT };');
  const api = factory(...keys.map((k) => sandbox[k]));
  const call = (fn, payload, actor) => { api[fn](payload, actor); return JSON.parse(captured.out); };
  return { api, sheets, state, call, notifyRows: () => (sheets.NotifyLog ? sheets.NotifyLog._data.slice(1) : []) };
}
const OLGA_SESSION = { name: 'רועי', role: 'ops_manager', scope: '' };
const NEW = { house: 'רמות השבים', category: 'תיקון', urgency: 'רגיל', description: 'דלת <שבורה> & "רועשת"', estimated_cost: 500 };

// ---- new request ----

test('createRequest → ONE Hebrew RTL mail to Roy + Olga with subject, description, house, cost, status and the deep link', () => {
  const dep = deploy();
  const out = dep.call('handleCreateRequest_', { ...NEW }, OLGA_SESSION);
  assert.equal(out.ok, true);
  assert.equal(dep.state.mails.length, 1);
  const m = dep.state.mails[0];
  assert.equal(m.to, `${ROY},${OLGA}`);
  assert.equal(m.subject, `[לוגיסטיקה] דרישה חדשה · רמות השבים · #${out.id}`);
  assert.match(m.htmlBody, /<div dir="rtl" lang="he"/, 'RTL HTML');
  assert.match(m.htmlBody, /דלת &lt;שבורה&gt; &amp; &quot;רועשת&quot;/, 'description, HTML-escaped');
  assert.match(m.htmlBody, /רמות השבים/);
  assert.match(m.htmlBody, /₪500 \(אומדן\)/, 'the request\'s own estimate');
  assert.match(m.htmlBody, /דרישה<\/td>/, 'status');
  assert.match(m.htmlBody, new RegExp(`${APP_URL.replace(/[.]/g, '\\.')}/dashboard\\?req=${out.id}`), 'deep link to the request');
  assert.ok(!/<script/i.test(m.htmlBody), 'no raw markup');
  assert.equal(m.noReply, true);
  assert.deepEqual(dep.notifyRows().map((r) => r.slice(0, 2)), [[out.id, 'new_request']], 'one NotifyLog row');
  assert.match(dep.notifyRows()[0][2], /^\d{4}-\d{2}-\d{2}T/, 'sent_at ISO');
});

test('coordinators intake (server-to-server) raises the same new-request mail', () => {
  const dep = deploy();
  const out = dep.call('handleCreateRequestIntake_', { secret: 'intake-secret', payload: { house: 'ramot-hashavim', category: 'תיקון', urgency: 'רגיל', description: 'x', created_by: 'שירה', estimated_cost: 120 } });
  assert.equal(out.ok, true);
  assert.equal(dep.state.mails.length, 1);
  assert.equal(dep.state.mails[0].to, `${ROY},${OLGA}`);
  assert.match(dep.state.mails[0].subject, /דרישה חדשה/);
});

test('an EMERGENCY request → the emergency_auto mail to Roy + Olga (not the plain new-request one)', () => {
  const dep = deploy();
  const out = dep.call('handleCreateRequest_', { ...NEW, urgency: 'חירום', estimated_cost: 9000 }, OLGA_SESSION);
  assert.equal(dep.state.mails.length, 1);
  assert.equal(dep.state.mails[0].to, `${ROY},${OLGA}`);
  assert.equal(dep.state.mails[0].subject, `[לוגיסטיקה] דרישת חירום — אושרה אוטומטית · רמות השבים · #${out.id}`);
  assert.deepEqual(dep.notifyRows()[0].slice(0, 2), [out.id, 'emergency_auto']);
});

// ---- approve / reject ----

test('approve (with the approver code) → ONE mail to Roy only, status מאושר, the note; reject → Roy only with the reason', () => {
  const dep = deploy({ requests: [row('R1'), row('R2')] });
  assert.deepEqual(dep.call('handleApprove_', { id: 'R1', approver_code: APPROVER, note: 'בסדר' }, OLGA_SESSION), { ok: true });
  assert.equal(dep.state.mails.length, 1);
  assert.equal(dep.state.mails[0].to, ROY);
  assert.equal(dep.state.mails[0].subject, '[לוגיסטיקה] דרישה אושרה · רמות השבים · #R1');
  assert.match(dep.state.mails[0].htmlBody, /מאושר/);
  assert.match(dep.state.mails[0].htmlBody, /בסדר/);
  assert.deepEqual(dep.call('handleReject_', { id: 'R2', approver_code: APPROVER, reason: 'אין תקציב' }, OLGA_SESSION), { ok: true });
  assert.equal(dep.state.mails.length, 2);
  assert.equal(dep.state.mails[1].to, ROY);
  assert.equal(dep.state.mails[1].subject, '[לוגיסטיקה] דרישה לא אושרה · רמות השבים · #R2');
  assert.match(dep.state.mails[1].htmlBody, /לא מאושר/);
  assert.match(dep.state.mails[1].htmlBody, /אין תקציב/);
  assert.deepEqual(dep.notifyRows().map((r) => r.slice(0, 2)), [['R1', 'approved'], ['R2', 'rejected']]);
});

// ---- dedupe ----

test('DEDUPE: the same (request, event) is never mailed twice — the ledger row blocks a second attempt', () => {
  const dep = deploy({ requests: [row('R1')] });
  const req = dep.api.getRequestById('R1');
  assert.equal(dep.api.notifyEvent_(dep.api.NOTIFY_EVENT.APPROVED, req, {}), true);
  assert.equal(dep.api.notifyEvent_(dep.api.NOTIFY_EVENT.APPROVED, req, {}), false);
  assert.equal(dep.api.notifyEvent_(dep.api.NOTIFY_EVENT.APPROVED, req, {}), false);
  assert.equal(dep.state.mails.length, 1);
  assert.equal(dep.notifyRows().length, 1);
  // a DIFFERENT event for the same request is fine
  assert.equal(dep.api.notifyEvent_(dep.api.NOTIFY_EVENT.REJECTED, req, {}), true);
  assert.equal(dep.state.mails.length, 2);
  // a ledger row seeded by an earlier deploy is honoured too
  const dep2 = deploy({ requests: [row('R1')] });
  dep2.sheets.NotifyLog.appendRow(['R1', 'approved', '2026-01-01T00:00:00.000Z']);
  assert.equal(dep2.api.notifyEvent_(dep2.api.NOTIFY_EVENT.APPROVED, dep2.api.getRequestById('R1'), {}), false);
  assert.equal(dep2.state.mails.length, 0);
});

// ---- disabled / blank ----

test('notify_enabled = FALSE → no mail, no NotifyLog row, no log line; the write itself is unaffected', () => {
  const dep = deploy({ cfg: { notify_enabled: 'FALSE' }, requests: [row('R1')] });
  assert.equal(dep.call('handleCreateRequest_', { ...NEW }, OLGA_SESSION).ok, true);
  assert.deepEqual(dep.call('handleApprove_', { id: 'R1', approver_code: APPROVER }, OLGA_SESSION), { ok: true });
  assert.equal(dep.state.mails.length, 0);
  assert.equal(dep.notifyRows().length, 0);
  assert.ok(!dep.state.logs.some((l) => /notify/.test(l)), 'silent');
  assert.equal(dep.api.getRequestById('R1').status, 'מאושר');
});

test('blank recipients → no mail, no ledger row; a partly blank config mails only the address that exists', () => {
  const dep = deploy({ cfg: { notify_email_approver: '', notify_email_field_ops: '' }, requests: [row('R1')] });
  dep.call('handleCreateRequest_', { ...NEW }, OLGA_SESSION);
  dep.call('handleApprove_', { id: 'R1', approver_code: APPROVER }, OLGA_SESSION);
  assert.equal(dep.state.mails.length, 0);
  assert.equal(dep.notifyRows().length, 0);
  const dep2 = deploy({ cfg: { notify_email_field_ops: '' } });
  dep2.call('handleCreateRequest_', { ...NEW }, OLGA_SESSION);
  assert.equal(dep2.state.mails[0].to, OLGA, 'Roy blank → Olga only');
  const dep3 = deploy({ cfg: { notify_email_field_ops: '' }, requests: [row('R1')] });
  dep3.call('handleApprove_', { id: 'R1', approver_code: APPROVER }, OLGA_SESSION);
  assert.equal(dep3.state.mails.length, 0, 'a Roy-only event with Roy blank → nothing');
});

// ---- fail-safe ----

test('FAIL-SAFE: MailApp throws (quota / not authorized) → the write still succeeds, the row is written, the error is logged', () => {
  const dep = deploy({ mailThrows: true, requests: [row('R1')] });
  const created = dep.call('handleCreateRequest_', { ...NEW }, OLGA_SESSION);
  assert.equal(created.ok, true);
  assert.ok(dep.api.getRequestById(created.id), 'the request row exists');
  assert.deepEqual(dep.call('handleApprove_', { id: 'R1', approver_code: APPROVER }, OLGA_SESSION), { ok: true });
  assert.equal(dep.api.getRequestById('R1').status, 'מאושר', 'the approval was committed');
  assert.equal(dep.state.mails.length, 0);
  assert.ok(dep.state.logs.some((l) => /notify failed \(new_request/.test(l)));
  assert.ok(dep.state.logs.some((l) => /notify failed \(approved, R1\)/.test(l)));
});

test('FAIL-SAFE: a missing NotifyLog sheet (setupSheet not re-run) → the write succeeds, nothing is sent, the reason is logged', () => {
  const dep = deploy({ notifyLog: false, requests: [row('R1')] });
  assert.deepEqual(dep.call('handleApprove_', { id: 'R1', approver_code: APPROVER }, OLGA_SESSION), { ok: true });
  assert.equal(dep.api.getRequestById('R1').status, 'מאושר');
  assert.equal(dep.state.mails.length, 0);
  assert.ok(dep.state.logs.some((l) => /NotifyLog sheet missing/.test(l)));
});

// ---- deferral wake-up in the daily scan ----

test('the daily scan mails a deferral wake-up to Roy ONCE per due request and leaves the request untouched', () => {
  const dep = deploy({ requests: [
    row('D1', { status: 'נדחה לתאריך', deferred_until: '2020-01-01' }),   // long due
    row('D2', { status: 'נדחה לתאריך', deferred_until: '2999-12-31' }),   // not yet
    row('D3', { status: 'מאושר', deferred_until: '2020-01-01' }),        // already re-decided
  ] });
  dep.api.runMaintenanceScan();
  assert.equal(dep.state.mails.length, 1);
  assert.equal(dep.state.mails[0].to, ROY);
  assert.equal(dep.state.mails[0].subject, '[לוגיסטיקה] דרישה דחויה חזרה ללוח · רמות השבים · #D1');
  assert.match(dep.state.mails[0].htmlBody, /נדחה עד<\/td>/);
  assert.equal(dep.api.getRequestById('D1').status, 'נדחה לתאריך', 'the request is not changed by the scan');
  dep.api.runMaintenanceScan();
  assert.equal(dep.state.mails.length, 1, 'second run: already logged → nothing');
  assert.deepEqual(dep.notifyRows().map((r) => r.slice(0, 2)), [['D1', 'deferral_wakeup']]);
  assert.ok(dep.state.logs.some((l) => /deferral wake-up mails 1/.test(l)));
});

// ---- misc contract ----

test('the deep link falls back to no button when notify_app_url is blank / not https; the body never carries another request\'s money', () => {
  const dep = deploy({ cfg: { notify_app_url: '' }, requests: [row('R1'), row('R9', { estimated_cost: 77777 })] });
  dep.call('handleApprove_', { id: 'R1', approver_code: APPROVER }, OLGA_SESSION);
  assert.ok(!/dashboard\?req=/.test(dep.state.mails[0].htmlBody), 'no link without a base url');
  assert.ok(!/77777/.test(dep.state.mails[0].htmlBody), 'only this request\'s cost');
  const dep2 = deploy({ cfg: { notify_app_url: 'http://insecure.example' }, requests: [row('R1')] });
  dep2.call('handleApprove_', { id: 'R1', approver_code: APPROVER }, OLGA_SESSION);
  assert.ok(!/insecure/.test(dep2.state.mails[0].htmlBody), 'a non-https base is ignored');
});

test('notifyTestEmail (editor helper for first-run authorization) mails the approver and writes no ledger row', () => {
  const dep = deploy();
  dep.api.notifyTestEmail();
  assert.equal(dep.state.mails.length, 1);
  assert.equal(dep.state.mails[0].to, OLGA);
  assert.equal(dep.notifyRows().length, 0);
  assert.throws(() => deploy({ cfg: { notify_email_approver: '', notify_email_field_ops: '' } }).api.notifyTestEmail(), /Fill notify_email/);
});

test('STATIC: BOOLEAN_KEYS in Code.gs coerce notify_enabled; every write-path event is wired; recipients are never hardcoded', () => {
  assert.match(CODE_GS, /var BOOLEAN_KEYS = \['emergency_bypasses_approval', 'notify_enabled'\]/);
  for (const fn of ['handleCreateRequest_', 'handleCreateRequestIntake_', 'handleApprove_', 'handleReject_']) {
    const body = CODE_GS.slice(CODE_GS.indexOf(`function ${fn}(`));
    assert.match(body.slice(0, body.indexOf('\nfunction ', 1)), /notifyEvent_\(/, `${fn} notifies`);
  }
  const scan = CODE_GS.slice(CODE_GS.indexOf('function runMaintenanceScan('), CODE_GS.indexOf('function installMaintenanceTrigger('));
  assert.match(scan, /notifyDeferralWakeups_\(requests, today\)/);
  assert.ok(!/@totalgroup|@gmail\.com/.test(CODE_GS.slice(CODE_GS.indexOf('MIRROR:notify START'))), 'no hardcoded recipient in the notify code');
  const dash = readFileSync(join(root, 'src/dashboard.html'), 'utf8');
  assert.match(dash, /data-id="\$\{escapeHtml\(r\.id\)\}"/, 'cards carry the id for the deep link');
  assert.match(dash, /get\('req'\)/, 'the dashboard honours ?req=<id>');
});
