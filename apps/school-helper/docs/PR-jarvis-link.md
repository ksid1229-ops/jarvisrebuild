# Jarvis link and scribe mode

**Draft.** Adds two features to School Helper v1.1.0. Nothing that already
worked was changed except where noted.

---

## Read this first: the brief's contract does not exist

The task specified `POST /apps/{appId}/events`, a shared secret in an
`Authorization: Bearer` header, and an `X-App-Id` header. I enumerated every
route in `apps/cloud-gateway/src` before writing any wire code. The school
surface is four paths:

```
POST /school/pairing/start
POST /school/pairing/prove
POST /school/pairing/status
POST /school/observations
```

There is no `/apps/*` namespace, no `X-App-Id`, and no shared-secret auth.
Authentication is a per-device **Ed25519** key with a pairing handshake and an
owner approval tap in Telegram. There is also no pull route of any kind.

Sid chose the real protocol. See `DECISIONS.md` #17.

Jarvis also already had a D2L collector at `apps/d2l-extension` reading the same
two boards. School Helper replaces it — it was never loaded or paired, so
nothing is lost. `DECISIONS.md` #19, removal steps in `docs/JARVIS-LINK.md` §1.

---

## Feature 1 — Jarvis link

School Helper pushes the raw D2L evidence the collector would have sent. **Off
by default**; the app is fully usable with it off.

- Per-device non-extractable Ed25519 key (`extractable: false`), stored as a
  live `CryptoKey`, never in a backup in any form.
- Pairing start → prove → status, with the approval code shown in Settings to
  match against Telegram.
- Canonical JSON byte-compatible with the receiver; per-attempt nonce; retries
  resend byte-identical bodies.
- `credentials: 'omit'`, `redirect: 'manual'`, 15s timeout, four-path allow-list.
- Bounded outbox: newest 2 per host+course, 1 MiB, 8 uploads per flush,
  1m/5m/15m/1h/6h backoff.
- Settings panel with the last 50 calls; dashboard warning after three
  consecutive failures; every eviction counted, logged and surfaced.
- Host permission requested via `optional_host_permissions` before anything is
  sent.

All wire code sits behind one `JarvisTransport` interface with one
implementation, so a second contract is an addition rather than a rewrite.

### The collector rules are carried over, each with a named test

| Rule                                                                        | Test              |
| --------------------------------------------------------------------------- | ----------------- |
| JSON 403 → refused evidence, `complete: true`, not a failure                | `jarvis.evidence` |
| JSON 404 → retained evidence                                                | `jarvis.evidence` |
| Null due date stays null — "no date known"                                  | `jarvis.evidence` |
| Refused submissions route ≠ unsubmitted                                     | `jarvis.evidence` |
| HTML 200 login page → session failure, never an empty course                | `jarvis.evidence` |
| Failure ≠ zero assignments                                                  | `jarvis.evidence` |
| Durham only after LDSB, via the cross-board hop                             | `jarvis.push`     |
| No priority score, no `WorkItem` fields on the wire                         | `jarvis.evidence` |
| GET only — the verb is a hard-coded literal, asserted by reading the source | `jarvis.push`     |

### Three real bugs found before release

`tests/jarvis.receiver-contract.test.ts` transcribes the receiver's
`parseSchoolBatch` and runs every batch shape through it:

1. **`startedAt`/`fetchedAt` were epoch numbers.** The receiver requires ISO
   instants. Every batch would have been refused.
2. **A board that failed before discovering any course emitted nothing.**
   Silence reads as "nothing is due". Now sends the host-failure envelope
   (`course: null`, `courseIds: []`, `enrollmentComplete: false`) that the
   receiver already accepts and the old collector never sent — its runbook lists
   this as still to be built.
3. **A duplicated dropbox folder produced a duplicate route label**, which makes
   the receiver reject the entire batch.

### Pull is not implemented

No route exists. Dropped rather than stubbed, per Sid. `KNOWN_ISSUES.md` #15
records the exact shape of the addition; `docs/jarvis-tools.json` tells Jarvis
`school_request_sync` and `school_open_item` are queued intents, not instant
actions.

---

## Feature 2 — Scribe mode

Sid's scribe accommodation. He answers in his own words and gets them written
up, with **nothing added**.

- One question at a time, read from the assignment description or pasted in when
  there is none. Prompts are never invented.
- Voice via `webkitSpeechRecognition` (en-CA) with a typing fallback that is
  always present and never gated behind voice working.
- The raw capture is stored before any cleanup and never overwritten — later
  edits land in `accepted`. It survives a cleanup failure, which is tested.
- Cleanup may remove filler, false starts and repetition and fix spelling,
  punctuation and capitalisation. The prompt forbids adding ideas, facts,
  examples, transitions or any meaning-carrying word.

### Proof, not trust

A word-level diff compares cleaned against raw and lists every added word.
Forgiven: filler, punctuation, capitalisation, spelling fixes of words he did
say, contraction expansion. Everything else is highlighted and named, with a
count, before he can accept.

Tested against the cases that matter: a smuggled transition
("Consequently,"), an invented fact ("The 1930 Smoot-Hawley tariff"), a negation
flip ("never"), and a short content word that must not be waved through as a
typo ("now" vs "not").

Scribe output does **not** pass through `enforceNotesOnly`, and
`ai/guardrails.ts` is unchanged. These are Sid's own words; that guard exists to
stop the AI writing answers for him, and applying it here would mangle his work
while solving a problem that does not arise. `DECISIONS.md` #18.

---

## Also (asked for first)

`Settings → Capture debug fixtures → Sync → Export fixtures` verified end to end
with 8 tests, including that the student name is redacted before storage.
Documented in `README.md` for Windows, with three PowerShell checks Sid runs to
confirm his details are gone before sending the file.

---

## Gates

```
Test Files  18 passed (18)
     Tests  231 passed (231)      (was 120)
```

eslint clean · prettier clean · `tsc --noEmit` clean · build clean ·
`npm run release` → `school-helper-1.1.0.zip`,
sha256 `1278398c2ab72ab6022215d25c002461b716fb94dda222232c9992156ac89d6b`.

Dexie schema v2 adds `jarvisOutbox`, `jarvisLog`, `scribeSessions`. Existing
data untouched.

## Not verified

No real account, key or D2L access existed in the sandbox, so everything
external is faked. Live pairing, the Telegram approval tap, real ingestion, real
D2L responses, a real model running a scribe cleanup and real dictation are all
unproven. `KNOWN_ISSUES.md` #16–#19. A green suite is not live acceptance.

## Review focus

1. `src/jarvis/evidence.ts` — does the host-failure envelope match what the
   receiver expects, and is emitting it the right call?
2. `tests/jarvis.receiver-contract.test.ts` — is the transcription faithful?
3. `src/scribe/diff.ts` — is the forgiveness list too generous? Specifically
   `isSpellingFixOf` and the short-word transposition rule.
4. Whether replacing the collector is right, or whether it should have stayed.

---

Built by: UNKNOWN | Company: Arena.ai | Effort: High | Date (UTC): 2026-09-26
