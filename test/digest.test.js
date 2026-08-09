// test/digest.test.js — locks the pure logic behind the coordinators digest export.
// These helpers are mirrored verbatim in apps-script/digest.gs (Apps Script is the writer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  HOUSE_IDS, DIGEST_HOUSE_IDS, houseId,
  EXCLUDED_TICKET_STATUSES, isActiveTicket,
  isDigestTicket, TERMINAL_TICKET_STATUSES, REJECTED_TICKET_STATUS, DIGEST_RETENTION_DAYS_DEFAULT,
  dateOnly,
  scrubMoney, truncateTitle, formatTitle, TITLE_MAX,
  weekStart, recentWeekStarts,
  isShortage, shortageLabel, buildWeeklyGrid,
  DIGEST_OPEN_HEADERS, scrubField, openTicketRow,
} from '../src/digest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ---- financial-data guard: the budget module must NEVER leak into any digest ----
test('NO financial/budget columns in any digest tab (OpenTickets + WeeklyCounts)', () => {
  const FINANCIAL = /budget|amount|cost|actual|estimated|remaining|₪/i;
  // The exported OpenTickets header list has no financial column.
  for (const h of DIGEST_OPEN_HEADERS) assert.ok(!FINANCIAL.test(h), `financial column leaked into digest: ${h}`);
  // The Apps Script writer's two header arrays (the only columns ever written) carry none either.
  const gs = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8');
  for (const name of ['DIGEST_OPEN_HEADERS_', 'DIGEST_WEEKLY_HEADERS_']) {
    const m = gs.match(new RegExp(name + '\\s*=\\s*\\[([^\\]]*)\\]'));
    assert.ok(m, `${name} header array not found in digest.gs`);
    assert.ok(!FINANCIAL.test(m[1]), `financial column in ${name}: ${m[1]}`);
  }
});

// ---- OpenTickets columns (increment 36: aging appended; this change: category/urgency/location) ----

test('OpenTickets carries daysOpen / overdue / blocked, appended after the original six', () => {
  // The original six keep their positions; the three aging columns follow them (positions 7-9).
  assert.deepEqual(DIGEST_OPEN_HEADERS.slice(0, 6),
    ['house', 'ticketId', 'title', 'status', 'openedDate', 'updatedAt']);
  assert.deepEqual(DIGEST_OPEN_HEADERS.slice(6, 9), ['daysOpen', 'overdue', 'blocked']);
});

test('OpenTickets appends category / urgency / location_in_house AFTER the existing nine columns', () => {
  // Append-only contract: the nine existing columns are byte-identical and keep their exact positions;
  // the three non-financial request facts are added strictly at the end, in this order.
  assert.deepEqual(DIGEST_OPEN_HEADERS.slice(0, 9), [
    'house', 'ticketId', 'title', 'status', 'openedDate', 'updatedAt', 'daysOpen', 'overdue', 'blocked',
  ]);
  assert.deepEqual(DIGEST_OPEN_HEADERS.slice(9, 12), ['category', 'urgency', 'location_in_house']);
});

test('OpenTickets appends deferred_date as column 13, AFTER the existing twelve (byte-identical 1-12)', () => {
  // Append-only contract: columns 1-12 are byte-identical and keep their exact positions; deferred_date
  // (read by the Coordinators app, PR #125, under this exact header name) is added strictly at the end.
  assert.deepEqual(DIGEST_OPEN_HEADERS.slice(0, 12), [
    'house', 'ticketId', 'title', 'status', 'openedDate', 'updatedAt', 'daysOpen', 'overdue', 'blocked',
    'category', 'urgency', 'location_in_house',
  ]);
  assert.equal(DIGEST_OPEN_HEADERS[12], 'deferred_date');
  assert.equal(DIGEST_OPEN_HEADERS.length, 13);
});

