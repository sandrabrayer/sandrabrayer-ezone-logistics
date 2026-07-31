// test/digest.test.js — locks the pure logic behind the coordinators digest export.
// These helpers are mirrored verbatim in apps-script/digest.gs (Apps Script is the writer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUSE_IDS, DIGEST_HOUSE_IDS, houseId,
  EXCLUDED_TICKET_STATUSES, isActiveTicket,
  scrubMoney, truncateTitle, formatTitle, TITLE_MAX,
  weekStart, recentWeekStarts,
  isShortage, shortageLabel, buildWeeklyGrid,
  DIGEST_OPEN_HEADERS,
} from '../src/digest.js';

// ---- OpenTickets columns (increment 36: aging appended) ----

test('OpenTickets carries daysOpen / overdue / blocked, appended after the original six', () => {
  assert.deepEqual(DIGEST_OPEN_HEADERS, [
    'house', 'ticketId', 'title', 'status', 'openedDate', 'updatedAt', 'daysOpen', 'overdue', 'blocked',
  ]);
  // The original six keep their positions; the three aging columns are appended last.
  assert.deepEqual(DIGEST_OPEN_HEADERS.slice(0, 6),
    ['house', 'ticketId', 'title', 'status', 'openedDate', 'updatedAt']);
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
