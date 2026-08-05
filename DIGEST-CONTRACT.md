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
  1 house            house id
  2 ticketId         Requests.id
  3 title            Requests.description, single line, <=80 chars, scrubbed
  4 status           Hebrew status, as stored
  5 openedDate       YYYY-MM-DD, from Requests.created_at
  6 updatedAt        ISO 8601 UTC, latest AuditLog row, fallback created_at
  7 daysOpen         integer; created_at → now, or → completed_at once completed (increment 36)
  8 overdue          boolean; due_at passed and not completed/closed/deferred (increment 36)
  9 blocked          boolean; the manual block flag (increment 36)
Included when status is NOT 'סגור' and NOT 'לא מאושר'. Columns 7-9 are aging facts (non-financial);
due_at itself and blocked_reason are NOT published.

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

--- FROZEN CONTRACT — DIGEST CONSUME (v2) ---

The direction above is what Logistics PUBLISHES. This section is what Logistics CONSUMES: two
inbound, READ-ONLY digests published by OTHER apps that the /management screen will read. As of PR B
non-food inventory COUNTING moved to the Coordinators app (food already lives in ezone-kitchen), so
Logistics stops OWNING those counts and instead READS them. This is a contract definition only — the
read wiring is NOT implemented yet (no code reads these tabs today). When wired, the reads obey the
same discipline as the export above: read WEEKLY, columns resolved BY HEADER NAME (never index),
NO financial fields consumed, and a house whose id does not map is OMITTED (never guessed).

Inbound A — Coordinators digest, tab WeeklyNonFoodCounts — the weekly non-food (טואלטיקה / חומרי ניקוי)
counts the coordinators now own. Columns Logistics reads by header name:
  house         house id (canonical, shared namespace; unmapped → omitted)
  weekStart     YYYY-MM-DD, Sunday (Israeli week)
  status        'בוצעה' / 'לא בוצעה'
  shortagesSummary  text, below-par items (may be ""); NON-financial
  updatedAt     ISO 8601 UTC
Read the LATEST row per house+week. No quantities/costs/budgets are consumed — only the status and the
scrubbed shortage summary. A missing tab / id renders the panel "לא זמין", never fabricated counts.

Inbound B — Kitchen digest, tab FoodShortages — the food shortages ezone-kitchen owns. Columns read by
header name:
  house         house id (canonical; unmapped → omitted)
  item          Hebrew item name
  weekStart     YYYY-MM-DD, Sunday (optional; when present, read the latest week)
  updatedAt     ISO 8601 UTC (optional)
Read WEEKLY. Only shortage facts (house + item) are consumed — NO quantities, par, budget, or any
financial field. Grant the Logistics Apps Script account VIEWER access for the read to work; a blank
id or missing tab renders "לא זמין".

INVARIANTS (consume): read-only (Logistics never writes these tabs); NO financial fields consumed,
ever; columns read BY HEADER NAME, not index (append-only on the publisher side); unmapped houses are
omitted, never guessed; a missing/inaccessible source renders "לא זמין", never a fabricated number.
This is v2-compatible: it ADDS a consume contract without changing any published column above.
