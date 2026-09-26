# TESTING.md

## Running the suite

```bash
npm test              # 120 tests
npm run test:watch
npm run lint
npm run typecheck
npm run release       # lint + test + build + pack — the full gate
```

## What is covered, and why it was chosen

There are no real D2L responses available, so the strategy is: **make every parser a pure
function, and test it against realistic fixtures.** Anything that needs the network is kept
out of the parsers so it can't block testing.

| Suite                     | Tests | Covers                                                                                                                                                                       |
| ------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parsers.content.test.ts` | 8     | Content tree flattening, parent links, D2L date parsing, source extraction (including bare Google Docs URLs), activity-link detection, visit progress                        |
| `parsers.dropbox.test.ts` | 7     | Folder parsing, hidden-folder discovery, all five submission status codes, folding _my_ submission row in, ignoring other students                                           |
| `parsers.misc.test.ts`    | 16    | Grades and weights, quizzes, discussions, announcements, level-4 rubric resolution, enrolments, read-only guards, version negotiation, SSO link discovery, fixture redaction |
| `merge.test.ts`           | 8     | The sync/manual-edit merge: change records, pinned fields, never blanking on a partial read, user-owned fields, soft-delete                                                  |
| `priority.test.ts`        | 10    | Priority scoring, buckets, effective due date, weekend plan, "what next"                                                                                                     |
| `guardrails.test.ts`      | 13    | The academic-honesty rules, opinion detection, evidence traceability, rubric-finding parsing                                                                                 |
| `formatter.test.ts`       | 15    | All five Docs fixes, block detection, request ordering, `documents.get` parsing                                                                                              |
| `importer.test.ts`        | 12    | Markdown tables, checklists, course switching, teacher questions, loose date formats, style guide                                                                            |
| `ai.provider.test.ts`     | 13    | Key encryption and scrubbing, cost/token estimation, the disclosure, and all three privacy gates; both adapters against mocked HTTP                                          |
| `backup.test.ts`          | 6     | Export/import round-trip, key exclusion, not wiping local keys                                                                                                               |
| `sync.test.ts`            | 12    | End-to-end sync against a fake D2L serving the fixtures                                                                                                                      |

### The assertions that matter most

- **`sync.test.ts`: every request is a GET**, and no submit / post / mark-as-read URL is ever
  touched. If someone adds a mutating call, this fails.
- **`merge.test.ts` + `sync.test.ts`: manual edits survive a real sync.** A pinned due date
  and a note both survive two full sync cycles.
- **`guardrails.test.ts`: drafted prose is rejected.** A paragraph a student could paste in
  is stripped; note bullets pass through untouched.
- **`guardrails.test.ts`: invented edits are dropped.** A rubric-check suggestion whose
  "before" text isn't in the student's answer is discarded.
- **`ai.provider.test.ts`: the three gates block.** Local-only, undisclosed, and
  over-budget calls all throw before any network call happens.
- **`ai.provider.test.ts`: a key echoed back in an error is not logged.**
- **`backup.test.ts`: a normal export contains no key material.**

Three of these tests found real bugs during the build — see `DECISIONS.md` #13, #14, #15.

## Release gates

Everything below must pass before tagging.

| Gate                                 | How                    | Status for v1.0.0              |
| ------------------------------------ | ---------------------- | ------------------------------ |
| Automated tests                      | `npm test`             | ✅ 120/120                     |
| Lint                                 | `npm run lint`         | ✅ clean                       |
| Format check                         | `npm run format:check` | ✅ clean                       |
| Type check                           | `npm run typecheck`    | ✅ clean                       |
| Build                                | `npm run build`        | ✅ 371 KB unpacked             |
| Packed artifact + checksum           | `npm run pack`         | ✅ `release/`                  |
| **Manual test on Windows, Chrome**   | checklist below        | ⬜ **you**                     |
| **Manual test on Windows, Opera GX** | checklist below        | ⬜ **you**                     |
| **Backup and restore**               | checklist below        | ⬜ **you**                     |
| Security and privacy review          | below                  | ✅ done, see `docs/HANDOFF.md` |
| Acceptance criteria                  | `REQUIREMENTS.md`      | ✅ mapped                      |

## Manual test checklist (Windows, both browsers)

**Install**

- [ ] Loads unpacked with no errors on the extensions page
- [ ] Toolbar icon opens the dashboard in a tab
- [ ] Light and dark themes both render correctly (Settings → Appearance)

**Sync**

- [ ] Logged into LDSB, **Sync now** completes
- [ ] All three courses appear, including CIA4U from Durham
- [ ] Assignments show due dates, points and status
- [ ] A graded item shows its grade and feedback
- [ ] Open DevTools → Network on the service worker: **every request is GET**
- [ ] Nothing in D2L got marked as read (check an unread announcement survives a sync)
- [ ] Second sync reports zero changes

**Manual edits survive sync**

- [ ] Pin a due date on an item, add a note
- [ ] Sync again — both survive, and the item shows the "manual edit" pill
- [ ] Click **Release** on the date, sync — D2L's date returns

**Side panel**

- [ ] Opens on a D2L course page and shows that course
- [ ] Opens on a Google Doc and offers the formatter

**AI**

- [ ] Add a key, **Test this model** succeeds
- [ ] The disclosure appears and shows the real host and payload
- [ ] Turn on **Local model only** — a remote call is refused with a clear message
- [ ] Answer notes produce bullets with `[S1]` citations, **not** paragraphs
- [ ] Rubric check on your own paragraph returns per-criterion gaps

**Google Docs**

- [ ] OAuth completes with your own client ID
- [ ] Preview on a _copy_ of a worksheet lists sensible fixes
- [ ] Apply produces the 4-blank-line layout
- [ ] Undo restores the original text

**Reminders**

- [ ] **Test notification** appears in Windows
- [ ] An item due within a lead window produces a reminder

**Backup and restore**

- [ ] Export a backup; confirm the file contains no `apiKeyCipher`
- [ ] Remove the extension, reinstall, import the backup
- [ ] Items, notes, pinned edits and teacher questions all return
- [ ] Re-enter the API key, confirm it works

## Security and privacy review (done for v1.0.0)

- **Permissions:** `storage`, `unlimitedStorage`, `alarms`, `notifications`, `sidePanel`,
  `identity`, `tabs`. No `<all_urls>`, no `webRequest`, no `cookies`, no `scripting`.
- **Host permissions:** exactly the two D2L origins plus the three Google API origins.
  Wildcards are in `optional_host_permissions` only, so a custom AI endpoint must be granted
  by you at the moment you use it.
- **Content scripts** only report which page is open. They never read form fields, never
  observe input, never fetch.
- **Credentials:** no code path reads, requests, or stores a password. Sync piggybacks on the
  browser's existing session cookie.
- **Secrets:** AES-GCM at rest; `scrubSecrets(text, [apiKey])` before any error is persisted;
  a test asserts a key echoed back by a provider never reaches the call log; the default
  export excludes key material.
- **Egress:** the only outbound traffic is (a) GETs to the two D2L origins, (b) the Google
  APIs you authorise, (c) the AI endpoint you configure. Every AI call is disclosed and can be
  hard-blocked.
- **CSP:** `script-src 'self'` — no remote code execution in extension pages.
