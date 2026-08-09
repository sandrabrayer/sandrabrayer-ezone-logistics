# DIGEST-CONTRACT.md — the OpenTickets digest inclusion rule (E-ZONE Logistics)

**Status:** canonical for this repo. The digest is a cross-repo concept in the E-ZONE family; this
file governs which **Logistics** requests appear in it. The implementation lives in two mirrored
places that must never drift:

- `src/digest.js` — pure, testable rule (the source of truth), locked by `test/digest.test.js`.
- `apps-script/Code.gs` — `digestIncludeTicket_` / `getDigest`, mirroring the same rule, served at
  `?action=digest`.

Ids in every digest entry are canonical house ids — see `HOUSE-IDS.md`.

## What the digest is

The **OpenTickets digest** is the outbound summary a coordinator sees: every request that still
deserves attention. Two kinds of rows appear:

1. **Live requests** — still in flight. Always in the digest, no aging.
2. **Recently-terminal requests** — finished, but kept for a short **grace window** so the outcome
   is actually seen before it becomes archive-only.

A request that is terminal and older than the grace window **drops out** of the digest (it still
exists in the sheet and audit log — it is archive-only, not deleted).

## The rule

```
isDigestTicket(req, now, archive_after_days):
  live status        → always included
  terminal status    → included while age(req) < archive_after_days, else dropped
  anything else      → excluded
```

### Status classes

| Class | Statuses (stored Hebrew value) | In the digest? |
|---|---|---|
| **Live** | `דרישה` (request), `ממתין לאישור` (pending), `מאושר` (approved), `נדחה לתאריך` (deferred), `בביצוע` (in progress) | Always |
| **Archiving** | `הושלם` (completed), `סגור` (closed), **`לא מאושר` (rejected)** | For `archive_after_days` days, then dropped |
| Unknown / missing | anything else | Never |

### Aging anchor (when the clock starts)

| Status | Anchor timestamp | Fallbacks (in order) |
|---|---|---|
| `לא מאושר` (rejected) | `rejected_at` | `updated_at` → `created_at` |
| `הושלם` / `סגור` (completed / closed) | `completed_at` | `updated_at` → `created_at` |

The fallbacks exist so a row written before a dedicated timestamp field existed never silently
vanishes. **Fail-safe:** if no anchor timestamp can be resolved or parsed, the request stays
**visible** rather than disappearing.

### The window boundary

A terminal request is visible **for** `archive_after_days` days and drops out once its age reaches
the window: visible while `age < archive_after_days`, gone at `age >= archive_after_days`. The
window is the `archive_after_days` **Config** key (default **7**), typed as a number via
`src/config.js`. It is never hardcoded.

## Rejected requests (the retention rule)

Rejected (`לא מאושר`) requests **remain in the digest for `archive_after_days` days after
rejection — the same grace window as completed and closed — then drop out.** They do **not**
disappear the instant a request is denied.

**Why:** a coordinator must *see* that their request was denied. Silent disappearance reads as "lost"
or "still pending", not "rejected". The grace window guarantees the denial is surfaced — and it is
surfaced in **red** (`digestStatusTone('לא מאושר') === 'red'`), so it reads as denied at a glance —
before the row becomes archive-only.

The rejection timestamp comes from `rejected_at`, stamped by the `reject` action in `Code.gs` at the
moment of rejection (falling back to `updated_at` / `created_at` for older rows).

### Display tone

The digest renders each status with a tone (mirrors the dashboard palette):

| Status | Tone |
|---|---|
| `לא מאושר` (rejected) | **red** |
| `נדחה לתאריך` (deferred) | amber |
| `הושלם` / `סגור` (completed / closed) | green |
| all live statuses | neutral |

## Consumer contract

- Read the digest from `?action=digest` (already filtered) — do not re-implement the rule downstream.
- Treat house ids as canonical (`HOUSE-IDS.md`); map legacy ids at the read boundary.
- If you must evaluate the rule yourself, import `isDigestTicket` from `src/digest.js`. Do not fork it.

## Changelog

- **2026-08** — Rejected (`לא מאושר`) now lingers for `archive_after_days` days after rejection with
  its red status, then drops out — instead of leaving the digest immediately. Aging anchored on
  `rejected_at`. Added the `archive_after_days` Config key (default 7) and the `rejected_at` column.
