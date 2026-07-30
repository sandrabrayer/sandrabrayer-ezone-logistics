// src/digest.js — pure logic for the read-only coordinators digest export.
// Dependency-free; every function here is mirrored verbatim in apps-script/digest.gs
// (the Apps Script side is the real writer — this file exists so the logic is unit-tested
// under `node --test`, and so the two copies can't silently drift).
//
// The digest is a SEPARATE spreadsheet holding exactly two tabs (OpenTickets, WeeklyCounts)
// and NO financial fields, ever. See DIGEST-CONTRACT.md for the frozen schema.

// ---- House id map ----
// ALL SIX houses (increment 33). הפרדס (pardes) and שדה אליעזר (sde-eliezer) are
// pre-opening but already have activity, so they now appear in the digest — a gap shows as
// 'לא בוצעה', which is the honest state, rather than the house being invisible. Any house name
// that does not map is still OMITTED, never guessed.
//
// Keys are the CANONICAL Hebrew display names (HOUSE-IDS.md); values are the FROZEN ids, shared
// with ezone-kitchen so every E-Zone app keys houses on one namespace. The id — never the Hebrew
// name — is what the digest emits and what consumers key on. The map applies at the digest boundary
// only; inside Logistics, Requests.house / Inspections.house / InventoryCounts.house carry the name.
export const HOUSE_IDS = {
  'רמות השבים': 'ramot-hashavim',
  'רעננה אשר': 'raanana-asher',
  'רעננה הפרדס': 'pardes',
  'קיסריה עפרוני': 'caesarea-ofroni',
  'קיסריה ריהאב': 'caesarea-rehab',
  'שדה אליעזר': 'sde-eliezer',
};

// The digest's six house ids, in their canonical (WeeklyCounts) order — the HOUSE-IDS.md table order.
export const DIGEST_HOUSE_IDS = [
  'ramot-hashavim', 'raanana-asher', 'pardes', 'caesarea-ofroni', 'caesarea-rehab', 'sde-eliezer',
];

// The OpenTickets tab columns, in order (append-only). Mirror of DIGEST_OPEN_HEADERS_ in
// apps-script/digest.gs. daysOpen / overdue / blocked appended in increment 36. No financial fields.
export const DIGEST_OPEN_HEADERS = [
  'house', 'ticketId', 'title', 'status', 'openedDate', 'updatedAt', 'daysOpen', 'overdue', 'blocked',
];

/** Map a stored Hebrew house name to its digest id, or null when it does not map. */
export function houseId(name) {
  if (name == null) return null;
  const key = String(name).trim();
  return Object.prototype.hasOwnProperty.call(HOUSE_IDS, key) ? HOUSE_IDS[key] : null;
}

// ---- Shortage = below par (increment 33) ----
// A shortage is `par_base` SET and the counted `quantity_base` strictly below it. An item counted
// at 0 with a par is a shortage; counted at 0 with no par is not; never counted is never a shortage
// (there is no row, so isShortage is never even asked about it). This is the SAME meaning of
// "shortage" ezone-kitchen uses (below-par, early warning) — no longer "already at zero".

/** True when parBase is a real target and quantityBase is a real number strictly below it. */
export function isShortage(quantityBase, parBase) {
  if (parBase == null || parBase === '') return false;
  const p = Number(parBase);
  if (!Number.isFinite(p)) return false;
  // A blank / missing base qty is "not counted in base terms" — NOT a zero (Number('') is 0, which
  // would falsely read as a shortage). Guard it before coercion.
  if (quantityBase == null || quantityBase === '') return false;
  const q = Number(quantityBase);
  if (!Number.isFinite(q)) return false;         // no comparable base qty → not a shortage
  return q < p;
}

/**
 * One shortage's summary text, base unit included so the number is readable — e.g.
 * "שקיות אשפה: 40/200 unit". An optional note is appended in parentheses. The digest still runs
 * this through the money scrubber before publishing.
 */
export function shortageLabel(item, quantityBase, parBase, baseUnit, note) {
  const unit = baseUnit ? ' ' + baseUnit : '';
  let s = String(item == null ? '' : item) + ': ' + quantityBase + '/' + parBase + unit;
  const n = String(note == null ? '' : note).trim();
  if (n) s += ' (' + n + ')';
  return s;
}

