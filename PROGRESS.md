# Jarvis rebuild — PROGRESS

**Status (2026-09-26, session arena/01a0e025):** all 7 phases' feature code + D1 persistence +
school receiver/pull channel + **memory hardening** (this session). **139/139 tests green**,
`tsc --noEmit` clean, school app untouched (231→238 tests in `apps/school-helper`, not re-run
this session — no files there changed).

**Exact next step:** rebuild the connectors that were reported done but NEVER PUSHED (see
"Lost work" below): Cloudflare email in (school@onesid.ca) + Gmail API / MS Graph out, Twilio
REST + the ConversationRelay WebSocket loop on the DO, and the Windows PC agent. Nothing here is
deployed; Sid does production deploys.

### Lost work (verified from git, not memory)

The previous session's final report claimed a commit with email in/out, Twilio REST, the
ConversationRelay WebSocket loop, the PC agent app, a Vectorize adapter and migration 0003, with
"363 tests". **That commit never reached GitHub.** `git ls-remote` shows the old session branch
`arena/01a0dfb2-jarvisrebuild` ending at `930a2c4` (school app fix); none of those files exist on
any branch. This session started from `930a2c4` (105 tests). The Vectorize adapter was rebuilt
this session; email, Twilio REST/WS and the PC agent still need rebuilding.

**Sid's locked answers (2026-09-26, via popup):**
- spend_money = browser autofill: Jarvis drives the checkout, clicks his saved card ending
  **2286**. No payment API. Still a confirmed action, still PIN-gated on calls.
- PC agent = FULL hands: "jarvis can do literally anything he wants" (shell, browser, files).
  Receipts still log everything (Proof is architecture, not a restriction).
- Outbound email = his real accounts, model picks by recipient unless told: Gmail API for
  ksid1229@gmail.com, Microsoft Graph for sk7qq09@limestone.on.ca (MX proves M365).
- PC offline = QUEUE: record it, say it's queued, run it when the PC checks in.

---

## How to run the tests

```powershell
cd $HOME\jarvisrebuild
npm install
npm test
npm run typecheck
```

---

## What is built (file → one line)

