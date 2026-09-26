# DECISIONS.md

Every decision made without stopping to ask, and why. Newest at the bottom.

---

### 1. Seed files were not attached — built the importer, shipped no seed content

**Context:** The brief said to attach `01_tracker.md` … `06_bbb4m_handoff.md`. They were
not in the workspace. Asked in the one permitted question batch; the answer was
_"Skip seed content, build importer only."_

**Decision:** No fabricated seed data. `src/importer/markdown.ts` is written to be
shape-tolerant (tables, checklists, headings, "Questions for X" sections, style guide,
handoff notes) and is covered by 12 tests against a representative tracker file.

**Consequence:** Drop the real files into _Import tracker files_ on first run; no code
change needed. If the real files use a layout the importer misses, the warnings panel says
which rows were skipped rather than failing silently.

---

### 2. No GitHub connector — local git repo, local release artifacts

**Context:** The engineering standards call for a private GitHub repo as the single source
of truth. No GitHub connector is attached to this session. Confirmed in the question batch.

**Decision:** Full local git history on `main` with feature branches merged in, a `v1.0.0`
tag, and `release/` containing the packed zip, SHA-256 and release notes carrying the source
commit and date. `NEXT_STEPS.md` has the two commands to push this to a private repo.

---

### 3. Reads go through the service worker, not content scripts

**Context:** Either could issue the same-origin D2L requests.

**Decision:** The service worker does all fetching, using host permissions. Content scripts
only report which page is open and mount a small launcher.

**Why:** A D2L page's CSP can't interfere; no page script can observe the data; and it keeps
content scripts small enough to stay self-contained (MV3 forbids ES modules in content
scripts — `scripts/postbuild.mjs` now fails the build if Rollup ever splits one).

---

### 4. Version negotiation instead of hard-coded Valence versions

**Context:** LDSB and Durham are separate Brightspace tenants on possibly different releases.
A hard-coded `/le/1.69/` 404s on an older tenant.

**Decision:** `D2lClient.negotiateVersions()` reads `/d2l/api/versions/` and pins to the
highest supported version at or below what the parsers target.

---

### 5. Durham SSO: probe first, then follow the widget link

**Context:** Durham is only reachable through the LDSB homepage widget.

**Decision:** `ensureDurhamSession()` tries Durham's `whoami` first (the cookie usually
survives), and only if that fails does it load the LDSB homepage, find the cross-board link
by pattern, and GET it to run the redirect chain. All GET, no credentials touched.

**Risk:** The link patterns are guesses — no live HTML was available. If they miss, sync
reports a clear message telling you to click through the widget once by hand. Listed in
`KNOWN_ISSUES.md` as the highest-risk untested path.

---

### 6. Manual edits use an explicit override map, not "last write wins"

**Context:** "Manual edits must survive the next sync" is a hard requirement, and a naive
timestamp comparison loses to a sync that happens to run later.

**Decision:** `WorkItem.overrides` records `{field, value, editedAt}`. `mergeItem()` skips
any field with an override, permanently, until the user clicks **Release**. User-owned fields
(`notes`, `tags`, `completed`) are never touched by sync at all.

**Also:** `undefined` from a parser means "sync had nothing to say" and never blanks a stored
value — so a partial read can't erase a grade you already have.

---

### 7. Vanished items are flagged, never deleted

A teacher hiding a module shouldn't destroy your notes. Missing items get
`presentInLastSync: false` and a "removed" change record, and stay in the database.

---

### 8. The no-finished-answers rule is enforced three times, in code

**Context:** The brief calls this a hard product rule. A system prompt alone is not an
enforcement mechanism — models drift, and prompts get edited.

**Decision:** (a) `HARD_RULE` in the system prompt; (b) a rigid output format of headed
bullet lists; (c) `enforceNotesOnly()` post-checks every response and deletes any non-bullet
block of three or more sentences, truncates over-long bullets, and rejects the whole reply if
nothing survives. There is no setting that disables any layer. Five tests lock this down.

**Same idea for the rubric check:** suggested edits whose `before` text is not a literal
substring of your own answer are silently discarded, so the model cannot smuggle in new
sentences under the guise of an edit.

---

### 9. Google OAuth via PKCE with a user-supplied client ID

**Context:** A client ID shipped inside a publicly distributed extension is not a secret, and
`chrome.identity.getAuthToken` only works with a Chrome Web Store listing and a Google
account signed into the browser — neither applies here, and it would not work in Opera GX.

**Decision:** `chrome.identity.launchWebAuthFlow` + PKCE, with the client ID pasted into
Settings by the user. No client secret is ever needed. Works identically in Chrome and
Opera GX; the redirect URI differs per extension id, and Settings displays the exact value
to paste into Google Cloud.

