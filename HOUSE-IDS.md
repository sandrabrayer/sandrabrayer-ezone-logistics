# HOUSE-IDS.md — canonical house identifiers and display names (E-ZONE)

**Status:** canonical. This file is identical in every E-ZONE repo. Do not edit one copy —
change it here, then propagate the same content to all repos in the same batch.

Two things live in this file and they are **not** the same thing:

- **Display name** — what a user sees on screen and in exports. Unified across all apps.
- **Id** — the internal key used in sheets, digests, and payloads. Never shown to users.
  Ids are frozen; renaming one is a data migration across repos.

## Canonical table

| Display name (Hebrew) | id | English display | Cluster | Status |
|---|---|---|---|---|
| רמות השבים | `ramot-hashavim` | Ramot HaShavim | `sharon` | פתוח |
| רעננה אשר | `raanana-asher` | Ra'anana Asher | `sharon` | פתוח |
| רעננה הפרדס | `raanana-hapardes` | Ra'anana HaPardes | `sharon` | טרום-פתיחה |
| עפרוני קיסריה | `caesarea-ofroni` | Efroni Caesarea | `caesarea` | פתוח |
| ריהאב קיסריה | `caesarea-rehab` | Rehab Caesarea | `caesarea` | פתוח |
| שדה אליעזר | `sde-eliezer` | Sde Eliezer | `north` | טרום-פתיחה |

**The Hebrew display names above are the only correct forms.** Every app must show exactly
these strings — no local variants, no reordering (it is "עפרוני קיסריה", not "קיסריה עפרוני").

`raanana-hapardes` and `sde-eliezer` are **reserved now** so no app invents an id for them
later under pressure. Both are pre-opening but already have activity.

### Note on `caesarea-ofroni`

The display name and English form use **עפרוני / Efroni**. The id keeps the `ofroni` spelling
because it is already frozen in `ezone-kitchen` and in `DIGEST-CONTRACT.md`. This mismatch is
intentional and harmless — the id is never shown to a user. Do not "fix" it in one repo alone;
that silently breaks every consumer of the digest.

## Legacy aliases (read-only — never write these)

| Legacy id | Canonical id | Seen in |
|---|---|---|
| `ramot` | `ramot-hashavim` | Managers, Dashboard |
| `raanana` | `raanana-asher` | Managers, Dashboard |
| `arfoni` | `caesarea-ofroni` | Managers, Dashboard |
| `rehab` | `caesarea-rehab` | Managers, Dashboard |

`arfoni` vs `ofroni` is not even a consistent transliteration. This is exactly the class of bug
this file exists to prevent.

## Clusters

Cluster is a **proximity group**, used for batching external technician visits. It is not the
same thing as the internal maintenance lead.

| Cluster | Houses | Maintenance lead |
|---|---|---|
| `sharon` | `raanana-asher`, `ramot-hashavim`, `raanana-hapardes` | רמי |
| `caesarea` | `caesarea-ofroni`, `caesarea-rehab` | צחי |
| `north` | `sde-eliezer` | צחי |

צחי covers both `caesarea` and `north`, but they are **separate clusters** — שדה אליעזר is far
north and must not be auto-batched with עפרוני + ריהאב just because they share a lead.

## Rules

1. **Write canonical ids only.** Any new row, digest entry, or API payload uses the id column.
2. **Map on read.** When consuming Managers or Dashboard data, translate legacy → canonical at
   the boundary. Never let a legacy id past the read layer.
3. **Display from this table.** Never build a display name in code by concatenating parts.
4. **Never key data on the Hebrew name** — display names get edited; ids do not.
5. **Never guess.** An unmapped house is omitted, never inferred from a partial name match.
6. **Append-only.** New houses get a new id appended here first, then used in code.
