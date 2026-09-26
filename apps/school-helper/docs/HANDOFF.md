# HANDOFF — School Helper v1.0.0

Written for two readers: **Sid**, who needs to install and use it, and **the next session**,
which needs to pick up without re-exploring.

---

# Part 1 — For Sid

## Install it

### Chrome

1. Unzip `school-helper-1.0.0.zip` somewhere permanent, e.g. `C:\Users\<you>\school-helper\`.
   **Do not delete or move that folder afterwards** — Chrome loads it from disk every launch.
2. Go to `chrome://extensions`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked**, select the folder that contains `manifest.json`.
5. Pin the icon: puzzle-piece → pin next to "School Helper".
6. Click the icon. The dashboard opens in a new tab.

### Opera GX

1. Same unzipped folder works — no separate build.
2. Go to `opera://extensions`.
3. Toggle **Developer mode** on.
4. **Load unpacked** → same folder.
5. Click the icon in the toolbar.

If Opera GX doesn't pick up a change after you replace the files, hit **Reload** on the
extension card.

**Note:** the extension gets a _different id_ in each browser. That matters for Google OAuth —
add both redirect URIs (Settings shows you the exact one for whichever browser you're in).

## First-run checklist

Work down this list. It should take about 20 minutes, most of it Google's console.

**Basics**

- [ ] Extension loads in Chrome with no errors
- [ ] Extension loads in Opera GX with no errors
- [ ] Toolbar icon opens the dashboard
- [ ] Settings → Appearance → try dark and light

**Seed your data**

- [ ] Dashboard → **Import tracker files** → select all six markdown files at once
- [ ] Check the Courses page: BBB4M0-01, ENG4UE-02 and CIA4U should all be there
- [ ] Check **Teacher questions** — anything under a "Questions for Ms. Pardy" heading
      should have landed there
- [ ] If the import warns about skipped rows, note which file — that tells us what the
      importer needs to learn

**First sync**

- [ ] Open <https://ldsb.elearningontario.ca> in a normal tab and log in
- [ ] **Important, once:** on the LDSB homepage, click through the
      **"My Courses in Other Boards"** widget into CIA4U. This establishes the Durham
      session. After this, sync handles it by itself.
- [ ] Back in the dashboard → **Sync now**
- [ ] Watch the progress line in the sidebar
- [ ] Today page fills with real work
- [ ] **What changed** lists everything as "new task" on the first run
- [ ] Press **Sync now** again — this time it should report **zero** changes.
      If it reports changes again, something isn't matching on id; tell me.

**Prove manual edits stick** (worth doing once, so you trust it)

- [ ] Open any item, change its due date, add a note
- [ ] Sync again
- [ ] The date and note are still yours, and the item shows a "manual edit" pill

**AI key** _(optional — the tracker works fully without this)_

- [ ] Settings → AI providers → pick a preset for the **cheap** and **strong** roles
- [ ] Paste a key for each, **Save key**
- [ ] **Test this model** on both → you should see `ready`
- [ ] Set a monthly budget you're comfortable with (default $10)
- [ ] Try **Local model only** once and confirm a remote call is refused

**Google Docs** _(optional — needed for the formatter)_

- [ ] Follow **Google OAuth setup** in `README.md` (about 10 minutes in Google Cloud)
- [ ] Paste the client ID into Settings → **Sign in to Google**
- [ ] Make a **copy** of a worksheet, then run **Preview changes** on the copy
- [ ] Apply, check the result, then **Undo** and check it reverts

**Reminders**

- [ ] Settings → **Test notification** → it should appear in the Windows notification area
- [ ] If nothing appears, check Windows Settings → System → Notifications → your browser

**Backup** _(do this once you have real data — there is no cloud copy)_

- [ ] Settings → **Export backup** → save it somewhere safe
- [ ] Open the file and confirm there is no `apiKeyCipher` in it

## The single most useful thing you can send back

Settings → turn on **Capture debug fixtures** → **Sync now** → **Export fixtures**.

That file contains real D2L responses with names, emails and student numbers stripped out.
Hand it back and every parser can be checked against your actual data instead of my
best guess at the shapes. This is what turns "probably works" into "verified".

## What's untested against live D2L

Everything below was built and unit-tested against fixtures, but has **never touched a real
server**:

- **All D2L parsing.** Written to D2L's documented Valence shapes, tested against 11
  hand-built fixture files. Tenant customisations may change field names.
- **The LDSB → Durham SSO jump.** The link patterns are educated guesses. If it fails, the
  error tells you to click through the widget once by hand, and then it works.
- **The whole Google Docs path** — OAuth, reading a document, applying edits, undo, and
  "copy to my Drive". The _planning_ logic has 15 tests; the API round-trip has none.
- **Desktop notifications** on Windows.
- **Anything in Opera GX specifically** — it's Chromium, so it should be identical, but no
  one has run it there.

Full list with severity and workarounds: `KNOWN_ISSUES.md`.

## If something breaks

| Symptom                              | Cause                                      | Fix                                                        |
| ------------------------------------ | ------------------------------------------ | ---------------------------------------------------------- |
| "Got an HTML page instead of JSON"   | D2L session expired                        | Open D2L in a tab, log in, sync again                      |
| CIA4U missing after a sync           | Durham session not established             | Click through "My Courses in Other Boards" once, then sync |
| Sync finished with errors            | One endpoint failed; the rest still synced | Changes page → Sync history shows the exact error          |
| "No API key saved"                   | Key not entered for that role              | Settings → AI providers → paste and **Save key**           |
| Google sign-in fails on redirect URI | The extension id differs per browser       | Settings shows the exact URI; add it in Google Cloud       |
| An item's date keeps reverting       | Sync owns that field                       | Open the item, set the date — that pins it                 |

---

# Part 2 — For the next session

## State of the build

- **v1.0.0**, tagged, local git repo. Not pushed anywhere — see `NEXT_STEPS.md` #1.
- **120 tests passing**, lint clean, typecheck clean, build clean.
- `release/school-helper-1.0.0.zip` + `.sha256` + release notes carrying the source commit.
- Every feature in the brief is built and wired. What's incomplete is listed in
  `KNOWN_ISSUES.md`, not hidden.

## Read these first, in this order

1. `AGENTS.md` — code map and the three non-negotiable rules
2. `DECISIONS.md` — 16 decisions and why
3. `KNOWN_ISSUES.md` — what's weak, ranked
4. `NEXT_STEPS.md` — what to do next, ordered by value
5. `REQUIREMENTS.md` — brief → implementation → test, line by line

## The three rules you must not break

1. **Read-only against D2L.** `assertReadOnly` / `assertSafePath` in `d2l/endpoints.ts`.
   `sync.test.ts` asserts every request is a GET.
2. **No finished answers.** `ai/guardrails.ts`, three enforcement layers, no off switch.
3. **Manual edits survive sync.** `common/merge.ts`, the `overrides` map.

## Where the risk is concentrated

- `src/d2l/parsers/*` — correct against the documented shapes, unverified against reality.
- `src/d2l/sso.ts` — the least-evidenced code in the repo.
- `src/gdocs/docsApi.ts` — the only substantial module with no round-trip test.

Everything else is pure functions with tests.

## Highest-value next change

`KNOWN_ISSUES.md#9` / `NEXT_STEPS.md#5`: answer notes currently receive source _links_
rather than extracted source _text_. Fixing that (fetch topic HTML → `stripHtml`, plus
`docPlainText()` for Docs) is what makes the evidence citations genuinely useful, and it
touches one function: `AnswerNotesPage.run()`.

## Session close-out ritual

At the end of every session, update this file and `DECISIONS.md`. That is the only reason
this handoff was cheap to write, and the only reason the next one will be.