---

### 10. Docs formatter works on the API document model, with a text snapshot for undo

**Context:** The Docs editor is canvas-based; DOM automation is out.

**Decision:** `documents.get` → pure planning function → preview table → one `batchUpdate`
with `requiredRevisionId` so a document edited since the preview is rejected rather than
corrupted. Requests are emitted back-to-front by index so earlier edits don't invalidate
later ones.

**Undo limitation:** the undo record stores the full paragraph text and restores it by
replacement. That reverses content changes exactly, but character formatting applied before
the run (bold, colours) is not restored. Stated in `KNOWN_ISSUES.md`.

---

### 11. Two independent gates on every AI call, enforced in the provider, not the UI

`localModelOnly`, the monthly budget, and the disclosure acceptance are all checked inside
`complete()`. A future UI bug cannot route around them. The disclosure shows the literal
payload before sending.

---

### 12. Keys encrypted with a device key — and the limit of that is documented

AES-GCM under a PBKDF2-derived key from a random secret in `chrome.storage.local`. This
defeats a casual read of the IndexedDB file. It cannot defeat malware already running as
this user, because the secret must be readable by the extension. Said plainly in the README
and `KNOWN_ISSUES.md` rather than implied to be stronger than it is.

---

### 13. A failing read never kills a sync

Found by a test: a 500 on the content tree aborted the whole course. Each read in
`syncCourse()` now goes through a `safeRead` helper that records the error and returns null,
so one dead endpoint costs you one resource, not the whole subject.

---

### 14. Gradebook comments never overwrite drop box feedback

Also found by a test. A one-line gradebook comment was clobbering the longer feedback
attached to the submission. Drop box feedback now wins; the gradebook comment only fills an
empty field.

---

### 15. Scrubbing uses the actual key, not just key-shaped regexes

A test proved the regex backstop missed a short key echoed back inside a provider's 401 body.
`scrubSecrets(text, [apiKey])` now redacts the literal key it used, with the regexes kept as
a secondary net.

---

### 16. Quizzes are listed, never opened

The endpoint map deliberately contains no quiz-attempt or question read, and
`assertSafePath` blocks `/attempts/` URL shapes. Listing a quiz tells you it's due; anything
more edges toward taking it.

### 17. The Jarvis link speaks Jarvis's real protocol, not the one in the brief

The brief specified `POST /apps/{appId}/events`, a shared secret in an
`Authorization: Bearer` header, and an `X-App-Id` header. The deployed
cloud-gateway (`stremysid/jarvis`) has no `/apps/*` namespace, no bearer-secret
auth for the school surface, and no `X-App-Id`. Its school surface is four
paths — `/school/pairing/{start,prove,status}` and `/school/observations` —
authenticated with a per-device Ed25519 key, a pairing handshake and an owner
approval tap in Telegram.

Building the brief's contract would have produced something that could not
connect. Building the real one means the link works against Jarvis as it exists.
All wire code sits behind the `JarvisTransport` interface, so a second contract
is an added implementation rather than a rewrite. Confirmed with Sid before
building.

### 18. Scribe output does not pass through `enforceNotesOnly`

`ai/guardrails.ts` stops the AI writing Sid's answers for him. Scribe output is
already Sid's answer, in his own words — running it through a notes-only filter
would mangle his work and solve a problem that does not exist here.

The protection is different and, for this purpose, stronger. Answer notes rely
on a model obeying an instruction. Scribe relies on a mechanical word-level diff
that compares the cleaned text to the raw transcript and lists every word that
was added. Filler, punctuation, capitalisation, spelling fixes of words he did
say, and contraction changes are forgiven; everything else is highlighted and
named before he can accept. A model that ignores the prompt is caught, not
trusted.

`enforceNotesOnly` and the answer-notes path are unchanged.

### 19. School Helper replaces the Jarvis D2L collector rather than coexisting

Both read the same two boards with the same account. Running both doubles the
API load and produces duplicate evidence, and the collector's own runbook says
not to run two. School Helper is the more complete reader, so it takes over and
sends the same raw evidence the collector would have sent. The collector was
never loaded or paired, so nothing was lost. Its removal steps are in
`docs/JARVIS-LINK.md` §1.

### 20. Evidence is read separately from School Helper's own sync

The push does its own GET-only read using the collector's route list rather than
deriving batches from parsed `WorkItem`s. Deriving them would put School Helper's
interpretation on the wire, which is exactly what Jarvis must not receive — it
decides what the facts mean. The cost is a second read pass; the benefit is that
what Jarvis gets is D2L's own bytes.