test('the Apps Script writer header array mirrors src exactly (byte-for-byte, same order)', () => {
  const gs = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8');
  const m = gs.match(/DIGEST_OPEN_HEADERS_\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'DIGEST_OPEN_HEADERS_ found in digest.gs');
  const gsHeaders = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(gsHeaders, DIGEST_OPEN_HEADERS, 'the writer and src header lists must not drift');
});

// ---- house-id map (increment 33: all six houses, canonical names) ----

test('all six houses map to their (v2, shared ezone-kitchen) ids', () => {
  assert.equal(houseId('רמות השבים'), 'ramot-hashavim');
  assert.equal(houseId('רעננה אשר'), 'raanana-asher');
  assert.equal(houseId('רעננה הפרדס'), 'pardes');   // increment 35: aligned with HOUSE-IDS.md + ezone-kitchen
  assert.equal(houseId('קיסריה עפרוני'), 'caesarea-ofroni');
  assert.equal(houseId('קיסריה ריהאב'), 'caesarea-rehab');
  assert.equal(houseId('שדה אליעזר'), 'sde-eliezer');
});

test('the pre-opening houses now DO map (they already have activity) — no longer invisible', () => {
  assert.equal(houseId('רעננה הפרדס'), 'pardes');
  assert.equal(houseId('שדה אליעזר'), 'sde-eliezer');
});

test('unknown / blank house names return null', () => {
  assert.equal(houseId('משהו אחר'), null);
  assert.equal(houseId(''), null);
  assert.equal(houseId(null), null);
  assert.equal(houseId(undefined), null);
});

test('house name is matched after trimming surrounding whitespace', () => {
  assert.equal(houseId('  רעננה אשר  '), 'raanana-asher');
});

test('DIGEST_HOUSE_IDS is exactly the six mapped ids, in canonical (HOUSE-IDS.md) order', () => {
  assert.deepEqual(DIGEST_HOUSE_IDS, [
    'ramot-hashavim', 'raanana-asher', 'pardes', 'caesarea-ofroni', 'caesarea-rehab', 'sde-eliezer',
  ]);
  assert.deepEqual([...new Set(Object.values(HOUSE_IDS))].sort(), [...DIGEST_HOUSE_IDS].sort());
});

// ---- shortage = below par (increment 33) ----

test('isShortage: quantity_base strictly below a set par is a shortage', () => {
  assert.equal(isShortage(40, 200), true);     // 40 < 200 → shortage
  assert.equal(isShortage(200, 200), false);   // equal → not a shortage
  assert.equal(isShortage(250, 200), false);   // above → not a shortage
});

test('isShortage: counted 0 with a par is a shortage; with no par it is not', () => {
  assert.equal(isShortage(0, 48), true);       // counted empty, has a par → shortage
  assert.equal(isShortage(0, null), false);    // counted empty, no par → not a shortage
  assert.equal(isShortage(0, ''), false);      // blank par → not a shortage
});

test('isShortage: a non-comparable base qty (never counted / blank) is never a shortage', () => {
  assert.equal(isShortage('', 48), false);
  assert.equal(isShortage(undefined, 48), false);
  assert.equal(isShortage(null, 48), false);
});

test('shortageLabel includes the base unit so the number reads; appends a note', () => {
  assert.equal(shortageLabel('שקיות אשפה', 40, 200, 'unit'), 'שקיות אשפה: 40/200 unit');
  assert.equal(shortageLabel('סבון ידיים', 500, 5000, 'ml', 'נגמר'), 'סבון ידיים: 500/5000 ml (נגמר)');
  assert.equal(shortageLabel('x', 1, 2, ''), 'x: 1/2');   // no base unit → no trailing unit
});

// ---- weekly grid: six houses × eight weeks ----

