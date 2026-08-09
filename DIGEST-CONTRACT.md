# Digest export — frozen contract (v2)

The Logistics app publishes a **read-only digest** so the coordinators app can consume
Logistics data with **zero access to financial fields**. The digest lives in a **separate
spreadsheet** (not the main Logistics sheet — Google Sheets sharing is per-file, not per-tab,
so digest tabs in the main sheet would expose `estimated_cost` / `actual_cost`). The digest
file holds **exactly two tabs and nothing else**. Viewer access is granted to
`brayersandra@gmail.com` only.

This app (`apps-script/digest.gs`) is the **sole writer** of these tabs. Do **not** touch the
coordinators repo.

--- FROZEN CONTRACT ---

House ids (v2, increment 33 — all six houses): ramot-hashavim (רמות השבים) ·
raanana-asher (רעננה אשר) · pardes (רעננה הפרדס) · caesarea-ofroni (קיסריה עפרוני) ·
caesarea-rehab (קיסריה ריהאב) · sde-eliezer (שדה אליעזר). רעננה הפרדס and שדה אליעזר are
pre-opening but already have activity, so they are included — a gap surfaces as 'לא בוצעה'
rather than the house being invisible. Houses that do not map are omitted, never guessed. Display
names are the canonical forms from HOUSE-IDS.md (the single source). The house-id vocabulary is
SHARED with ezone-kitchen so all E-Zone apps key houses on one namespace; ids apply at the digest
boundary only (Logistics keys on the Hebrew name internally).

Tab OpenTickets — columns in this exact order:
   1 house             house id
   2 ticketId          Requests.id
   3 title             Requests.description, single line, <=80 chars, scrubbed
   4 status            Hebrew status, as stored
   5 openedDate        YYYY-MM-DD, from Requests.created_at
   6 updatedAt         ISO 8601 UTC, latest AuditLog row, fallback created_at
   7 daysOpen          integer; created_at → now, or → completed_at once completed (increment 36)
   8 overdue           boolean; due_at passed and not completed/closed/deferred (increment 36)
   9 blocked           boolean; the manual block flag (increment 36)
  10 category          Requests.category (רכישה / תיקון / החלפה), single line, scrubbed
  11 urgency           Requests.urgency (רגיל / דחוף / חירום), single line, scrubbed
  12 location_in_house Requests.location_in_house, single line, scrubbed
  13 deferred_date     Requests.deferred_until, single line, scrubbed; empty when not deferred
Included when status is NOT 'סגור' and NOT 'לא מאושר'. Columns 7-9 are aging facts (non-financial);
due_at itself and blocked_reason are NOT published. Columns 10-13 are non-financial request facts,
APPENDED after the aging columns and money-scrubbed exactly like `title` (no price ever leaks); they
are NOT length-capped. Column 13 (deferred_date) is empty for any request that was never deferred.
estimated_cost / actual_cost remain unpublished.

Tab WeeklyCounts — columns in this exact order:
  1 house              house id
  2 weekStart          YYYY-MM-DD, Sunday (Israeli week)
  3 status             'בוצעה' / 'לא בוצעה'
  4 shortagesSummary   text, scrubbed, "" when none; below-par items + base unit + notes
  5 updatedAt          ISO 8601 UTC
Always emit 6 houses x last 8 weeks (48 rows) so gaps surface as 'לא בוצעה'.

Inventory is WEEKLY (shipped increment 26): each InventoryCounts row carries week_start
(the Sunday of the Israeli week). status is 'בוצעה' whenever a Logistics count exists for
that house+week. A shortage is BELOW PAR (increment 33): par_base set on the item AND the
latest counted quantity_base strictly below it — the same meaning ezone-kitchen uses, not
"already at zero". Only the latest submission per house+week is compared. If the week_start
column is somehow absent (pre-migration sheet), every row emits 'לא בוצעה' with an empty
shortagesSummary — we never fabricate weekly data.

INVARIANTS: no financial fields, ever. Columns are append-only — never reorder
or remove. Consumers read by header name, not index.

--- WHAT LOGISTICS CONSUMES (v2, read-only) ---

Symmetric to the publish contract above: as of PR B, **non-food inventory counting moved OUT of
Logistics to the Coordinators app** (food already lives in ezone-kitchen). Logistics therefore stops
being the source for those numbers and instead **reads** them from the other apps' digests. This
section is the FROZEN contract for that consumption. It is **specification only** — the read wiring is a
later increment; nothing here reads a foreign sheet yet. It is v2-compatible: additive, and it changes
none of the published tabs above.

General consume rules (identical discipline to the publish side):
- **Read WEEKLY**, on the same Sunday-based Israeli week (`weekStart` = YYYY-MM-DD, Sunday).
- **Columns are read BY HEADER NAME, never by index** — a producer may append columns freely; order is
  irrelevant; a missing REQUIRED header means the panel is unavailable, never a fabricated 0.
- **House ids use the shared namespace** (HOUSE-IDS.md): ramot-hashavim · raanana-asher · pardes ·
  caesarea-ofroni · caesarea-rehab · sde-eliezer. A row whose house id is **not** in that map is
  **omitted, never guessed**.
- **No financial fields are read, ever** — if a producer adds a cost/amount column, Logistics ignores it.
- A digest that is unconfigured / unreadable / missing its tab is reported as unavailable with a reason —
  never rendered as zero.

Source A — **Coordinators digest: weekly non-food counts** (replaces the retired Logistics count form).
  Read the coordinators-published tab of weekly non-food (toiletries + cleaning) counts per house+week.
  REQUIRED headers (by name): `house` (shared id), `weekStart` (YYYY-MM-DD Sunday),
  `status` ('בוצעה' / 'לא בוצעה'). OPTIONAL: `shortagesSummary` (scrubbed text; below-par items), a
  producer `updatedAt`. Only the latest submission per house+week is used. Absent house+week → 'לא בוצעה'.
  No quantities are interpreted as money; no financial column is read.

Source B — **Kitchen digest: food shortages** (already partially specified by the kitchen contract).
  Read the ezone-kitchen `FoodShortages` tab. House header read by name from the tolerated set
  `house` / `house_id` / `houseId` / `houseID`; item header from `item` / `item_text` / `itemName` /
  `product` / `name` (see `summarizeFoodShortages`). Each row is one shortage item for a house; unmapped
  houses omitted. Missing the house OR item header entirely → unavailable (never a fabricated shape/0).
  Read weekly, read-only, no financial fields.
