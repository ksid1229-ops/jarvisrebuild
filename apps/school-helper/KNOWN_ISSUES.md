# KNOWN_ISSUES.md — v1.0.0

Honest list. Ranked by how likely it is to bite you.

## High — untested against live services

### 1. The D2L parsers have never seen a real response

Every parser was written against D2L's documented Valence shapes and tested with fixtures
built by hand. No live LDSB or Durham response was available during the build.

**What will probably happen:** some fields come back in a slightly different shape, or a
tenant customisation changes a key name, and a few items get skipped or lose a date.

**What to do:** turn on **Settings → Capture debug fixtures**, run one sync, then
**Export fixtures**. That file is redacted (names, emails, OENs stripped). Hand it back and
the parsers can be hardened against the real shapes in an afternoon.

### 2. The LDSB → Durham SSO jump is a best guess

`findCrossBoardLinks()` looks for `remoteplugin`, `externallearningtools`, `lti/launch`,
`/d2l/lp/auth/` and any URL containing "durham". Those patterns come from how Brightspace
cross-board widgets are usually built, not from your actual homepage HTML.

**Workaround if it fails:** open Durham D2L once through the widget by hand. The cookie then
exists and sync's first probe succeeds. The error message says exactly this.

### 3. Course outlines are not parsed

Evaluation weights are read from the **gradebook** (`grade objects → Weight`), which is
reliable. A weight that only exists in a PDF or HTML course-outline document is not
extracted. Enter those by hand on the item — manual edits are pinned and survive syncs.

### 4. Google Docs formatting has never run against a real document

The planning logic is fully unit tested (15 tests), but `documents.get` → `batchUpdate`
round-trips were never executed. Run the preview on a **copy** of a worksheet the first time.

## Medium

### 5. Undo restores text, not character formatting

The undo snapshot stores paragraph text. Reverting restores your content exactly, but bold,
italics and colours applied _before_ the format run are not restored, because the snapshot
doesn't capture them. Use "Copy to my Drive" first if a document is precious.

### 6. Key encryption stops a file read, not malware

The AES-GCM key derives from a secret in `chrome.storage.local`, which the extension must be
able to read — therefore so can anything running as you. This protects against someone
copying the IndexedDB file off the disk. It is not a hardware keystore.

### 7. `applySubmission` guesses when it can't identify you

It matches your row by the id from `whoami`. If that read fails and the folder returns
exactly one entity, it assumes that row is yours. With more than one row and no id, it
skips rather than risk showing you someone else's grade.

### 8. Rubric level-4 detection is heuristic

`level4LevelId()` matches "Level 4" / "L4" / "4 (80-100%)" by name, then words like
"Excellent" / "Exemplary" / "Thorough", then the highest-point level. A rubric with unusual
level names could resolve to the wrong column. The full level list is stored, so the UI can
show all of them.

### 9. Answer notes currently pass source _links_, not extracted source _text_

For D2L HTML topics and Google Docs, the notes prompt receives the title and URL rather than
the full extracted body. That means the model has less to cite from than it should, and the
`NOT IN SOURCE` flag will fire more often than necessary. Fetching and extracting topic HTML
and Docs text into the prompt is the top item in `NEXT_STEPS.md`.

### 10. The dashboard polls instead of using live queries

`useLive` re-runs its query every 5 seconds plus on a broadcast event, rather than using
`dexie-react-hooks`. Fine at this data size; visible as a tiny delay after an edit made in
another surface.

## Low

### 11. Side panel behaviour differs slightly in Opera GX

The Chromium side panel slot is used, which is separate from Opera's own GX sidebar. It
works, it just isn't where an Opera user might first look.

### 12. `chrome.alarms` has a 1-minute floor and is throttled when the browser is closed

Reminders fire when the browser is running. A 3-hour warning for something due at 3am while
the browser was shut arrives when you next open it.

### 13. No end-to-end UI tests

Coverage is unit-level: parsers, merge, priority, guardrails, formatter planning, importer,
provider layer, backup, and a fixture-driven end-to-end sync. No Playwright run against a
loaded extension.

### 14. Discussion post counts are class-wide

`PostCount` on a topic isn't "my posts", so discussion completion status is a weak signal.
Tick discussions off manually.

### 15. The Jarvis pull channel does not exist

The brief asked for `GET /apps/{appId}/requests` so Jarvis could ask School
Helper to `sync_now`, `open_item` or `notify`. The gateway has no such route and
no `/apps/*` namespace at all, so the client half was not built — shipping code
that cannot run is worse than not shipping it.

**Blocked on:** a gateway endpoint. Once one exists, add a `pullRequests()`
method to `JarvisTransport` plus the action allow-list (everything outside
`sync_now` / `open_item` / `notify` refused and reported as unsupported, never
executed), a poll on the existing alarm cadence, and
`POST .../requests/{id}/result`. Nothing else in the app changes.
`docs/jarvis-tools.json` already tells Jarvis these two tools are queued intents
rather than instant actions.

### 16. No live push has ever reached the real gateway

`tests/jarvis.receiver-contract.test.ts` transcribes the receiver's
`parseSchoolBatch` and runs every batch shape through it, which caught three
real bugs before release. It is still a transcription, not the receiver. Pairing
against the live gateway, the Telegram approval tap, and actual ingestion are
unverified. **Severity: high** — this is the first thing to check once Sid pairs.

### 17. Scribe cleanup quality depends on the model

The diff catches additions mechanically, so a bad model cannot smuggle content
past Sid. But a weak model may produce output with so many flagged additions
that cleanup is useless, and he falls back to his raw text. Tested against fakes
only; no real provider has run a scribe cleanup.

### 18. The diff forgives short transpositions

`teh` → `the` is treated as a typo fix because the letters match exactly. A
deliberate two-letter content word swapped for an anagram of itself would slip
through. No realistic example found, and the alternative is flagging every
typo fix as an addition, which would make the warning meaningless.

### 19. Speech recognition is Chromium-only and unverified

`webkitSpeechRecognition` is not in the tests' reach beyond a stubbed
constructor. Real dictation accuracy, en-CA behaviour, microphone permission
prompts in Opera GX, and long-session stability are all unverified. The typing
fallback is always present and is the reason this is not blocking.
