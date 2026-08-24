// src/digest.js — pure logic for the read-only coordinators digest export.
// Dependency-free; every function here is mirrored verbatim in apps-script/digest.gs
// (the Apps Script side is the real writer — this file exists so the logic is unit-tested
// under `node --test`, and so the two copies can't silently drift).
//
// The digest is a SEPARATE spreadsheet holding exactly two tabs (OpenTickets, WeeklyCounts)
// and NO financial fields, ever. See DIGEST-CONTRACT.md for the frozen schema.

// ---- House id map ----
// ALL SIX houses (increment 33). הפרדס (pardes) OPENED in Aug 2026 and is a regular open house;
// שדה אליעזר (sde-eliezer) is still pre-opening but already has activity, so it appears in the
// digest too — a gap shows as 'לא בוצעה', which is the honest state, rather than the house being
// invisible. Consumers (ezone-coordinators) key on the id 'pardes' — see DIGEST-CONTRACT.md. Any
// house name that does not map is still OMITTED, never guessed.
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
// apps-script/digest.gs. daysOpen / overdue / blocked appended in increment 36; category / urgency /
// location_in_house appended after them; deferred_date appended after those (this change, read by the
// Coordinators app's PR #125 under that exact header name). No financial fields — every appended column
// is a non-financial request fact, money-scrubbed like `title` before it is published.
export const DIGEST_OPEN_HEADERS = [
  'house', 'ticketId', 'title', 'status', 'openedDate', 'updatedAt', 'daysOpen', 'overdue', 'blocked',
  'category', 'urgency', 'location_in_house', 'deferred_date',
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

// ---- Active-ticket filter (status only) ----
// A status-only classification: 'סגור' (closed) and 'לא מאושר' (not approved) are the non-active
// statuses; everything else — דרישה / ממתין לאישור / מאושר / נדחה לתאריך / בביצוע / הושלם — is an active
// status. NOTE: the digest's REAL inclusion gate is `isDigestTicket` below (retention-aware) — this
// helper stays as the plain status predicate other callers/tests use.
export const EXCLUDED_TICKET_STATUSES = ['סגור', 'לא מאושר'];

/** True when this status is an active (non-closed, non-rejected) status. */
export function isActiveTicket(status) {
  return EXCLUDED_TICKET_STATUSES.indexOf(String(status == null ? '' : status).trim()) === -1;
}

// ---- Digest inclusion (retention-aware self-cleaning) ----
// What actually appears in OpenTickets:
//   - 'לא מאושר' (rejected) → shown only for a RETENTION WINDOW after the rejection (keyed off
//     Requests.rejected_at), then DROPS OUT. A coordinator still sees what a manager just turned down —
//     a decision they may want to see or revisit — but old rejections don't pile up.
//   - terminal completions ('הושלם' / 'סגור') → shown only for a RETENTION WINDOW after completion
//     (keyed off Requests.completed_at), then they DROP OUT so the list self-cleans. So a coordinator
//     still sees what just finished, but old completions don't pile up.
//   - everything else (active work) → always shown.
// Both self-cleaning classes reuse the SAME window (Config.archive_after_days, default 7). A rejected or
// terminal ticket with no parseable resolution date is kept visible (we don't hide what we can't age,
// same rule as the dashboard archive). Mirror of digestIncludeTicket_ in apps-script/digest.gs.
export const REJECTED_TICKET_STATUS = 'לא מאושר';
export const TERMINAL_TICKET_STATUSES = ['הושלם', 'סגור'];
export const DIGEST_RETENTION_DAYS_DEFAULT = 7;

/**
 * True when a request belongs in OpenTickets right now.
 * @param {object} req request row (reads .status, .completed_at, .rejected_at)
 * @param {number|string|Date} now current instant (Date, ms, or ISO string)
 * @param {number} retentionDays how long a rejected / completed / closed ticket lingers (Config archive_after_days; default 7)
 */
export function isDigestTicket(req, now, retentionDays) {
  const r = req || {};
  const status = String(r.status == null ? '' : r.status).trim();
  const rejected = status === REJECTED_TICKET_STATUS;
  const terminal = TERMINAL_TICKET_STATUSES.indexOf(status) !== -1;
  if (!rejected && !terminal) return true;                          // active → always shown
  // Rejected / completed / closed: shown only within the retention window after the resolution. Rejected
  // ages off its rejection timestamp; completed/closed off completion — same window, same undateable rule.
  const raw = rejected ? r.rejected_at : r.completed_at;
  if (raw == null || String(raw).trim() === '') return true;        // undateable resolution → keep visible
  const finished = new Date(raw).getTime();
  if (Number.isNaN(finished)) return true;
  const nowMs = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : new Date(now).getTime());
  if (Number.isNaN(nowMs)) return true;
  let n = Number(retentionDays);
  if (!Number.isFinite(n) || n <= 0) n = DIGEST_RETENTION_DAYS_DEFAULT;
  return Math.floor((nowMs - finished) / 86400000) <= n;            // within window → shown; older → dropped
}

