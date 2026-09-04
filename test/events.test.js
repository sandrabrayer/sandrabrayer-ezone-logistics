// test/events.test.js — the exceptional-events register (אירועים חריגים) pure logic. Covers create
// permission per role (incl. coordinator own-house-only, maintenance blocked), created_by-from-token,
// close-requires-root_cause+lessons, corrective-link validation, event_types fallback, recurrence
// boundaries (exactly 2 in 90 days; not at 1; not at 91 apart), day-first occurred_at, and the panel's
// TRUE-zero-vs-unavailable discipline. The SAME functions run in apps-script/Code.gs (mirror-drift guards it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_SEVERITIES, EVENT_STATUSES, parseEventTypes, eventSeverityRank, eventCreatePermitted,
  eventCreateError, buildEventRow, eventCloseError, eventUpdateError, parseEventRow,
  detectRecurrence, monthlyTrend, eventsAnalysis,
} from '../src/events.js';

const ID_TO_NAME = {
  'ramot-hashavim': 'רמות השבים', 'raanana-asher': 'רעננה אשר', 'pardes': 'רעננה הפרדס',
  'caesarea-ofroni': 'קיסריה עפרוני', 'caesarea-rehab': 'קיסריה ריהאב', 'sde-eliezer': 'שדה אליעזר',
};
const MAPS = { idToName: ID_TO_NAME };
// The five OPEN houses (רעננה הפרדס opened Aug 2026; only sde-eliezer is pre-opening in the seed).
const OPEN = ['ramot-hashavim', 'raanana-asher', 'pardes', 'caesarea-ofroni', 'caesarea-rehab'];
const NOW = '2026-07-31';
const TYPES = ['בטיחות', 'תרופות', 'התנהגות', 'תשתיות', 'תברואה', 'אחר'];
const logger = () => { const out = []; const fn = (m) => out.push(m); fn.out = out; return fn; };

// ---- event_types spec ----

test('parseEventTypes: a valid pipe spec → the list; malformed/blank → ["אחר"] + logged', () => {
  assert.deepEqual(parseEventTypes('בטיחות|תרופות|אחר', logger()), ['בטיחות', 'תרופות', 'אחר']);
  assert.deepEqual(parseEventTypes(' בטיחות | בטיחות |', logger()), ['בטיחות']); // trims + dedups + drops blanks
  const log = logger();
  assert.deepEqual(parseEventTypes('', log), ['אחר']);
  assert.deepEqual(parseEventTypes(null, log), ['אחר']);
  assert.equal(log.out.length, 2, 'each malformed/blank spec logs the fallback');
});

// ---- create permission (role + house scope) ----

test('eventCreatePermitted: maintenance CANNOT report; field_ops/ops_manager can report any house; ceo is gone', () => {
  assert.equal(eventCreatePermitted('maintenance', 'sharon', 'רעננה אשר', 'sharon'), false);
  for (const r of ['field_ops', 'ops_manager']) {
    assert.equal(eventCreatePermitted(r, '', 'רעננה אשר', 'sharon'), true);
  }
  assert.equal(eventCreatePermitted('ceo', '', 'רעננה אשר', 'sharon'), false, 'a stale ceo token fails closed');
  assert.equal(eventCreatePermitted('nonsense', '', 'רעננה אשר', 'sharon'), false); // unknown role fails closed
});

test('eventCreatePermitted: a coordinator may report ONLY for their own house', () => {
  assert.equal(eventCreatePermitted('coordinator', 'קיסריה עפרוני', 'קיסריה עפרוני', 'caesarea'), true);
  assert.equal(eventCreatePermitted('coordinator', 'קיסריה עפרוני', 'רעננה אשר', 'sharon'), false);
});

// ---- create validation + row shaping ----

test('eventCreateError: rejects missing/invalid fields; passes a valid payload', () => {
  const ok = { house: 'קיסריה עפרוני', occurred_at: '2026-07-01', event_type: 'בטיחות', severity: 'גבוה', description: 'x' };
  assert.equal(eventCreateError(ok, TYPES), '');
  assert.equal(eventCreateError({ ...ok, house: '' }, TYPES) !== '', true);
  assert.equal(eventCreateError({ ...ok, occurred_at: 'nope' }, TYPES) !== '', true);
  assert.equal(eventCreateError({ ...ok, event_type: 'לא-קיים' }, TYPES) !== '', true);
  assert.equal(eventCreateError({ ...ok, severity: 'ענק' }, TYPES) !== '', true);
  assert.equal(eventCreateError({ ...ok, description: '  ' }, TYPES) !== '', true);
});