test('buildWeeklyGrid emits 6 houses × 8 weeks = 48 rows, gaps as not-done', () => {
  const weeks = recentWeekStarts('2026-07-25', 8);
  const bucket = { 'ramot-hashavim|2026-07-19': { shortagesSummary: 'טישו: 6/12 unit', updatedAt: '2026-07-20T00:00:00Z' } };
  const rows = buildWeeklyGrid(bucket, weeks, '2026-07-30T00:00:00Z', 'בוצעה', 'לא בוצעה');
  assert.equal(rows.length, 48);                        // 6 × 8
  assert.equal(new Set(rows.map((r) => r[0])).size, 6); // six distinct houses
  const done = rows.find((r) => r[0] === 'ramot-hashavim' && r[1] === '2026-07-19');
  assert.deepEqual(done, ['ramot-hashavim', '2026-07-19', 'בוצעה', 'טישו: 6/12 unit', '2026-07-20T00:00:00Z']);
  // every other cell is a not-done row with an empty summary and the now-timestamp
  const gap = rows.find((r) => r[0] === 'sde-eliezer' && r[1] === '2026-07-19');
  assert.deepEqual(gap, ['sde-eliezer', '2026-07-19', 'לא בוצעה', '', '2026-07-30T00:00:00Z']);
});

// ---- active-ticket filter ----

test('סגור and לא מאושר are excluded; every other status is active', () => {
  assert.deepEqual(EXCLUDED_TICKET_STATUSES, ['סגור', 'לא מאושר']);
  assert.equal(isActiveTicket('סגור'), false);
  assert.equal(isActiveTicket('לא מאושר'), false);
  for (const s of ['דרישה', 'ממתין לאישור', 'מאושר', 'נדחה לתאריך', 'בביצוע', 'הושלם']) {
    assert.equal(isActiveTicket(s), true, `${s} should be active`);
  }
});

test('isActiveTicket trims and tolerates null/blank', () => {
  assert.equal(isActiveTicket('  סגור  '), false);
  assert.equal(isActiveTicket(''), true);
  assert.equal(isActiveTicket(null), true);
});

// ---- digest inclusion: retention-aware self-cleaning (completed/closed linger archive_after_days) ----

const DNOW = '2026-08-09T12:00:00.000Z';
const dNowMs = new Date(DNOW).getTime();
const dDaysAgo = (n) => new Date(dNowMs - n * 86400000).toISOString();

test('rejected (לא מאושר) tickets are never in the digest', () => {
  assert.equal(REJECTED_TICKET_STATUS, 'לא מאושר');
  assert.equal(isDigestTicket({ status: 'לא מאושר', completed_at: dDaysAgo(0) }, DNOW, 7), false);
});

test('active tickets are always in the digest, regardless of age', () => {
  for (const s of ['דרישה', 'ממתין לאישור', 'מאושר', 'נדחה לתאריך', 'בביצוע']) {
    assert.equal(isDigestTicket({ status: s, created_at: dDaysAgo(90) }, DNOW, 7), true, s);
  }
});

test('completed/closed tickets linger for the retention window, then drop out', () => {
  assert.deepEqual(TERMINAL_TICKET_STATUSES, ['הושלם', 'סגור']);
  // within 7 days → shown (recent completion the coordinator should still see)
  assert.equal(isDigestTicket({ status: 'הושלם', completed_at: dDaysAgo(3) }, DNOW, 7), true);
  assert.equal(isDigestTicket({ status: 'סגור', completed_at: dDaysAgo(6) }, DNOW, 7), true);
  // older than 7 days → dropped (self-cleaning)
  assert.equal(isDigestTicket({ status: 'הושלם', completed_at: dDaysAgo(8) }, DNOW, 7), false);
  assert.equal(isDigestTicket({ status: 'סגור', completed_at: dDaysAgo(30) }, DNOW, 7), false);
});

test('the retention boundary is inclusive at exactly N days', () => {
  assert.equal(isDigestTicket({ status: 'הושלם', completed_at: dDaysAgo(7) }, DNOW, 7), true);  // exactly 7 → still shown
  assert.equal(isDigestTicket({ status: 'הושלם', completed_at: dDaysAgo(8) }, DNOW, 7), false); // 8 → dropped
});

