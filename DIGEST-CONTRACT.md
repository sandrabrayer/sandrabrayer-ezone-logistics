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
raanana-asher (רעננה אשר) · raanana-hapardes (רעננה הפרדס) · caesarea-ofroni (עפרוני קיסריה) ·
caesarea-rehab (ריהאב קיסריה) · sde-eliezer (שדה אליעזר). רעננה הפרדס and שדה אליעזר are
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
Included when status is NOT 'סגור' and NOT 'לא מאושר'.

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
