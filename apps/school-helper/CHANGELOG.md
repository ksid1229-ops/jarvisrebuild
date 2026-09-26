# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-09-26

Two features: School Helper becomes a connected app for Jarvis, and scribe mode
lands for Sid's scribe accommodation.

### Added — Jarvis link

- School Helper now pushes raw D2L evidence to the Jarvis cloud-gateway, taking over
  from the `apps/d2l-extension` collector. **Off by default**; the app is fully usable
  with it off. Do not run both extensions — see `docs/JARVIS-LINK.md` §1.
- Real gateway protocol: per-device non-extractable **Ed25519** key, pairing
  (start/prove/status) with an owner approval tap in Telegram, canonical JSON, a
  per-attempt nonce, and the four `/school/*` paths. All wire code sits behind a
  single `JarvisTransport` interface.
- Settings → Jarvis link: on/off, gateway URL, device label, pair, check pairing,
  send now, retry queue, and a log of the last 50 calls with time, endpoint, status
  and item count.
- Host permission for the gateway origin is requested through
  `optional_host_permissions` before anything can be sent.
- Bounded outbox: newest 2 batches per host+course, 1 MiB cap, 8 uploads per flush,
  1m/5m/15m/1h/6h backoff. Failures are never reported as sends; evictions are
  counted, logged as `queue-evicted-N` and surfaced as a dashboard warning after
  three consecutive failures.
- `docs/JARVIS-LINK.md` — the full contract with JSON examples.
- `docs/jarvis-tools.json` — tool descriptions for Jarvis (`school_snapshot_read`,
  `school_changes_since`, `school_request_sync`, `school_open_item`).

### Added — Scribe mode

- Answer an assignment one question at a time by voice (`webkitSpeechRecognition`,
  en-CA) or by typing. Typing is always available and never gated behind voice.
- Questions are read from the assignment description, or pasted in when there is
  no description. Prompts are never invented.
- The raw capture is stored before any cleanup and is never overwritten.
- Optional AI cleanup removes filler, false starts and repetition and fixes
  spelling, punctuation and capitalisation — nothing else.
