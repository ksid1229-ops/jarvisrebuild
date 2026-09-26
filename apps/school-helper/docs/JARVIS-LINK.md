# The Jarvis link

School Helper can act as Jarvis's school data source. Jarvis does the thinking;
this app supplies facts.

**The link is OFF by default and School Helper is fully usable with it off.**
Nothing here changes the rule that School Helper never submits, posts or hands
in anything on Sid's behalf.

---

## 1. What this replaces

Jarvis already contained a D2L collector at `apps/d2l-extension` ("Jarvis D2L
collector"). School Helper takes over that role. Its runbook says plainly:

> Remove the old probe if it is still installed; do not run both extensions.

That applies here too — **do not run School Helper and the Jarvis D2L collector
at the same time.** Both read the same two boards with the same account, which
doubles the API load for no benefit and produces duplicate evidence.

Retiring the old collector:

```powershell
# 1. opera://extensions  ->  find "Jarvis D2L collector"  ->  Remove
# 2. Ask Jarvis in Telegram:
#      "Show my D2L collector devices, then revoke the collector for <label>."
#    Removing the extension does NOT revoke its server record.
```

School Helper pairs as its own device, with its own key. It does not reuse the
collector's pairing.

---

## 2. Direction of traffic

An extension cannot receive incoming calls, so **School Helper always dials
out**. Every request is a POST from the browser to the gateway.

|          |                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| **Push** | After each sync, School Helper reads the collector's route set and sends one observation batch per course. |
| **Pull** | **Not implemented.** The gateway has no route for an extension to ask "any requests for me?". See §7.      |

---

## 3. The contract

Base URL (default): `https://jarvis-cloud-gateway.twilight-tree-70b1.workers.dev`

Exactly four paths are reachable. The client refuses to POST anywhere else, and
a test asserts it.

| Path                          | Signed | Purpose                                                       |
| ----------------------------- | ------ | ------------------------------------------------------------- |
| `POST /school/pairing/start`  | no     | Registers this device's public key, returns the approval code |
| `POST /school/pairing/prove`  | yes    | Proves possession of the private key (single use)             |
| `POST /school/pairing/status` | yes    | `pending` until Sid approves in Telegram, then `active`       |
| `POST /school/observations`   | yes    | One course batch, or one host-failure batch                   |

### Authentication

Not a shared secret. Each device generates a **non-extractable Ed25519 key pair**
(`extractable: false` — even our own code cannot export the private half) and
stores it as a live `CryptoKey` in extension-origin storage. It is never in a
backup, in any form, regardless of `includeSecrets`.

Every signed request carries an `x-jarvis-signed-request` header:

```json
{
  "schemaVersion": "1.0",
  "deviceId": "collector-1",
  "principalId": "principal-1",
  "audience": "jarvis-school-collector",
  "issuedAt": 1790000000000,
  "nonce": "4bJk...32-bytes-base64url",
  "bodyHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "signatureBase64": "MEUCIQ..."
}
```

The signature covers, newline-joined:

```
POST\n<path>\n<deviceId>\n<principalId>\n<audience>\n<issuedAt>\n<nonce>\n<bodyHash>
```

`bodyHash` is SHA-256 over the **exact body bytes**. Retries resend byte-identical
bodies with a fresh nonce; re-serializing would move the hash and be refused.

Requests are sent with `credentials: 'omit'`, `redirect: 'manual'`,
`cache: 'no-store'` and a 15-second timeout. Any redirect is refused rather than
followed.

### Canonical JSON

Bodies are serialized with a canonical form the receiver agrees with: keys
NFC-normalized and sorted, strings NFC-normalized, no insignificant whitespace,
max depth 32, max 4096 structural items, and **under 64 KiB**. Exceeding any
bound is a refusal, never a truncation.

### Pairing

```
start  ──► { collectorId, principalId, challenge, code: "481-902", expiresAt }
           Sid approves `code` in Jarvis on Telegram. Window: 10 minutes.
prove  ──► { ok: true }                      (single use; a lost response is retried)
status ──► { status: "pending" | "active" }
```

Nothing is sent until status is `active`. An observation POST before approval is
refused with `403 school_key_inactive`.

### Observations

Two envelopes. Both are validated by `parseSchoolBatch` on the receiver
(`apps/cloud-gateway/src/school/collector-protocol.ts`), which requires an exact
field set — extra or missing keys are rejected outright.

**A course batch:**

```json
{
  "schemaVersion": "1.0",
  "host": "ldsb.elearningontario.ca",
  "readId": "1790000000000-a1b2c3",
  "startedAt": "2026-09-26T18:04:00.000Z",
  "courseIds": ["1001", "1002"],
  "enrollmentComplete": true,
  "course": { "id": "1001", "name": "BBB4M0-01 International Business" },
  "routes": [
    {
      "route": "/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=1001",
      "status": 200,
      "fetchedAt": "2026-09-26T18:04:02.000Z",
      "complete": true,
      "body": [{ "Id": 55, "Title": "Unit 3 Response", "DueDate": null }]
    },
    {
      "route": "/d2l/api/le/1.82/1001/dropbox/folders/77/submissions/mysubmissions/",
      "status": 403,
      "fetchedAt": "2026-09-26T18:04:05.000Z",
      "complete": true,
      "body": { "Errors": ["Not authorized"] }
    }
  ]
}
```

**A host-failure batch** — sent when a board could not be read at all and no
course is even known:

```json
{
  "schemaVersion": "1.0",
  "host": "durham.elearningontario.ca",
  "readId": "1790000000000-a1b2c3",
  "startedAt": "2026-09-26T18:04:00.000Z",
  "courseIds": [],
  "enrollmentComplete": false,
  "course": null,
  "routes": [
    {
      "route": "/d2l/api/versions/",
      "status": 200,
      "fetchedAt": "2026-09-26T18:04:01.000Z",
      "complete": false,
      "body": { "collectorFailure": "session-expired" }
    }
  ]
}
```

The old collector never emitted this envelope, so a dead board produced
**silence** — which reads as "nothing is due". School Helper sends it.

Receipt: `{ "batchId": "...", "outcome": "good" | "failed" }`. Anything else is
treated as a failed delivery and the batch stays queued.

### Timestamps

`startedAt` and `fetchedAt` are **ISO 8601 UTC instants** (`2026-09-26T18:04:00.000Z`),
not epoch numbers — the receiver parses them and rejects numbers. `fetchedAt` may
never precede `startedAt`, and neither may be in the future.

School Helper's own timezone is `America/Toronto`; everything on the wire is UTC.

### The routes read, per course

`items`, `toc`, `folders`, `grades`, `news`, `quizzes`, then
`submissions/mysubmissions/` for each dropbox folder. Plus, per board,
`versions` and paginated `enrollments`. Requests are spaced about one second
apart. API versions LP 1.43 and LE 1.82 are required and a missing one fails
loudly.

---

## 4. What is sent, and what is not

**Sent:** the raw D2L response bodies — due dates, status, grades, weights,
descriptions, URLs, announcements, quizzes, rubric references — exactly as D2L
returned them.

**Never sent:**

- `priorityOf()` scores, buckets, the weekend plan or the "what next" ranking.
  Jarvis decides what matters. A test asserts none of these strings appear on
  the wire.
- School Helper's own `WorkItem` shape, `overrides`, `presentInLastSync` or any
  other interpretation layer.
- AI provider keys, the Google OAuth token, or anything from the AI cost log.

### The evidence rules, carried over from the collector

These are the receiver's semantics, and each has a named test:

| Rule                                               | Meaning                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| JSON **403** → refused evidence, `complete: true`  | A refusal was fully observed. It is not a failure and not an empty result.      |
| JSON **404** → retained evidence, `complete: true` | An optional tool that isn't there.                                              |
| **Null due date** → stays null                     | "No date known" — never coerced to a real date.                                 |
| **Refused submissions route ≠ unsubmitted**        | Nothing in the batch claims work wasn't handed in.                              |
| **HTML 200 login page** → session failure          | Never evidence of an empty course.                                              |
| Redirect or **401** → session failure              | Same.                                                                           |
| **Failure ≠ zero assignments**                     | An empty `200` list is a real empty list; a failure carries `collectorFailure`. |
| Paginated tool response → `complete: false`        | Better incomplete than falsely whole.                                           |

### Durham

Durham is reached **only** through the LDSB homepage's "My Courses in Other
Boards" hop, after LDSB has been read. There is no separate Durham login and
none is attempted. A failed hop is logged and Durham still reports explicit
per-route failures rather than silence. A test pins the ordering.

---

## 5. Honesty rules

- **Nothing is reported as sent without a receipt.** A failed push stays in the
  IndexedDB outbox and is retried with backoff: 1m, 5m, 15m, 1h, then 6h.
- **Three consecutive failures raise a dashboard warning** on the Today page,
  not just in Settings.
- **No change is dropped silently.** The outbox keeps the newest 2 batches per
  host+course and at most 1 MiB. Every eviction increments a counter, is logged
  as `queue-evicted-N`, and is surfaced as a banner.
- **Oversized batches become explicit compact failures**, never truncated
  successes — a truncated course would read as "these are all the assignments".
- **The link log** shows the last 50 calls with time, endpoint, status, item
  count and detail.

---

## 6. Tool descriptions for Jarvis

`docs/jarvis-tools.json` describes the tools Jarvis should expose over the data
this extension pushes. Jarvis serves them from its own store; School Helper does
not implement them.

Note that Jarvis already has `school_d2l_status` and `school_collector_revoke`
from merged PR #169. The four in that file are additions, not replacements.

---

## 7. Pull is not implemented

The brief asked for a pull channel — `GET /apps/{appId}/requests` returning
`sync_now`, `open_item` and `notify` instructions, with results posted back.

**No such route exists on the gateway.** The school surface is the four paths in
§3 and nothing else; there is no `/apps/*` namespace and no bearer-secret auth.
Building the client half would have meant shipping code that cannot run,
so it was left out rather than stubbed. The design is recorded in
`KNOWN_ISSUES.md` #15 and is a small addition once a route exists:

- the action allow-list (`sync_now`, `open_item`, `notify`) with everything else
  refused and reported as unsupported — never executed
- a poll on the existing alarm cadence and on dashboard open
- `POST .../requests/{id}/result` with `{ ok, message }`

`JarvisTransport` is the seam it would slot into: add a `pullRequests()` method
and a second implementation, and nothing else in the app changes.