test('a completed/closed ticket with no parseable completion date is kept (not hidden)', () => {
  assert.equal(isDigestTicket({ status: 'הושלם', completed_at: '' }, DNOW, 7), true);
  assert.equal(isDigestTicket({ status: 'סגור' }, DNOW, 7), true);
  assert.equal(isDigestTicket({ status: 'הושלם', completed_at: 'not-a-date' }, DNOW, 7), true);
});

test('a missing / bad retention window falls back to the default (7)', () => {
  assert.equal(DIGEST_RETENTION_DAYS_DEFAULT, 7);
  for (const bad of [undefined, null, 0, -3, NaN, 'x']) {
    assert.equal(isDigestTicket({ status: 'הושלם', completed_at: dDaysAgo(7) }, DNOW, bad), true, `win=${bad}`);
    assert.equal(isDigestTicket({ status: 'הושלם', completed_at: dDaysAgo(8) }, DNOW, bad), false, `win=${bad}`);
  }
});

test('a custom retention window is honored', () => {
  const req = { status: 'הושלם', completed_at: dDaysAgo(20) };
  assert.equal(isDigestTicket(req, DNOW, 30), true);  // 20 <= 30 → still shown
  assert.equal(isDigestTicket(req, DNOW, 14), false); // 20 > 14 → dropped
});

// ---- dateOnly: stable YYYY-MM-DD normalization ----

test('dateOnly reduces any date-ish value to a stable YYYY-MM-DD (never a raw Date string)', () => {
  assert.equal(dateOnly('2026-09-01'), '2026-09-01');                       // already ISO date → verbatim
  assert.equal(dateOnly('2026-09-01T00:00:00.000Z'), '2026-09-01');         // ISO timestamp → date part
  assert.equal(dateOnly(new Date('2026-09-01T00:00:00.000Z')), '2026-09-01'); // a real Date object
  assert.equal(dateOnly(''), '');
  assert.equal(dateOnly(null), '');
  assert.equal(dateOnly(undefined), '');
  assert.equal(dateOnly('not-a-date'), '');
  // never a locale Date serialization like "Tue Sep 01 2026 …"
  assert.doesNotMatch(dateOnly(new Date('2026-09-01T00:00:00.000Z')), /[A-Za-z]/);
});

// ---- money scrubber ----

test('strips the ₪ symbol and the number glued to it', () => {
  assert.equal(scrubMoney('החלפת מזגן 3000 ₪'), 'החלפת מזגן');
  assert.equal(scrubMoney('מזגן ₪3000 דחוף'), 'מזגן דחוף');
  assert.equal(scrubMoney('מזגן 3000₪ דחוף'), 'מזגן דחוף');
});

test('strips ש"ח / שח / NIS / ILS with their adjacent digits', () => {
  assert.equal(scrubMoney('עלות 1200 ש"ח לתיקון'), 'עלות לתיקון');
  assert.equal(scrubMoney('עלות 1200 שח לתיקון'), 'עלות לתיקון');
  assert.equal(scrubMoney('cost 500 NIS total'), 'cost total');
  assert.equal(scrubMoney('ILS 750 approx'), 'approx');
});

test('handles thousands separators and decimals attached to a marker', () => {
  assert.equal(scrubMoney('סכום 3,000 ₪'), 'סכום');
  assert.equal(scrubMoney('1200.50 ש"ח'), '');
});

test('BARE quantities are counts, not prices — they stay', () => {
  assert.equal(scrubMoney('צריך 5 כיסאות'), 'צריך 5 כיסאות');
  assert.equal(scrubMoney('להזמין 12 נורות'), 'להזמין 12 נורות');
  assert.equal(scrubMoney('3 שקים'), '3 שקים');
});

test('marker letters inside real words are NOT stripped', () => {
  assert.equal(scrubMoney('משחק ילדים'), 'משחק ילדים');   // שח inside משחק
  assert.equal(scrubMoney('TENNIS court'), 'TENNIS court'); // NIS inside TENNIS
});