- `src/clock.ts` — injected Clock (SystemClock + FixedClock); no direct Date.now (trap #4).
- `src/env.ts` — Worker bindings; documents which missing config FAILS CLOSED.
- `src/types.ts` — domain types (Fact, Provenance, Receipt, PendingAction, …).
- `src/ids.ts` — id generation + canonical-JSON SHA-256 arg hashing (binds confirmations).
- `src/model/types.ts` — Model interface; MissingModelKeyError (no keyword fallback exists).
- `src/model/deepseek.ts` — real DeepSeek adapter; fetch bound to globalThis (trap #1); throws if no key.
- `src/model/fake-model.ts` — scripted model for tests (plays a queue; never reads words).
- `src/memory/facts-repo.ts` — facts ledger; corrections version (never overwrite); forget = hide.
- `src/memory/embeddings.ts` — EmbeddingProvider (Workers AI real + deterministic fake) + VectorIndex.
- `src/memory/provenance.ts` — verifies a 'stated' fact's quote appears in Sid's message.
- `src/memory/memory-tools.ts` — memory_save/correct/forget/restore/confirm/pin/unpin/explain/search + history_search.
- `src/conversation/conversation-repo.ts` — one store for text+voice; size-cap triggers a model-written summary.
- `src/receipts/receipts-repo.ts` — the tool logger / Receipts (Proof); every call recorded.
- `src/confirmations/pending-actions.ts` — pending_actions; TTL; same-turn self-confirm refused.
- `src/confirmations/gate.ts` — ToolDispatcher: enforces the five confirmations + shadow; logs every call.
- `src/confirmations/action-tools.ts` — the five confirmed actions; all return `not_connected` (honest).
- `src/settings/settings-repo.ts` — settings incl. shadow flag (explicit, not a silent default).
- `src/jarvis/system-prompt.ts` — persona (pushes back, no flattery) + time/tz/channel/shadow/core profile.
- `src/jarvis/tool-types.ts` — Tool, ToolContext, ToolResult, OwnerChannel.
- `src/jarvis/core-tools.ts` — send_text, receipts_query, settings_update, confirm_action, cancel_action.
- `src/jarvis/agent-core.ts` — the ONE brain: model loop, many tool calls/turn, bounded by rounds+errors.
- `src/jarvis/build.ts` — wires the whole brain (used by DO, tests).
- `src/apps/connector.ts` — connector contract + HttpAppConnector (list tools/call tool/context); failure visible.
- `src/apps/app-registry.ts` — connected_apps registry (in-memory).
- `src/apps/app-manager.ts` — loads an app's tools into the same catalogue (namespaced); inherits confirmable.
- `src/apps/app-tools.ts` — connect_app (confirmable setup)/disconnect_app/list_connected_apps/app_context.
- `src/apps/app-events.ts` — app-event store + wakeOnAppEvent (senses); model decides what it means.
- `src/apps/fake-app.ts` — in-process fake app for tests (publishes a normal + a confirmable tool).
- `src/voice/pin.ts` — owner PIN verifier (hash compare, fail-closed) + guest PIN hashing.
- `src/voice/call-session.ts` — per-call state: caller role + this-call pinVerified + guest history.
- `src/voice/caller-id.ts` — identify owner/guest/unknown by phone (fail-closed; id never authorizes actions).
- `src/voice/guests-repo.ts` — guests registry (name, phone, pin hash, access, expiry).
- `src/voice/guest-prompt.ts` — minimal guest prompt; no owner profile/memory/tools.
- `src/voice/voice-tools.ts` — pin_verify, call_place (not connected), guest_create, guest_revoke.
- `src/voice/twiml.ts` — ConversationRelay Connect TwiML pointing at the DO websocket.
- `src/voice/twilio-signature.ts` — Twilio HMAC-SHA1 signature verify (fail-closed).
- `src/scheduler/wakeups-repo.ts` — wake-ups store (sorted by fire time).
- `src/scheduler/wakeup-scheduler.ts` — single DO alarm always pointed at the earliest; fireDue delivers due ones.
- `src/scheduler/wakeup-tools.ts` — schedule_wakeup / list_wakeups / cancel_wakeup (model supplies the instant).
- `src/scheduler/time-zones.ts` — Eastern wall-clock via Intl (DST-correct, no hardcoded offset).
- `src/scheduler/cron.ts` — cron entry: fire due wake-ups, hourly check, watchdog ping, nightly backup.
- `src/plumbing/bucket.ts` — Bucket interface + InMemoryBucket + R2 adapter (production swap-in).
- `src/plumbing/backup.ts` — nightly export of every table + every row (no silent truncation).
- `src/plumbing/archive.ts` — conversation archive by date + archive_search tool.
- `src/plumbing/heartbeat.ts` — per-component liveness (alive vs quiet).
- `src/plumbing/watchdog.ts` — external ping (Healthchecks.io); honest not_connected when unset.
- `src/plumbing/vault.ts` — vault markdown export (processes EVERY note) + token gate (fail-closed).
- `src/channels/telegram-channel.ts` — real Telegram send; surfaces delivery failures.
- `src/channels/fake-owner-channel.ts` — test channel; can be told to fail.
- `src/router/telegram-webhook.ts` — signature + owner checks (fail closed) + provenance.
- `src/index.ts` — Worker router + JarvisDurableObject (production wiring).
- `src/school/canonical.ts` — canonical JSON, byte-compatible with the school app (ported reference).
- `src/school/signed-request.ts` — Ed25519 envelope verify over exact body bytes (ported reference).
- `src/school/collector-protocol.ts` — parseSchoolBatch + verifyCollectorRequest, single-use nonces.
- `src/school/collector-keys.ts` — D1 collector key registry (pending/active/revoked, approve-by-code).
- `src/school/evidence-store.ts` — D1 evidence rows (latest-good-per-course, history, freshness).
- `src/school/school-requests.ts` — D1 pull-queue (sync_now/open_item/notify; queued→delivered→succeeded).
- `src/school/evidence-items.ts` — batch → typed items/grades/courses/gaps; diffExtracted for changes.
- `src/school/routes.ts` — the 4 school HTTP routes (pairing start/prove/status + observations).
- `src/school/school-tools.ts` — the 7 school tools (snapshot/changes/sync/open/approve/revoke/status).
- `src/persistence/d1.ts` — D1Db interface mirroring the real binding (prepare/bind/first/all/run).
- Every `*-repo.ts` — now an async `*Store` interface + in-memory impl + `D1*` impl, same semantics.
- `migrations/0002_school_surface.sql` — app_events, heartbeats (0001 missed them), school keys/nonces/evidence/requests.
- `migrations/0001_init.sql` — D1 schema mirroring the repos.
- `wrangler.toml` — Cloudflare config (D1/R2/Vectorize/AI/Queues/DO/cron).

## Tests (all fail if the behaviour breaks)

- `test/phase1-nervous-system.test.ts` (7): reply + stored conversation; history reaches the model;
  time/tz injected; every tool call logged; empty reply surfaced+logged; model error surfaced+logged;
  failed send surfaced honestly.
- `test/phase2-memory.test.ts` (8): provenance quote pass/fail; temporary needs expires_at (no default);
  meaning search drops hidden/expired; temporary expiry; corrections version+link; pinned facts injected;
  one store serves text+voice.
- `test/webhook.test.ts` (8): fail closed (no secret / no owner); wrong secret 401; non-owner not processed;
  owner accepted; forwarded/private/group provenance; inline-tap callback classified.
- `test/phase4-confirmations.test.ts` (7): confirmable held as pending (not executed); no same-turn
  self-confirm; executes only after a later confirm and is honestly `not_connected`; args-hash binding;
  shadow logs would-have; TTL expiry; receipts_query proof.
- `test/phase3-connected-apps.test.ts` (6): one message connects an app (confirmed) and loads its tools;
  an app tool works on text AND voice; an app's confirmable tool routes through Jarvis's gate; an app
  event wakes Jarvis which decides whether to tell Sid; a down app returns an honest error; a fact from
  an app event is stored with the app as its source.
- `test/phase5-calling.test.ts` (10): a call uses the same tools/memory as text; prompt says CHANNEL:voice;
  a sensitive action refuses without a verified PIN; proceeds (honestly not_connected) with a correct PIN;
  wrong/missing PIN fails closed; caller-id classifies owner/guest/unknown (and fail-closed with no owner
  phone); a guest gets a minimal prompt with no owner facts/memory/tools and no shared-history write;
  Connect TwiML built; Twilio signature verified (fail-closed); hashed PIN is not plaintext.
- `test/phase6-daily-rhythm.test.ts` (6): schedule_wakeup validates + alarm; alarm tracks the earliest;
  fires only PASSED wake-ups (asserts which firing); Eastern DST wall-clock (EST + EDT); hourly cron fires
  due wake-ups, hands Jarvis an hourly check, pings watchdog, beats, and the MODEL chooses to send a digest;
  nightly cron runs only the backup.
- `test/phase7-plumbing.test.ts` (7): backup exports every table + every row (100, not capped); archive by
  date + search across range incl call transcripts; archive_search tool; heartbeat alive-vs-quiet; watchdog
  honest not_connected vs a real ping; vault export processes EVERY note (101, not 64); vault token fail-closed.

- `test/persistence.test.ts` (8): every D1 adapter against REAL SQLite running the REAL
  migration files (facts chain/expiry, conversation rollup, receipts filters, pending guards,
  settings, wakeups/guests/apps/events/heartbeats, school nonce SQL, schema CHECK refusal).
- `test/school-protocol.test.ts` (22): canonical known-answer vectors; batch accept/reject
  (extra field, numeric/future/shifted timestamps, duplicate route, host-failure rules, JSON 403
  as evidence); full Ed25519 round-trip with real keys; nonce single-use; numeric-issuedAt
  refusal; 5-min skew; tampered body; non-canonical body; wrong principal; inactive key.
- `test/school-routes.test.ts` (14): full pairing loop (start/prove/status/approve/retry) over
  real SQLite; bad bodies/challenges/replays/revokes/expiry; observations good+failed stored;
  extractors against the app's REAL D2L fixtures (linked grades/weights/feedback, deep links,
  content, enrollments, ambiguity, refused reads); batch diffing; all 7 tools incl fail-closed.

## Mutation checks done this session (trap: don't trust green until you mutate)

Each guard below was broken on purpose; the named test went red; then reverted. See the
"Mutation sweep" section at the bottom of this file for the exact edits and results.

- Provenance substring check → phase2 "refuses a stated fact whose quote is NOT in..." went red.
- Webhook fail-closed (no secret) → webhook "fails closed when the webhook secret..." went red.
- Same-turn self-confirm guard → phase4 "refuses to self-confirm within the same turn" went red.
- Confirmation gate (ran the action on first call) → phase4 "holds a confirmable action as pending" went red.
- Temporary-expiry in FactsRepo.isActive → phase2 "temporary facts drop out of recall" went red.
- App-tool confirmable propagation (forced false) → phase3 "routes through Jarvis's enforced confirmation" went red.
- App failure visibility (fake pretend-success) → phase3 "failure is visible: a down app..." went red.
- Voice PIN enforcement in the gate (disabled) → phase5 "a sensitive action on a call REFUSES without a verified PIN" went red.
- Guest branch in agent core (removed) → phase5 "a guest call gets a minimal prompt..." went red.
- Wake-up due-time check (fire everything) → phase6 "fires only wake-ups whose time has PASSED" went red.
- Vault export capped at 64 (the old bug) → phase7 "processes EVERY note" went red.
- Vault token fail-open (no token => allow) → phase7 "token-gated and fails closed" went red.
- Nonce insert disabled → school-protocol "refuses to reuse a nonce" went red.
- Exact-field check disabled → school-protocol "rejects an extra field anywhere" went red.
- D1 expiry comparison flipped (`>` to `<`) → persistence "facts expiry" went red.
- Unpublished-announcement filter disabled → school-routes "extracts announcements..." went red.

## Decisions not in the brief (mine, flagged for Sid)

1. **Branch name.** The task asked for `rebuild/agent-1`, but this Arena session is hard-fixed to
   the branch `arena/01a0ded1-jarvis` (the platform tracks the session by it; work on any other
   branch is lost). I kept the ISOLATION intent exactly — every change is under `rebuild/`, nothing
   outside is touched — but on this session branch, and the draft PR is opened from it. If you want
   the literal `rebuild/agent-1` branch, say so and a maintainer can `git branch rebuild/agent-1`
   off this one; the diff is identical.
2. **Confirmation "yes" path.** A typed YES is interpreted by the MODEL, which then calls
   `confirm_action(pending_id)`; code only checks the pending action exists, is Sid's, is unexpired,
   and was not created in the same turn. A Telegram inline TAP is a structured callback the code can
   act on directly (strongest path). Code never reads the word "yes".
3. **Confirmation summary.** Each confirmable tool accepts an optional `confirmation_summary` the
   model writes; if omitted, the gate builds a factual `tool(args)` description (a receipt, not a
   judgment).
4. **connect_app is confirmable.** Section 3 says only the five actions ask for confirmation, but
   Phase 3 says connecting an app is "a one-time setup step with a confirmation." I honored Phase 3:
   `connect_app` routes through the same enforced gate, because granting an app a place in the tool
   catalogue is a permission change. Flagged here so it isn't read as a sixth everyday confirmation.
5. **School protocol ports (exact sources).** `src/school/*` is ported from stremysid/jarvis at
   commit 0c56920: `apps/d2l-extension/protocol.js` (canonical, envelope shape) and
   `apps/cloud-gateway/src/school/collector-protocol.ts` + `src/sync/signed-request.ts`
   (parseSchoolBatch, verifyCollectorRequest, nonce handling). Error strings kept identical.
   One simplification: no `principals` join — single-owner system, owner id comes from env.
7. **All stores are async now (D1 is async-only).** The sync repos were the test shortcut;
   every store is an async interface with an in-memory + a D1 impl. `isActive`/`isExpired` stay
   sync (pure checks on objects). The DO uses D1 stores when `env.DB` is bound, in-memory in
   local dev. D1 summary rows sort first like the in-memory splice; the `cron.ts` Date.now fixed.
8. **Persistence tests run the real migrations** via `?raw` imports into sql.js (real SQLite).
   The shim implements the same D1Db surface production passes the binding into.
6. **School app `issuedAt` break (found 2026-09-26).** The app sends `issuedAt` as an epoch
   NUMBER; the proven receiver requires an ISO-8601 UTC STRING and rejects anything else
   before signature check. The app's fake-gateway test never validated the field, and live
   pairing was never attempted, so it shipped uncaught. Fix direction: app sends ISO strings
   (matching the reference), pinned by a refusal test on this side + app-side vectors.
9. **Grade-objects route added to the evidence allow-list.** The ported reference accepted
   only `grades/values/myGradeValues/`; without the grade objects there is no weight and no
   tool linkage, so `school_snapshot_read` could never report either. Both sides are owned and
   nothing is deployed, so the `grades/` route is accepted (receiver now, app sends it next).
10. **School surface requires D1, no in-memory fallback.** Keys, nonces, evidence and the
    pull queue are security/correctness state — an in-memory version would silently unpair
    devices and lose evidence on eviction. Routes 500 and tools report `not_connected` without
    `env.DB`, and local `wrangler dev` ships a real D1 so this costs nothing.
11. **Discussions deferred, reported as a gap.** Per-forum topic reads need dynamic routes;
    the snapshot reports `discussions are not pushed by the extension yet` instead of empty
    silence, so the model never claims there is nothing to discuss.

## What is faked, and why

- **DeepSeek model** — no API key in the sandbox. Tests use a scripted FakeModel. The real
  `DeepSeekModel` is written and type-checked but never called here. No keyword fallback exists.
- **Workers AI / Vectorize** — cannot run in the sandbox. `WorkersAiEmbeddingProvider` and
  `CloudflareVectorizeIndex` are tested only against fakes shaped like the bindings. Tests use a
  bag-of-words embedding that proves the recall PATH, not semantic quality. The Worker never uses
  that fake: without the AI binding it uses `UnavailableEmbeddingProvider` (fails loudly).
- **D1** — tested against real SQLite (sql.js) running the real migration files 0001–0003. Not
  run against Cloudflare's D1 itself.
- **R2** — `R2BucketAdapter` tested against a paging fake of the R2 list API; not real R2.
- **Durable Object alarm** — `alarm()` + `storage.setAlarm` are wired in `src/index.ts`, which
  has no test harness (no Miniflare here). The alarm's logic (`fireDue` + `fireWakeup`) is tested.
- **Telegram / Twilio** — no credentials. `TelegramChannel` is real code, unrun.

## Honesty audit (against the brief's mandatory rules)

- No fake success: the five actions return `not_connected`.
- Fail closed: webhook refuses with no secret; owner refuses with no OWNER_CHAT_ID; model throws with no key.
- Code never reads Sid's words to decide.
- No silent drops: empty reply, model error, failed send, empty summary, failed archive write,
  failed wake-up, failed memory review, and un-indexed facts are each recorded and surfaced.
- No keyword fallback pretending to be the model (and none pretending to be the embedder).
- Tool-count: the full catalogue is sent to the model.

## Not yet built (be honest with Sid)

- Email in (Cloudflare Email Worker for school@onesid.ca) and out (Gmail API / MS Graph). Lost; to rebuild.
- Twilio REST (outbound call/SMS) and the ConversationRelay WebSocket loop on the DO. Lost; to rebuild.
  The `/voice` webhook, signature check, TwiML, PIN and guest logic exist and are tested.
- Windows PC agent (`apps/pc-agent`) incl. vault sync script. Lost; to rebuild.
- The five action tools are wired to NO real provider — each returns `not_connected`.
- `/vault/export` still reads `facts.all()` (includes hidden/superseded versions); decide with Sid
  whether forgotten facts belong in his Obsidian vault.
- Nothing is deployed.

---

## Honesty audit (against the brief's mandatory rules)

- No fake success: the five actions return `not_connected`; nothing logs "Executed"/dispatched:true.
- Fail closed: webhook refuses with no secret; owner refuses with no OWNER_CHAT_ID; model throws with no key.
- Code never reads Sid's words to decide: no `if text == "YES"`; confirmations are code-validated only.
- No silent drops: empty reply, model error, and failed send are each logged + surfaced.
- No keyword fallback pretending to be the model: MissingModelKeyError, said plainly.
- Tool-count: the full catalogue is sent to the model; there is no cap below the real tool count.

## Not yet built (be honest with Sid)

All seven phases' feature code is built and tested. What remains is deploy-side wiring, not new features:
- D1/DO/Vectorize/R2 production persistence adapters (in-memory / fake stand-ins today). Repos are
  written against `migrations/0001_init.sql`'s shape, so this is adapter work, not a redesign.
- Durable Object state persisted across evictions (today the DO keeps state only for its lifetime).
- The DO WebSocket loop that streams ConversationRelay call turns (the `/voice` webhook + all voice
  logic exist and are tested; this is the transport that carries a voice turn into the same agent core).
- The five action tools are wired to NO real provider on purpose — each returns `not_connected`.

---

## Signature (previous session)

Built by:
- Model name and version (as you know yourself): UNKNOWN (Arena.ai Agent Mode; underlying model not disclosed to me for signing)
- Company that made you: Arena.ai (Agent Mode platform); underlying model vendor: UNKNOWN
- Reasoning / effort level (if known): UNKNOWN
- Knowledge cutoff: UNKNOWN
- Session date and time (UTC): 2026-09-26
- Phases completed this session: all 7 (Phases 1, 2, 3, 5, 6, 7, and the full confirmation/shadow/receipts scope of Phase 4) + connector buildout (school protocol, full D1 persistence, school routes + pairing + school tools)

---

## Mutation sweep (this session)

| Guard mutated | Edit | Test that went red | Reverted |
|---|---|---|---|
| provenance quote check | `verifyQuote` made to always pass | phase2 provenance-refusal | yes |
| webhook secret fail-closed | returned ok when secret unset | webhook fail-closed | yes |
| same-turn self-confirm | dropped the `creatingEventId === currentEventId` check | phase4 self-confirm | yes |
| confirmation gate | ran the tool directly in `dispatch` for confirmable | phase4 "held as pending" | yes |
| temporary expiry | `isActive` ignored `expiresAt` | phase2 temporary expiry | yes |

---

## Increment: school app connection-ready + pull channel (2026-09-26)

User direction: the school app tracks only the five D2L tiles (Course Home / Content /
Assignments / Grades / Quizzes) through the existing surfaces, sends raw per-surface
evidence, and never synthesizes due dates; Jarvis adjudicates due dates from linked
surfaces and asks Sid when uncertain. Jarvis stays read-only toward school.

Jarvis side (`src/school/`, protocol-compatible with the old cloud-gateway collector
contract — Ed25519, 5-min skew, race-safe nonces, active-key-only):
- `POST /school/pull` — signed, oldest-first handover of up to 10 queued requests,
  marks them delivered; pending/unknown keys get 403.
- `contentRefs[]` on assignment/quiz evidence + topic `dueAt` capture: links
  dropbox/quiz items to the Content topics that carry real due dates
  (fixture: Lesson 1.1 -> 2026-09-12T03:59:00.000Z).
- School tools now carry due-date adjudication guidance: link surfaces first,
  `memory_save` only confirmed dates, ask Sid when uncertain.

App side (`apps/school-helper/`):
- Sync scope cut to the tiles: no completion-progress, rubric, or discussion reads;
  new `gradeObjects` evidence route for `/grades/` (object definitions).
- Envelope `issuedAt` is now an ISO-8601 string (receiver requirement, was epoch ms).
- Gateway URL default emptied (old cloud URL must never be usable); unset URL
  refuses to send; pairing `410` maps to new `expired` status.
- `jarvis-pull` alarm (2 min) + `jarvis:pull` message + `pullAndExecute`:
  `sync_now` runs sync/push, `open_item` opens only allow-listed D2L origins.
- Due/overdue language gated to assignments + quizzes (`DEADLINE_KINDS`); other
  tiles show availability; JarvisLink UI has pull button + corrected help text.

Verification: root `tsc` clean, `vitest` 105/105; app `tsc` clean, `vitest` 238/238.

Repo note: this branch's history is `18b0570` (PR #1 school app) -> `6a34ccf`
(collector protocol) -> `3f1bc3a` (D1 persistence) -> `5bd2f20` (school routes +
pairing + tools) -> this increment.

---

## Session: memory hardening (2026-09-26, branch arena/01a0e025-jarvisrebuild)

Triggered by the main-repo builder's review of the memory report (false present-tense claims:
"zero data loss across evictions", Vectorize live, history_search date_range). Reading the code
found worse problems than the review listed; all fixed and tested here.

