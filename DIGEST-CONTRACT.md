# Digest export — frozen contract

The Logistics app publishes a **read-only digest** so the coordinators app can consume
Logistics data with **zero access to financial fields**. The digest lives in a **separate
spreadsheet** (not the main Logistics sheet — Google Sheets sharing is per-file, not per-tab,
so digest tabs in the main sheet would expose `estimated_cost` / `actual_cost`). The digest
file holds **exactly two tabs and nothing else**. Viewer access is granted to
`brayersandra@gmail.com` only.

This app (`apps-script/digest.gs`) is the **sole writer** of these tabs. Do **not** touch the
coordinators repo.

--- FROZEN CONTRACT ---

House ids: raanana (רעננה) · ramot (רמות השבים) · efroni (קיסריה עפרוני) ·
rehab (ריהאב). הפרדס and שדה אליעזר are excluded (pre-opening, no coordinator).
Houses that do not map are omitted, never guessed.

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
  4 shortagesSummary   text, scrubbed, "" when none; items at qty 0 + notes
  5 updatedAt          ISO 8601 UTC
Always emit 4 houses x last 8 weeks so gaps surface as 'לא בוצעה'.

NOTE: inventory is currently MONTHLY (increment 25); weekly counts are not
built yet. Read an optional week_start column if present; until it exists,
emit every row as 'לא בוצעה' with an empty shortagesSummary. Do not fabricate
weekly data from monthly counts.

INVARIANTS: no financial fields, ever. Columns are append-only — never reorder
or remove. Consumers read by header name, not index.