test('scrubMoney tolerates null/undefined', () => {
  assert.equal(scrubMoney(null), '');
  assert.equal(scrubMoney(undefined), '');
  assert.equal(scrubMoney(''), '');
});

// ---- title truncation ----

test('short titles pass through unchanged, flattened to one line', () => {
  assert.equal(truncateTitle('נזילה במטבח'), 'נזילה במטבח');
  assert.equal(truncateTitle('שורה 1\nשורה 2'), 'שורה 1 שורה 2');
  assert.equal(truncateTitle('  יש   רווחים   '), 'יש רווחים');
});

test('long titles are cut to <=80 chars with an ellipsis', () => {
  const long = 'א'.repeat(200);
  const t = truncateTitle(long);
  assert.equal(t.length, TITLE_MAX);
  assert.ok(t.endsWith('…'));
  assert.equal(t, 'א'.repeat(79) + '…');
});

test('truncateTitle honours a custom max', () => {
  assert.equal(truncateTitle('abcdefgh', 5), 'abcd…');
  assert.equal(truncateTitle('abc', 5), 'abc');
});

test('formatTitle scrubs money THEN truncates', () => {
  assert.equal(formatTitle('החלפת מזגן 3000 ₪'), 'החלפת מזגן');
  const t = formatTitle('X'.repeat(100) + ' 500 ₪', 80);
  assert.equal(t.length, 80);
  assert.ok(t.endsWith('…'));
});

// ---- Sunday week-start ----

test('weekStart returns the Sunday that begins the week', () => {
  // 2026-07-25 is a Saturday → its week began Sunday 2026-07-19.
  assert.equal(weekStart('2026-07-25'), '2026-07-19');
  // A Sunday maps to itself.
  assert.equal(weekStart('2026-07-19'), '2026-07-19');
  // A Wednesday.
  assert.equal(weekStart('2026-07-22'), '2026-07-19');
  // Works with a full ISO timestamp too.
  assert.equal(weekStart('2026-07-25T13:45:00Z'), '2026-07-19');
});

test('weekStart tolerates invalid input', () => {
  assert.equal(weekStart('not-a-date'), '');
  assert.equal(weekStart(''), '');
});

test('recentWeekStarts returns n Sundays, most-recent first', () => {
  const weeks = recentWeekStarts('2026-07-25', 8);
  assert.equal(weeks.length, 8);
  assert.equal(weeks[0], '2026-07-19'); // current week
  assert.equal(weeks[1], '2026-07-12');
  assert.equal(weeks[7], '2026-05-31'); // 7 weeks back (49 days)
  // strictly descending, exactly 7 days apart
  for (let i = 1; i < weeks.length; i++) {
    const prev = new Date(weeks[i - 1] + 'T00:00:00Z').getTime();
    const cur = new Date(weeks[i] + 'T00:00:00Z').getTime();
    assert.equal(prev - cur, 7 * 24 * 3600 * 1000);
  }
});

test('recentWeekStarts edge cases', () => {
  assert.deepEqual(recentWeekStarts('2026-07-25', 0), []);
  assert.deepEqual(recentWeekStarts('bad', 8), []);
});

// ---- scrubField: the appended category / urgency / location columns ----

test('scrubField money-scrubs and single-lines, like title but uncapped', () => {
  // Money is stripped exactly as in title (the contract invariant — no price leaks into a readable field).
  assert.equal(scrubField('החלפה 3000 ₪'), 'החלפה');
  assert.equal(scrubField('ליד המקרר 250 שח'), 'ליד המקרר');
  // Newlines / runs of whitespace collapse to a single line, but no 80-char cap is applied.
  assert.equal(scrubField('קומה 2\nליד המעלית'), 'קומה 2 ליד המעלית');
  assert.equal(scrubField('  דחוף   '), 'דחוף');
  const long = 'א'.repeat(120);
  assert.equal(scrubField(long), long, 'passthrough fields are NOT length-capped');
});