**Bugs found in the code (proven by reading it, then by tests):**
1. Summarizing DELETED old messages from D1, and `ArchiveService.append` was never called
   anywhere — so after ~40 messages, conversation was gone for good except the model's summary.
2. The DO used `InMemoryVectorIndex` even with Vectorize bound (meaning search empty after every
   eviction) and silently fell back to the bag-of-words fake when Workers AI was missing.
3. Archive and backups used an in-memory bucket in production (R2 never wired); the backup
   skipped the `messages` table and exported `pending_actions` as `[]`.
4. The DO had no `alarm()` handler and `setAlarm` was a no-op, so wake-ups fired only on the
   hourly cron (up to 59 min late). A wake-up whose model call failed was removed anyway.
5. No quiet-conversation memory review existed; the hourly cron never asked for a memory review.
6. `MEMORY_EXTRACTION_MODEL` was declared but never read.
7. `memory_correct` let a "stated" correction skip the quote check, discarded its required
   `reason`, copied the OLD fact's source onto the new version, and could fork the chain by
   correcting an outdated version.
8. During any wake-up, a "stated" save could never pass provenance (the quote was checked against
   the wake-up text), and forwarded messages were accepted as Sid's own words.
9. `R2BucketAdapter.list` ignored R2's 1000-key paging (silent truncation).
10. `WATCHDOG_PING_URL` was never wired, so the watchdog was always `not_connected` in production.

