# PROGRESS — feat/jarvis-link-and-scribe

Branch: `feat/jarvis-link-and-scribe` off `main`
Version: **1.1.0** · artifact `release/school-helper-1.1.0.zip`
Status: **both features complete, all gates green, not yet pushed or reviewed**

---

## Done

### Step 0 — Capture debug fixtures (asked for first)

Verified end to end with 8 tests: off by default, records during a sync when
enabled, **redacts the student name before storage**, exports a valid bundle with
a redaction count, survives a non-JSON login page, and clears on request.
Documented in `README.md` for Windows with three PowerShell checks Sid runs to
confirm his name, email and student number are gone before sending the file.

### Feature 1 — Jarvis link

| Piece                           | File                                    | State |
| ------------------------------- | --------------------------------------- | ----- |
| Canonical JSON                  | `src/jarvis/canonical.ts`               | done  |
| Ed25519 envelope                | `src/jarvis/envelope.ts`                | done  |
| Transport seam + gateway impl   | `src/jarvis/transport.ts`               | done  |
| Route contract                  | `src/jarvis/routes.ts`                  | done  |
| Evidence batches                | `src/jarvis/evidence.ts`                | done  |
| GET-only reader                 | `src/jarvis/reader.ts`                  | done  |
| Outbox                          | `src/jarvis/outbox.ts`                  | done  |
| Link service, log, warning      | `src/jarvis/link.ts`                    | done  |
| Push orchestration              | `src/jarvis/push.ts`                    | done  |
| Settings UI + log               | `src/ui/dashboard/pages/JarvisLink.tsx` | done  |
| Background wiring + flush alarm | `src/background/index.ts`               | done  |
| Contract doc                    | `docs/JARVIS-LINK.md`                   | done  |
| Tool descriptions               | `docs/jarvis-tools.json`                | done  |

Off by default. Pairing (Ed25519, owner approval in Telegram), push after every
sync, bounded outbox with backoff, last-50 link log, dashboard warning after
three consecutive failures, host permission requested before anything is sent.

### Feature 2 — Scribe mode

| Piece                          | File                                | State |
| ------------------------------ | ----------------------------------- | ----- |
| Word-level diff                | `src/scribe/diff.ts`                | done  |
| Cleanup + prompt               | `src/scribe/cleanup.ts`             | done  |
| Voice + typing fallback        | `src/scribe/speech.ts`              | done  |
| Prompts + persistence + export | `src/scribe/session.ts`             | done  |
| UI                             | `src/ui/dashboard/pages/Scribe.tsx` | done  |

Reached from an assignment → **Scribe mode**. One question at a time, voice or
typing, raw capture stored before cleanup and never overwritten, side-by-side
diff with every added word highlighted and named, accept or edit per answer,
export in question order.

---

## Test results

```
Test Files  18 passed (18)
     Tests  231 passed (231)
```

| Suite             | Tests | Suite                      | Tests |
| ----------------- | ----: | -------------------------- | ----: |
| `scribe`          |    30 | `jarvis.evidence`          |    19 |
| `jarvis.outbox`   |    18 | `jarvis.transport`         |    16 |
| `parsers.misc`    |    16 | `formatter`                |    15 |
| `ai.provider`     |    13 | `guardrails`               |    13 |
| `importer`        |    12 | `sync`                     |    12 |
| `jarvis.push`     |    10 | `jarvis.receiver-contract` |    10 |
| `priority`        |    10 | `fixtures.capture`         |     8 |
| `merge`           |     8 | `parsers.content`          |     8 |
| `parsers.dropbox` |     7 | `backup`                   |     6 |

Gates: eslint clean · prettier clean · `tsc --noEmit` clean · build clean ·
`npm run release` produced `school-helper-1.1.0.zip`, sha256
`1278398c2ab72ab6022215d25c002461b716fb94dda222232c9992156ac89d6b`.

### Three real bugs the receiver-contract test found

1. `startedAt` / `fetchedAt` were epoch numbers. The receiver requires ISO
   instants and **would have refused every batch**.
2. A board that failed before discovering any course emitted **nothing** —
   silence, which Jarvis reads as "nothing is due". Now sends the host-failure
   envelope (`course: null`) the receiver already accepts and the old collector
   never sent.
3. A course listing the same dropbox folder twice produced a duplicate route
   label, which makes the receiver reject the **whole batch**.

---

## What is faked

Everything external. No real account, key or D2L access existed in the sandbox.

| Faked                    | How                                                                                                                                                      | What that leaves unproven                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| The Jarvis gateway       | `tests/fake-jarvis.ts` — verifies Ed25519 signatures over the exact body bytes, enforces single-use nonces, the pairing state machine and the 64 KiB cap | Live pairing, the Telegram approval tap, real ingestion |
| The receiver's validator | `tests/jarvis.receiver-contract.test.ts` transcribes `parseSchoolBatch` from the gateway source                                                          | It is a transcription, not the receiver                 |
| D2L                      | Stubbed `fetch` returning Valence-shaped JSON, plus the 11 existing fixtures                                                                             | No parser has still ever seen a real D2L response       |
| The AI provider          | Injected `completeImpl`                                                                                                                                  | No real model has run a scribe cleanup                  |
| Speech recognition       | A stubbed `webkitSpeechRecognition` constructor                                                                                                          | Real dictation accuracy, en-CA, mic prompts in Opera GX |
| The SSO hop              | Injected `ensureDurham` callback                                                                                                                         | Durham federation still unverified                      |

---

## Deliberately not built

**The pull channel.** The brief asked for `GET /apps/{appId}/requests` with
`sync_now` / `open_item` / `notify`. The gateway has no such route and no
`/apps/*` namespace — I enumerated every route in `apps/cloud-gateway/src`. Per
Sid's decision, it was dropped rather than stubbed: no dead code. Recorded in
`KNOWN_ISSUES.md` #15 with the exact shape of the addition, and
`docs/jarvis-tools.json` tells Jarvis those two tools are queued intents.

**The brief's wire contract.** It specified a shared secret, `X-App-Id` and
`/apps/*`. None of that exists. Sid chose the real protocol; see
`DECISIONS.md` #17.

---

## The exact next step

**Push the branch and open the draft PR.** I have no push credentials and there
is no GitHub connector, so this is the one thing I could not do.

```powershell
cd C:\w\school-helper          # or wherever your clone is
git remote -v                  # confirm it points at your repo
git fetch
git am --3way "$HOME\Downloads\jarvis-link-and-scribe.patch"
git push -u origin feat/jarvis-link-and-scribe
gh pr create --draft --title "Jarvis link and scribe mode" --body-file docs/PR-jarvis-link.md
```

Or, if you prefer the bundle:

```powershell
git fetch "$HOME\Downloads\school-helper-jarvis.bundle" feat/jarvis-link-and-scribe:feat/jarvis-link-and-scribe
git push -u origin feat/jarvis-link-and-scribe
```

**Then, in priority order:**

1. **Pair against the live gateway** (`KNOWN_ISSUES.md` #16). This is the only
   thing that proves the link works. Settings → Jarvis link → Save and pair →
   approve in Telegram → Send evidence now → read the link log.
2. **Capture real D2L fixtures** (`README.md`, and `KNOWN_ISSUES.md` #1). Still
   the highest-value action for the whole project.
3. Remove the old Jarvis D2L collector and revoke its device record
   (`docs/JARVIS-LINK.md` §1).
4. Try scribe mode on one real assignment and check the diff behaves on his
   actual speech patterns.

---

Built by: UNKNOWN | Company: Arena.ai | Effort: High | Date (UTC): 2026-09-26
