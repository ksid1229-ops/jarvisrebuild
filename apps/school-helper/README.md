# School Helper — the connected app this rebuild is missing

This directory is a copy of **School Helper**, an Opera GX extension that reads Sid's two D2L boards (LDSB and Durham) read-only and pushes what it finds to Jarvis.

- **Upstream (authoritative):** https://github.com/ksid1229-ops/school-helper
- **Copied from:** branch `feat/jarvis-link-and-scribe`, head `c621965` (v1.1.0)
- **This copy's own docs:** [`README-UPSTREAM.md`](README-UPSTREAM.md), [`docs/JARVIS-LINK.md`](docs/JARVIS-LINK.md), [`docs/jarvis-tools.json`](docs/jarvis-tools.json), [`PROGRESS-jarvis-link.md`](PROGRESS-jarvis-link.md)

It lives here because this rebuild has **no school side at all** — `src/`, `migrations/` and the docs contain no school, D2L or deadline code, and `migrations/0001_init.sql` has nowhere to put an evidence batch. This app is the missing half. Nothing in `src/` reads this directory; it is here to be integrated, not imported.

## What it needs from this rebuild

The extension dials **out**. It is a Manifest V3 service-worker extension with no HTTP server, no `createServer`, no `listen` — so it can never be reached the way `src/apps/connector.ts` reaches an app (`GET {base}/tools`, `POST {base}/call`, `GET {base}/context`). **The Phase-3 connector cannot connect to it.** What it does instead is POST signed requests to four fixed paths:

| Path | Signed | Body |
|---|---|---|
| `POST /school/pairing/start` | no | `{ publicKeyBase64, deviceLabel }` |
| `POST /school/pairing/prove` | yes | `{ challenge }` |
| `POST /school/pairing/status` | yes | `{}` |
| `POST /school/observations` | yes | one course batch, or one host-failure batch |

Every signed request carries `x-jarvis-signed-request`: an Ed25519 envelope over the exact body bytes, with the signature text `method \n path \n deviceId \n principalId \n audience \n issuedAt \n nonce \n bodyHash`. The audience is `jarvis-school-collector`.

So integrating it means **this rebuild grows a school ingestion surface**, not that the app grows a connector:

1. The four routes above, dispatching the four exact paths and nothing else.
2. An Ed25519 verifier with single-use nonces (the app's `bodyHash` is SHA-256 over the exact bytes it sent; a re-serialised body is refused).
3. Two or three tables — collector keys and an evidence store — added to `migrations/0001_init.sql`.
4. Real persistence behind them. This rebuild currently has **none**: `env.DB` never appears in `src/index.ts`, `buildJarvis` takes storage as an argument, and every repo is a synchronous in-memory Map.
5. Then the four tools in [`docs/jarvis-tools.json`](docs/jarvis-tools.json) — `school_snapshot_read`, `school_changes_since`, `school_request_sync`, `school_open_item` — served from ingested evidence. That file is written for exactly this: it describes tools *Jarvis* serves over data the app pushes, and the app does not implement them.

## What is already known to work, and what is not

**Proven:** 231 tests pass, `tsc --noEmit` is clean, and the extension reads both boards live — 412 items across 6 courses, with Durham reached through the LDSB "My Courses in Other Boards" hop.

**Not proven:** live pairing. The link is `enabled: false` in settings and no real batch has ever been accepted by a real receiver.

**Already known to be broken in the app** (fixes owed, all four reproduced from Sid's own database):

1. Announcement deep links are not on the wire — `src/d2l/parsers/news.ts` builds `/d2l/le/news/<orgUnitId>/<remoteId>/view`, but the wire carries the raw news body, which has no URL field. Jarvis can read an announcement and cannot open it.
2. Live D2L dates carry a naive-timestamp shift: a folder D2L reports as `2022-10-19` surfaces as `2022-10-20T03:59Z`.
3. `parseLooseDate` invents a year — two seeded items read as due `2031` with no live counterpart.
4. `tests/jarvis.receiver-contract.test.ts` contains a **hand transcription** of the real receiver's `parseSchoolBatch`. It was verbatim on 2026-09-27 and nothing keeps it that way.

## Do not run it alongside the D2L collector

[`docs/JARVIS-LINK.md`](docs/JARVIS-LINK.md) §1: School Helper takes over the role of `apps/d2l-extension`, and running both reads the same two boards with the same account for duplicate evidence. Install one.

## Build and test

```powershell
cd apps/school-helper
npm install
npm test        # vitest, 231 tests
npm run build   # produces dist/, an unpacked extension to load in Opera GX
```

Requires Node 24. `npm run build` writes `dist/`, which this repo's `.gitignore` already excludes. No credentials or cloud accounts are needed for the test suite.