**What changed (file → one line):**
- `migrations/0003_memory_hardening.sql` — messages.rolled_up/forwarded/source_ref; facts.source_message_id/correction_reason/indexed; memory_runs; wakeups.kind. **Apply before deploying this code.**
- `src/conversation/conversation-repo.ts` — context view vs record; summaries roll up, never delete; `search` (since/until/channel/limit, totals, coverage); `since` (review windows, cap never splits an instant).
- `src/memory/provenance.ts` — `resolveStatedSource`: a stated fact must quote one real, non-forwarded message of Sid's (live turn, or cited `source_message_id`).
- `src/memory/facts-repo.ts` — `correct(id, input)` with reason + own provenance; refuses outdated versions (D1: guarded UPDATE); `markIndexed`/`unindexedActive`; D1 reads re-checked by `factIsActive`.
- `src/memory/memory-tools.ts` — tools above; `limit` required on both searches (model chooses, never defaulted); memory_search reports `notYetIndexed`; memory_explain shows status, reason and the quoted source message; index failures reported, not thrown.
- `src/memory/memory-review.ts` — `memory_runs` ledger (in-memory + D1), cursor advances only on success, `MemoryReviewer` hands the model the unreviewed messages with ids.
- `src/memory/embeddings.ts` — `CloudflareVectorizeIndex`, `UnavailableEmbeddingProvider`, `reindexUnindexed`.
- `src/jarvis/agent-core.ts` — stores provenance per message, `currentMessageId` for tools, archives every message, arms the quiet-review timer, returns per-tool outcomes, model override for reviews, empty summaries logged.
- `src/scheduler/*` — wake-up kinds, debounced system timer, `fireDue` keeps failed wake-ups (5-min retry floor), shared `fireWakeup`, hourly cron runs review + re-index.
- `src/plumbing/{archive,bucket,backup}.ts` — one R2 object per message; paginated R2 list; `BackupService.fromD1` dumps every table.
- `src/index.ts` — Vectorize, R2, D1 memory runs, extraction model, watchdog URL, `alarm()` + `storage.setAlarm`.