- **Proof, not trust:** a word-level diff shows raw against cleaned, highlights
  every added word and lists them by name. Filler and punctuation don't count;
  anything else does. Scribe output does not pass through `enforceNotesOnly`
  (`DECISIONS.md` #18).
- Export accepted answers in question order: copy, or download as text.

### Fixed

- Three bugs in the evidence path, found by transcribing the receiver's
  `parseSchoolBatch` into a test:
  - `startedAt`/`fetchedAt` were epoch numbers; the receiver requires ISO instants
    and would have refused every batch.
  - A board that failed before discovering any course emitted nothing at all, which
    Jarvis reads as "nothing is due". It now sends the host-failure envelope
    (`course: null`) that the receiver already accepts and the old collector never sent.
  - A course listing the same dropbox folder twice produced a duplicate route label,
    which makes the receiver reject the whole batch.

### Changed

- `Settings → Capture debug fixtures` verified end to end and documented for Windows
  in `README.md`, including three PowerShell checks to confirm redaction before
  sending the file.
- Dexie schema v2: `jarvisOutbox`, `jarvisLog`, `scribeSessions`. Existing data is
  untouched.

### Tests

- 231 passing, up from 120. New: `jarvis.transport` (16), `jarvis.evidence` (19),
  `jarvis.outbox` (18), `jarvis.push` (10), `jarvis.receiver-contract` (10),
  `scribe` (30), `fixtures.capture` (8).

## [1.0.0] — 2026-09-26

First release. Everything below was built in a single run.

### Added — Tracker

- Full-page dashboard opening in its own tab from the toolbar icon, plus a side panel for
  in-page actions on D2L and Google Docs.
- Courses, units, lessons, assignments, quizzes, discussions and announcements with due
  dates, points, weights, submission status, grades and feedback.
- Today / Tomorrow / This week / Overdue buckets, a balanced weekend plan, and a 0–100
  priority score combining due-date urgency, weight and how overdue an item is.
- "What should I do next" on the Today page and in the side panel.
- Per-teacher question lists with add and tick-off.
- Manual edits and notes on any item, pinned so they survive every future sync, with a
  Release control to hand a field back to sync.
- Markdown importer for the tracker seed files: tables, checklists, course headings,
  "Questions for X" sections, style guide and handoff notes.

### Added — D2L sync (read-only)

- Same-origin, cookie-authenticated reader over D2L's Valence LE/LP JSON APIs, with runtime
  API version negotiation per tenant.
- Reads the content tree, drop boxes, submission status, grades, feedback, level-4 rubrics,
  announcements, quizzes, discussions and gradebook weights.
- Finds drop boxes that are linked from content but hidden from the assignments list.
- Handles the LDSB → Durham cross-board SSO jump.
- **Strictly GET.** A guard throws on any other method and blocks state-changing URL shapes.
  Nothing is submitted, posted, or marked as read.
- Diffs each sync against the last and reports new tasks, moved due dates, new grades, new
  feedback, status changes and removed items.
- Items that disappear from D2L are flagged, never deleted.
- Triggered manually, quietly while browsing D2L, and on a periodic alarm.

### Added — AI

- Provider-agnostic layer with independent **cheap** and **strong** roles, each taking base
  URL + API key + model name.
- OpenAI-compatible adapter (OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio) and a native
  Anthropic adapter, with one-click presets.
- **Answer notes:** bullets with per-claim evidence links, drawn only from the sources the
  lesson provides or one the student names. Claims outside those sources are flagged.
- **A hard rule against producing finished, submit-ready answers**, enforced in three
  independent layers with no setting to disable it.
- **Rubric check:** compares the student's own writing against the task's level-4
  descriptors, lists gaps, corrects factual errors, and suggests targeted edits that keep
  their wording. Suggested edits that aren't grounded in the student's actual text are
  discarded.
- Opinion questions are detected and the student is asked to pick a side first.
- Style-guide support so suggestions match the student's voice.

### Added — Privacy

- All data in IndexedDB on the local machine. No cloud, no account.
- API keys encrypted at rest with AES-GCM under a per-device key, never logged, excluded
  from the default export.
- A disclosure before every AI call naming the host, model, token count and cost, with the
  literal payload viewable — enforced in the provider layer.
- "Local model only" hard block, and a monthly spend cap.
- Per-call and per-month cost and token tracking.
- Least-privilege permissions: no `<all_urls>`, no `webRequest`, no `cookies`, no
  `scripting`; wildcards live in optional host permissions only.
- "Capture debug fixtures" with aggressive redaction of names, emails and student numbers.

### Added — Google Docs

- Worksheet formatter over the Google Docs API (not DOM automation): four blank lines
  between question/answer blocks, answers directly under their questions, lists and evidence
  on their own lines, leftover horizontal answer lines and `____` blanks removed, evidence
  turned into links.
- Always previews before applying; every run stores an undo record.
- Revision-locked `batchUpdate` so a document edited since the preview is rejected rather
  than corrupted.
- "Copy worksheet to my Drive".
- OAuth via PKCE with a user-supplied client ID; scope limited to documents the user
  explicitly approves.

### Added — Helpers

- Due-date desktop notifications with configurable lead times.
- End-of-day summary notification and panel.
- One-click teacher email drafts (the student sends them).
- Toolbar badge showing unseen changes.
- JSON export/import backup and restore.

### Added — Engineering

- 120 unit tests against 11 realistic D2L fixture files, including a fixture-driven
  end-to-end sync that asserts read-only behaviour and that manual edits survive.
- ESLint, Prettier, strict TypeScript, all clean.
- Build guard that fails if a content script ever picks up ESM imports (MV3 forbids them)
  or if `VERSION` and `manifest.json` drift apart.
- Packaging script producing a zip, a SHA-256, and release notes carrying the source commit
  and build date.
- Full doc set: `AGENTS.md`, `README.md`, `REQUIREMENTS.md`, `DECISIONS.md`,
  `KNOWN_ISSUES.md`, `NEXT_STEPS.md`, `TESTING.md`, `docs/HANDOFF.md`.

### Fixed during the build (all found by tests)

- A failing read on one D2L endpoint aborted the entire course sync; each read is now
  isolated.
- A short gradebook comment overwrote the longer drop box feedback.
- An API key echoed back inside a provider's error body was not caught by the regex
  scrubber; the actual key value is now redacted explicitly.

### Known limitations

See `KNOWN_ISSUES.md`. In short: no parser has met a live D2L response, the Durham SSO link
patterns are educated guesses, and the Google Docs round-trip is untested against real
servers.

[1.0.0]: https://github.com/OWNER/school-helper/releases/tag/v1.0.0