test('scrubField normalises null / undefined / empty to an empty string', () => {
  assert.equal(scrubField(null), '');
  assert.equal(scrubField(undefined), '');
  assert.equal(scrubField(''), '');
});

test('scrubField leaves bare counts (no currency marker) untouched — they are quantities, not prices', () => {
  assert.equal(scrubField('חדר 3'), 'חדר 3');
  assert.equal(scrubField('רגיל'), 'רגיל');
});

// ---- openTicketRow: full-row layout, values, and append-only correctness ----

const SAMPLE_REQ = {
  id: 'R-42',
  description: 'נזילה מתחת לכיור 500 ₪',
  status: 'מאושר',
  category: 'תיקון',
  urgency: 'דחוף',
  location_in_house: 'מטבח — ליד\nהכיור 250 שח',
  deferred_until: '2026-09-01',
};
const SAMPLE_CTX = {
  house: 'pardes',
  openedDate: '2026-08-01',
  updatedAt: '2026-08-05T09:00:00.000Z',
  daysOpen: 7,
  overdue: false,
  blocked: false,
};

test('openTicketRow lays out all thirteen columns in DIGEST_OPEN_HEADERS order', () => {
  const row = openTicketRow(SAMPLE_REQ, SAMPLE_CTX);
  assert.equal(row.length, DIGEST_OPEN_HEADERS.length, 'one cell per header');
  assert.deepEqual(row, [
    'pardes', 'R-42', 'נזילה מתחת לכיור', 'מאושר', '2026-08-01', '2026-08-05T09:00:00.000Z',
    7, false, false,
    'תיקון', 'דחוף', 'מטבח — ליד הכיור', '2026-09-01',
  ]);
});

test('openTicketRow: the appended columns carry the scrubbed request facts at 10/11/12/13', () => {
  const row = openTicketRow(SAMPLE_REQ, SAMPLE_CTX);
  const at = (name) => row[DIGEST_OPEN_HEADERS.indexOf(name)];
  assert.equal(at('category'), 'תיקון');
  assert.equal(at('urgency'), 'דחוף');
  // Money scrubbed AND single-lined (250 שח removed, newline collapsed).
  assert.equal(at('location_in_house'), 'מטבח — ליד הכיור');
  // deferred_date carries Requests.deferred_until (this request is deferred).
  assert.equal(at('deferred_date'), '2026-09-01');
});

test('openTicketRow: deferred_date is empty when the request was never deferred', () => {
  const notDeferred = { id: 'R-7', description: 'צביעה', status: 'מאושר' }; // no deferred_until
  const row = openTicketRow(notDeferred, SAMPLE_CTX);
  assert.equal(row[DIGEST_OPEN_HEADERS.indexOf('deferred_date')], '');
  // an explicit blank string is equally empty
  const blank = openTicketRow({ id: 'R-8', deferred_until: '' }, SAMPLE_CTX);
  assert.equal(blank[DIGEST_OPEN_HEADERS.indexOf('deferred_date')], '');
});

test('openTicketRow: deferred_date is a stable YYYY-MM-DD, even from a real Date value', () => {
  const at = (row) => row[DIGEST_OPEN_HEADERS.indexOf('deferred_date')];
  // A real Date object (how Apps Script reads a date cell) must normalize, not serialize to a locale string.
  const fromDate = openTicketRow({ id: 'R-9', status: 'נדחה לתאריך', deferred_until: new Date('2026-09-01T00:00:00.000Z') }, SAMPLE_CTX);
  assert.equal(at(fromDate), '2026-09-01');
  assert.doesNotMatch(at(fromDate), /[A-Za-z]/, 'never a raw Date serialization');
  // An ISO timestamp string collapses to the date part.
  const fromIso = openTicketRow({ id: 'R-10', status: 'נדחה לתאריך', deferred_until: '2026-09-01T09:30:00.000Z' }, SAMPLE_CTX);
  assert.equal(at(fromIso), '2026-09-01');
});