**Decisions not in the brief (flagged for Sid):**
- Quiet period before a memory review: **20 minutes** (`MEMORY_REVIEW_QUIET_MS`). A wake-up cadence, not a judgment; change it if reviews feel too eager/late.
- Review window cap: 200 messages; per-message 4000 chars in the review prompt (full text via history_search). Both reported when they bite.
- `limit` is now REQUIRED on memory_search and history_search (was defaulted to 10 / hard 50).
- `memory_forget` hides the fact, not the conversation it came from; the tool tells the model to say so.

**Tests:** 139/139 (was 105). New suite `test/memory-hardening.test.ts` (34 tests), D1 ones on real SQLite with migrations 0001–0003.

**Mutation checks this session (each planted fault → a test went red → restored):**

| Guard | Planted fault | Result |
|---|---|---|
| summary never deletes (D1) | `UPDATE … rolled_up = 1` → `DELETE` | red |
| forwarded ≠ Sid's words | skipped the isForwarded check | red |
| stated needs a verified quote | skipped the stated branch | red (4) |
| review cursor only on success | counted error runs (in-memory) | red |
| review cursor only on success (D1) | `status IN ('ok','error')` | red |
| cap never skips an instant | fallback → `slice(0, cap)` | red (2) |
| failed wake-up kept | dropped the `continue` | red |
| R2 pagination | returned after page 1 | red |
| archive written | archive() early-return | red (2) |
| one quiet timer | removed `removeKind` | red |
| no forked correction chains | removed superseded check | red |
| owner wake-up errors retried | removed the throw | red |
| history sees rolled-up messages | filtered `rolledUp` out | red (2) |

The quiet-review mutation sweep found one real bug in my own first version (cap fallback could
skip messages sharing an instant forever); fixed and pinned by two tests before commit.

## Signature (this session)

Built by:
- Model name and version (as you know yourself): UNKNOWN (Arena.ai Agent Mode; not disclosed for signing)
- Company that made you: UNKNOWN
- Reasoning / effort level (if known): UNKNOWN
- Knowledge cutoff: UNKNOWN
- Session date and time (UTC): 2026-09-26 (time of day UNKNOWN)
- Phases completed this session: none new; memory hardening across Phases 2, 6 and 7 (conversation never deleted, provenance, corrections, history_search, memory reviews + extraction model, Vectorize/R2/alarm wiring, full backup)
