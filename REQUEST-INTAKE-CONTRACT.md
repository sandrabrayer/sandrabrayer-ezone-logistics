# Request intake — secret-gated contract (v1)

Logistics is the **system of record** for requests. Coordinators do **not** log into Logistics; the
**ezone-coordinators** app collects a request and POSTs it into Logistics **server-to-server**, over
this endpoint. There is **no public/unauthenticated submit route on the Node frontend** — the
coordinators app calls the Apps Script `/exec` Web App directly, authenticated by a shared secret.

The **sole authority** for this contract is `apps-script/Code.gs`
(`handleCreateRequestIntake_` / `validateIntakeRequest_`). The ezone-coordinators repo consumes this
contract; do not change one side without the other.

--- FROZEN CONTRACT ---

## Endpoint

```
POST <APPS_SCRIPT_EXEC_URL>          (the Logistics Web App /exec, follow 302 redirects)
Content-Type: application/json       (or text/plain;charset=utf-8 to avoid a CORS preflight)
```

Apps Script Web Apps always answer **HTTP 200** with a JSON body — success vs. failure is carried by
the `ok` flag, never an HTTP status code. A POST is answered via a `302` to a
`script.googleusercontent.com` URL; the caller **must follow redirects** (Node `fetch` default).

## Authentication — shared secret, fail-closed

The request body carries a `secret` field. It is compared (constant-time) against the
`CREATE_REQUEST_SECRET` **Script Property** of the Logistics Apps Script project. **Fail-closed:** if
the property is **unset/empty**, the provided secret is **empty**, or the two **do not match**, the
request is **rejected with no writes** (`{ ok:false, error:"Unauthorized" }`). No session token is
involved; this path is handled **before** the session-token gate and is the only secret-gated action.

Presence of the `secret` field is what routes a `createRequest` to this intake. The in-app manager
`createRequest` carries a session `token` and **no** `secret`, so it is unaffected by this endpoint.

> The secret is **never** stored in the repo. It must be set in the Logistics Apps Script project:
> **Project Settings → Script Properties → `CREATE_REQUEST_SECRET`**.

## Request body

```json
{
  "action": "createRequest",
  "secret": "<CREATE_REQUEST_SECRET>",
  "payload": {
    "house": "ramot-hashavim",
    "category": "תיקון",
    "urgency": "רגיל",
    "description": "ברז דולף במטבח",
    "location_in_house": "מטבח",
    "estimated_cost": 250,
    "created_by": "שירה"
  }
}
```

### Payload fields

| Field               | Required | Rule |
|---------------------|----------|------|
| `house`             | yes      | A **canonical house id** from `HOUSE-IDS.md` — one of `ramot-hashavim`, `raanana-asher`, `caesarea-ofroni`, `caesarea-rehab`, `pardes`, `sde-eliezer`. **Not** a display name, **not** a legacy alias. Logistics maps it to the Hebrew house name at the boundary (it keys requests on the name internally). |
| `category`          | yes      | Exactly one of `רכישה`, `תיקון`, `החלפה`. |
| `urgency`           | yes      | Exactly one of `רגיל`, `דחוף`, `חירום`. |
| `description`       | yes      | Non-empty after trim; **≤ 2000 characters**. |
| `location_in_house` | no       | Free text; **≤ 200 characters**. Omitted/blank is fine. |
| `estimated_cost`    | no       | A number, **or** blank/omitted (unknown cost is a real case). Non-numeric non-blank is rejected. |
| `created_by`        | yes      | The coordinator's name; non-empty after trim, **≤ 120 characters**. Stored verbatim as the request's `created_by`. |

Any field off-contract → the whole request is rejected with **no writes**.

## Success response

```json
{ "ok": true, "id": "REQ-20260807-1234" }
```

The created request:

- enters the **normal lifecycle** at status **`דרישה`**;
- has approval routing applied **unchanged** (chain B — amount vs. `approval_threshold`; `חירום`
  bypasses to auto), and an SLA `due_at` derived from urgency;
- `created_by` = the coordinator name from the payload;
- is **audit-logged**: one `AuditLog` row `'' → דרישה`, `by` = `created_by`, note **`source=coordinators`**.

## Error responses

All errors are `{ "ok": false, "error": "<message>" }` (HTTP 200). No partial writes ever occur — a
rejected request appends **nothing** to `Requests` or `AuditLog`.

| `error` message                            | Meaning |
|--------------------------------------------|---------|
| `Unauthorized`                             | Secret unset, empty, or mismatched (fail-closed). |
| `Invalid JSON body`                        | Body was not valid JSON. |
| `Missing payload`                          | `payload` missing or not an object. |
| `Invalid or missing house`                 | `house` is not a canonical id. |
| `Invalid or missing category`              | `category` not in {`רכישה`,`תיקון`,`החלפה`}. |
| `Invalid or missing urgency`               | `urgency` not in {`רגיל`,`דחוף`,`חירום`}. |
| `Missing description`                      | `description` empty after trim. |
| `description too long`                     | `description` > 2000 chars. |
| `location_in_house too long`               | `location_in_house` > 200 chars. |
| `estimated_cost must be a number or blank` | `estimated_cost` present but non-numeric. |
| `Missing created_by`                       | `created_by` empty after trim. |
| `created_by too long`                      | `created_by` > 120 chars. |
| `Server error`                             | Unexpected server-side error (logged upstream); no write. |