test('buildEventRow: created_by comes from the ACTOR token, never the client body; starts פתוח', () => {
  const row = buildEventRow(
    { house: 'caesarea-ofroni', occurred_at: '2026-07-01', event_type: 'בטיחות', severity: 'גבוה',
      description: 'd', immediate_action: 'a', created_by: 'HACKER', status: 'נסגר', id: 'SPOOF' },
    { name: 'שירה', role: 'coordinator' }, 'EVT-1', '2026-07-31T10:00:00.000Z');
  assert.equal(row.created_by, 'שירה');       // from actor, not the client's 'HACKER'
  assert.equal(row.id, 'EVT-1');              // server id, not the client's 'SPOOF'
  assert.equal(row.status, 'פתוח');           // always opens פתוח, ignores client 'נסגר'
  assert.equal(row.root_cause, ''); assert.equal(row.lessons, ''); assert.equal(row.closed_at, '');
});

test('buildEventRow: occurred_at is parsed DAY-FIRST via the shared parser', () => {
  const row = buildEventRow(
    { house: 'caesarea-ofroni', occurred_at: '12/7/2026', event_type: 'בטיחות', severity: 'נמוך', description: 'd' },
    { name: 'רועי' }, 'EVT-2', '2026-07-31T10:00:00.000Z');
  assert.equal(row.occurred_at, '2026-07-12'); // 12 July, not 7 December
});

// ---- close / update validation ----

test('eventCloseError: closing REQUIRES root_cause AND lessons; non-close is always fine', () => {
  assert.equal(eventCloseError({ status: 'בטיפול' }), '');                                  // not closing
  assert.notEqual(eventCloseError({ status: 'נסגר', root_cause: '', lessons: 'x' }), '');   // missing root_cause
  assert.notEqual(eventCloseError({ status: 'נסגר', root_cause: 'x', lessons: '' }), '');   // missing lessons
  assert.equal(eventCloseError({ status: 'נסגר', root_cause: 'שורש', lessons: 'לקח' }), ''); // both present
});

test('eventUpdateError: invalid status rejected; corrective link must exist; then close rules apply', () => {
  assert.notEqual(eventUpdateError({ status: 'מה?' }, true), '');                                  // bad status
  assert.notEqual(eventUpdateError({ status: 'בטיפול', corrective_request_id: 'REQ-9' }, false), ''); // link missing
  assert.equal(eventUpdateError({ status: 'בטיפול', corrective_request_id: 'REQ-9' }, true), '');    // link exists
  assert.equal(eventUpdateError({ corrective_request_id: '' }, true), '');                           // no link → ok
  assert.notEqual(eventUpdateError({ status: 'נסגר', root_cause: 'x', lessons: '' }, true), '');     // close rules still apply
});

// ---- recurrence boundaries ----

function evt(id, type, house, occurred, status) {
  return { id: id, event_type: type, house: house, occurred_at: occurred, severity: 'בינוני', status: status || 'פתוח' };
}

test('detectRecurrence: flags at EXACTLY 2 in 90 days; NOT at 1; NOT when 91 days apart', () => {
  // Two events same type+house, 30 days apart, both within the trailing 90 days from NOW → recurring(2).
  const two = detectRecurrence([evt('A', 'בטיחות', 'caesarea-ofroni', '2026-07-01'),
    evt('B', 'בטיחות', 'caesarea-ofroni', '2026-06-01')], NOW, 90);
  assert.equal(two.length, 1);
  assert.equal(two[0].count, 2);
  assert.equal(two[0].recurring, true);

  // A single occurrence → not flagged.
  assert.equal(detectRecurrence([evt('A', 'בטיחות', 'caesarea-ofroni', '2026-07-01')], NOW, 90).length, 0);

  // 91 days apart: with NOW = the later event's date, the earlier one falls OUTSIDE the trailing 90-day
  // window, so only 1 is counted → not recurring.
  const apart = detectRecurrence([evt('A', 'בטיחות', 'caesarea-ofroni', '2026-07-31'),
    evt('B', 'בטיחות', 'caesarea-ofroni', '2026-05-01')], '2026-07-31', 90); // 2026-05-01 → 91 days before
  assert.equal(apart.length, 0);
});

test('detectRecurrence: different type OR different house does not aggregate', () => {
  const r = detectRecurrence([
    evt('A', 'בטיחות', 'caesarea-ofroni', '2026-07-01'),
    evt('B', 'תרופות', 'caesarea-ofroni', '2026-07-02'),
    evt('C', 'בטיחות', 'raanana-asher', '2026-07-03'),
  ], NOW, 90);
  assert.equal(r.length, 0);
});