/**
 * Build the WeeklyCounts rows: every house in DIGEST_HOUSE_IDS × every week, so a gap surfaces
 * rather than hides. `bucketByKey` maps 'houseId|weekStart' → { shortagesSummary, updatedAt } for
 * house/weeks that HAVE a count; missing keys emit a 'not done' row. Kept pure (no sheet access) so
 * the six-houses-×-weeks shape is unit-tested; apps-script/digest.gs builds the buckets and calls it.
 */
export function buildWeeklyGrid(bucketByKey, weeks, nowIso, doneLabel, notDoneLabel) {
  const rows = [];
  for (const house of DIGEST_HOUSE_IDS) {
    for (const wk of weeks || []) {
      const b = bucketByKey ? bucketByKey[house + '|' + wk] : null;
      if (b) rows.push([house, wk, doneLabel, b.shortagesSummary || '', b.updatedAt || nowIso]);
      else rows.push([house, wk, notDoneLabel, '', nowIso]);
    }
  }
  return rows;
}

// ---- Active-ticket filter ----
// A ticket is included in OpenTickets when its status is NOT 'סגור' (closed) and NOT
// 'לא מאושר' (not approved). Everything else — דרישה / ממתין לאישור / מאושר / נדחה לתאריך /
// בביצוע / הושלם — is an open, actionable ticket a coordinator should see.
export const EXCLUDED_TICKET_STATUSES = ['סגור', 'לא מאושר'];

/** True when a ticket with this status belongs in the OpenTickets tab. */
export function isActiveTicket(status) {
  return EXCLUDED_TICKET_STATUSES.indexOf(String(status == null ? '' : status).trim()) === -1;
}

// ---- Money scrubber ----
// Strip currency markers (₪, ש"ח, שח, NIS, ILS) together with any digit group adjacent to
// them, so no price ever leaks into a text field the coordinators can read. BARE quantities
// (a number with no currency marker) are counts, not prices, and are left untouched.
//
// Word-token markers (שח / NIS / ILS) are guarded so they are only stripped as standalone
// tokens — e.g. "שח" inside a Hebrew word like "משחק", or "NIS" inside "TENNIS", is never
// touched. The unambiguous symbols (₪ and the quoted ש"ח / ש״ח) need no such guard.
const MONEY_RE = new RegExp(
  '(?:\\d+(?:[.,]\\d+)*\\s*)?' +                                   // optional leading number
  '(?:₪|ש"ח|ש״ח|(?<![א-ת])שח(?![א-ת])|(?<![A-Za-z])(?:NIS|ILS)(?![A-Za-z]))' + // a currency marker
  '(?:\\s*\\d+(?:[.,]\\d+)*)?',                                    // optional trailing number
  'gi',
);

/** Remove currency markers and their adjacent digit groups; bare counts stay. */
export function scrubMoney(text) {
  if (text == null) return '';
  return String(text)
    .replace(MONEY_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---- Title truncation ----
// A ticket title is Requests.description, flattened to a single line and capped at maxLen
// characters. When it overflows, the last kept character is replaced by an ellipsis so the
// result is exactly maxLen characters (never MORE than the cap).
export const TITLE_MAX = 80;

/** Collapse to a single line and truncate to maxLen chars (ellipsis when cut). */
export function truncateTitle(text, maxLen) {
  const max = maxLen == null ? TITLE_MAX : maxLen;
  const oneLine = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, Math.max(0, max - 1)) + '…';
}

/** The OpenTickets `title`: description, money-scrubbed, single line, <=80 chars. */
export function formatTitle(description, maxLen) {
  return truncateTitle(scrubMoney(description), maxLen);
}

// ---- Sunday week-start (Israeli week) ----
// The Israeli week starts on Sunday. Given any date, return the YYYY-MM-DD of the Sunday
// that begins its week. Computed in UTC so the result is deterministic and test-stable.
// Accepts a Date or any string a Date can parse (ISO timestamp, 'YYYY-MM-DD', …).
export function weekStart(date) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // getUTCDay: 0 = Sunday
  return d.toISOString().slice(0, 10);
}

/**
 * The last `n` Sunday week-starts up to and including the week containing `now`,
 * MOST-RECENT FIRST: index 0 is the current week, index n-1 is (n-1) weeks ago.
 * Returns an array of YYYY-MM-DD strings.
 */
export function recentWeekStarts(now, n) {
  const count = Number(n) || 0;
  const base = weekStart(now);
  if (!base || count <= 0) return [];
  const out = [];
  const d = new Date(base + 'T00:00:00Z');
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return out;
}