test('openTicketRow: the existing nine columns are byte-identical to the legacy assembly', () => {
  // Guards existing consumers: adding the three columns must not perturb columns 1-9 for any input.
  const row = openTicketRow(SAMPLE_REQ, SAMPLE_CTX);
  const legacyFirstNine = [
    SAMPLE_CTX.house,
    String(SAMPLE_REQ.id),
    formatTitle(SAMPLE_REQ.description),
    String(SAMPLE_REQ.status),
    SAMPLE_CTX.openedDate,
    SAMPLE_CTX.updatedAt,
    SAMPLE_CTX.daysOpen,
    SAMPLE_CTX.overdue,
    SAMPLE_CTX.blocked,
  ];
  assert.deepEqual(row.slice(0, 9), legacyFirstNine);
  // title still money-scrubbed + capped exactly as before.
  assert.equal(row[2], 'נזילה מתחת לכיור');
});

test('openTicketRow tolerates missing fields — blanks, never a thrown error or a leaked undefined', () => {
  const row = openTicketRow({ id: 'R-1', status: 'דרישה' }, { house: 'sde-eliezer' });
  assert.equal(row.length, 13);
  assert.equal(row[DIGEST_OPEN_HEADERS.indexOf('category')], '');
  assert.equal(row[DIGEST_OPEN_HEADERS.indexOf('urgency')], '');
  assert.equal(row[DIGEST_OPEN_HEADERS.indexOf('location_in_house')], '');
  assert.equal(row[DIGEST_OPEN_HEADERS.indexOf('deferred_date')], ''); // missing deferred_until → ''
  assert.equal(row[DIGEST_OPEN_HEADERS.indexOf('daysOpen')], '');   // null daysOpen → '' (unchanged rule)
  assert.equal(row[1], 'R-1');
});

test('the Apps Script writer builds rows via digestOpenTicketRow_ and appends the scrubbed fields', () => {
  // Source-level mirror check: the writer delegates row layout to digestOpenTicketRow_ and that builder
  // scrubs category / urgency / location_in_house, and normalizes deferred_date (so the .gs path matches
  // the tested pure openTicketRow).
  const gs = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8');
  assert.ok(/rows\.push\(digestOpenTicketRow_\(req,/.test(gs), 'buildOpenTicketRows_ delegates to digestOpenTicketRow_');
  assert.ok(/digestScrubField_\(r\.category\)/.test(gs), 'category is scrubbed');
  assert.ok(/digestScrubField_\(r\.urgency\)/.test(gs), 'urgency is scrubbed');
  assert.ok(/digestScrubField_\(r\.location_in_house\)/.test(gs), 'location_in_house is scrubbed');
  // deferred_date is date-normalized (YYYY-MM-DD), NOT scrubbed as free text (would leak a raw Date).
  assert.ok(/digestDateOnly_\(r\.deferred_until\)/.test(gs), 'deferred_date normalizes deferred_until to YYYY-MM-DD');
});

test('the Apps Script writer gates OpenTickets by the retention-aware filter (self-cleaning)', () => {
  // Source-level mirror check: the digest filters via digestIncludeTicket_ (not the old status-only
  // filter), reads the retention window from Config archive_after_days, and passes it in.
  const gs = readFileSync(join(root, 'apps-script/digest.gs'), 'utf8');
  assert.ok(/digestIncludeTicket_\(req,\s*now,\s*retentionDays\)/.test(gs), 'the row loop uses digestIncludeTicket_');
  assert.ok(/getConfig\(['"]archive_after_days['"]\)/.test(gs), 'retention window reuses archive_after_days');
  assert.ok(/DIGEST_TERMINAL_STATUSES_\s*=\s*\[\s*['"]הושלם['"]\s*,\s*['"]סגור['"]\s*\]/.test(gs), 'terminal statuses mirror src');
});