// ---- monthly trend ----

test('monthlyTrend: last 6 months, counted by occurred_at month', () => {
  const t = monthlyTrend([
    evt('A', 'בטיחות', 'caesarea-ofroni', '2026-07-05'),
    evt('B', 'בטיחות', 'caesarea-ofroni', '2026-07-20'),
    evt('C', 'בטיחות', 'caesarea-ofroni', '2026-05-10'),
    evt('D', 'בטיחות', 'caesarea-ofroni', '2025-12-10'), // outside the 6-month window
  ], NOW, 6);
  assert.equal(t.length, 6);
  assert.equal(t[t.length - 1].month, '2026-07');
  assert.equal(t[t.length - 1].count, 2);
  assert.equal(t.find((x) => x.month === '2026-05').count, 1);
  assert.equal(t.some((x) => x.month === '2025-12'), false);
});

// ---- analysis panel ----

test('eventsAnalysis: available:true always; a house with no open events → TRUE zero (not unavailable)', () => {
  const a = eventsAnalysis([], MAPS, OPEN, NOW, logger());
  assert.equal(a.available, true);                 // the register is self-owned → never "unavailable"
  assert.equal(a.houses.length, OPEN.length);
  assert.ok(a.houses.every((h) => h.openCount === 0 && h.hasEvents === false));
  assert.equal(a.openCount, 0);
});

test('eventsAnalysis: open events worst-first (severity, then oldest); closed excluded; missing-lessons counted', () => {
  const events = [
    evt('A', 'בטיחות', 'caesarea-ofroni', '2026-07-20', 'פתוח'),   // בינוני
    { ...evt('B', 'תשתיות', 'caesarea-ofroni', '2026-07-01', 'בטיפול'), severity: 'גבוה' }, // worst
    { ...evt('C', 'אחר', 'caesarea-ofroni', '2026-06-01', 'נסגר'), severity: 'גבוה', lessons: 'למד' }, // closed → excluded from open
  ];
  const a = eventsAnalysis(events, MAPS, OPEN, NOW, logger());
  const house = a.houses.find((h) => h.id === 'caesarea-ofroni');
  assert.equal(house.openCount, 2);
  assert.equal(house.events[0].id, 'B');           // גבוה sorts before בינוני
  assert.equal(a.openCount, 2);                    // the closed one is not "open"
  assert.equal(a.missingLessonsCount, 2);          // A and B have no lessons; C has lessons
  assert.equal(a.houses[0].id, 'caesarea-ofroni'); // worst house sorts first
});

test('eventsAnalysis: malformed rows (unknown house / bad occurred_at) are skipped + counted', () => {
  const log = logger();
  const events = [
    evt('A', 'בטיחות', 'atlantis', '2026-07-01'),          // unknown house
    evt('B', 'בטיחות', 'caesarea-ofroni', 'not-a-date'),    // bad date
    evt('C', 'בטיחות', 'caesarea-ofroni', '2026-07-01'),    // valid
  ];
  const a = eventsAnalysis(events, MAPS, OPEN, NOW, log);
  assert.equal(a.skipped, 2);
  assert.equal(a.openCount, 1);
  assert.ok(log.out.length >= 2);
});

test('eventsAnalysis: recurrence carries houseName and rides on the analysis', () => {
  const events = [
    evt('A', 'בטיחות', 'caesarea-ofroni', '2026-07-01'),
    evt('B', 'בטיחות', 'caesarea-ofroni', '2026-06-15'),
  ];
  const a = eventsAnalysis(events, MAPS, OPEN, NOW, logger());
  assert.equal(a.recurrence.length, 1);
  assert.equal(a.recurrence[0].houseName, 'קיסריה עפרוני');
  assert.equal(a.recurrence[0].count, 2);
});

test('vocabularies are the expected controlled sets', () => {
  assert.deepEqual(EVENT_SEVERITIES, ['נמוך', 'בינוני', 'גבוה']);
  assert.deepEqual(EVENT_STATUSES, ['פתוח', 'בטיפול', 'נסגר']);
  assert.equal(eventSeverityRank('גבוה') > eventSeverityRank('בינוני'), true);
  assert.equal(eventSeverityRank('בינוני') > eventSeverityRank('נמוך'), true);
  assert.equal(eventSeverityRank('??'), 0);
});