// ---- Stable date normalization (YYYY-MM-DD) ----
// Reduce a date-ish value to a stable 'YYYY-MM-DD' string so consumers parse it reliably — never a raw
// Date serialization ("Mon Sep 01 2026 …"). A value already starting 'YYYY-MM-DD' is taken verbatim (no
// timezone shift); a Date / other parseable form is reduced via ISO; blank / unparseable → ''.
// NOTE: the Apps Script mirror digestDateOnly_ formats bare Date objects in the SCRIPT timezone (not UTC),
// because a Sheet date cell is midnight in that zone and a UTC reduction would shift the day back one. The
// real deferred_until data is a 'YYYY-MM-DD' string (from the dashboard's date input), which BOTH sides
// take verbatim — so they agree on live data; the Date branch differs only to stay correct per source.
export function dateOnly(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
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

// ---- Scrubbed passthrough fields (category / urgency / location_in_house) ----
// The three columns appended to OpenTickets are non-financial request facts. They go through the SAME
// money scrubber as the title (the contract invariant: no price ever leaks into a readable field) and
// are flattened to a single line, but they are NOT length-capped — category and urgency are short
// controlled values and location_in_house is a short free-text hint. null / '' → ''.

/** An OpenTickets passthrough field: money-scrubbed and single-lined, like `title` but uncapped. */
export function scrubField(value) {
  return scrubMoney(String(value == null ? '' : value).replace(/\s+/g, ' '));
}

// ---- OpenTickets row assembly ----
// One place that fixes the OpenTickets column ORDER, so the frozen contract and the Apps Script writer
// (apps-script/digest.gs buildOpenTicketRows_) can never drift. Pure: the writer resolves the house id,
// dates and aging facts from the sheets and passes them in `ctx`; here we only lay them out + scrub the
// request-derived text. Mirror of digestOpenTicketRow_ in apps-script/digest.gs.

/**
 * Build ONE OpenTickets row as a flat array in DIGEST_OPEN_HEADERS order.
 * @param {object} req request row (reads .id, .description, .status, .category, .urgency, .location_in_house, .deferred_until)
 * @param {object} ctx sheet-resolved facts: { house, openedDate, updatedAt, daysOpen, overdue, blocked }
 */
export function openTicketRow(req, ctx) {
  const r = req || {};
  const c = ctx || {};
  return [
    c.house,
    String(r.id == null ? '' : r.id),
    formatTitle(r.description),
    String(r.status == null ? '' : r.status),
    c.openedDate,
    c.updatedAt,
    c.daysOpen == null ? '' : c.daysOpen,
    c.overdue,
    c.blocked,
    // ---- APPENDED: non-financial request facts, scrubbed like title ----
    scrubField(r.category),
    scrubField(r.urgency),
    scrubField(r.location_in_house),
    // deferred_date: Requests.deferred_until normalized to a stable 'YYYY-MM-DD' string (never a raw Date
    // serialization), blank when the request was never deferred. The Coordinators app (PR #125) reads it
    // here and parses the date — so the format must be stable, not a locale/Date .toString().
    dateOnly(r.deferred_until),
  ];
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
