# School Helper

A personal, **local-only** tool that helps Sid (Grade 12, Ontario) catch up and stay on top of school.

One MV3 browser extension containing two surfaces:

- a **full-page dashboard** (opens in its own tab from the toolbar icon)
- a **side panel** for in-page actions on D2L and Google Docs

It reads the D2L sites you are already logged into, tracks every piece of coursework,
and gives you study help that stops short of doing the work for you.

**All data stays on your PC** in IndexedDB inside the extension. There is no cloud
database and no account. The only thing that ever leaves your machine is what you
explicitly send to the AI provider you configure — and you are shown exactly what
that is, every time, before it is sent.

---

## Courses it tracks

| Course                           | Teacher     | Platform                                                                                                                                |
| -------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| BBB4M0-01 International Business | Ms. Pardy   | LDSB Minds Online (D2L), `ldsb.elearningontario.ca`, ou `29940528`                                                                      |
| ENG4UE-02 English                | Ms. McLaren | LDSB Minds Online, ou `29940585`                                                                                                        |
| CIA4U Economics                  | Mr. Fong    | Durham DSB D2L, `durham.elearningontario.ca`, ou `29725166` — reached by SSO from the LDSB homepage widget "My Courses in Other Boards" |

---

## Install (Chrome and Opera GX)

The extension loads unpacked in both browsers. Same folder, same steps.

1. Download `school-helper-<version>.zip` from the GitHub release (or run `npm run release` yourself).
2. Unzip it somewhere permanent — **if you delete or move this folder the extension breaks.**
   Something like `C:\Users\<you>\school-helper\` is good.
3. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Opera GX: `opera://extensions`
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and pick the unzipped folder (the one containing `manifest.json`).
6. Pin the icon to your toolbar. Clicking it opens the dashboard in a tab.

To verify the download first (Windows PowerShell):

```powershell
certutil -hashfile school-helper-1.0.0.zip SHA256
```

Compare that against the SHA-256 in the release notes.

### Opera GX notes

Opera GX is Chromium-based and runs the extension unchanged. Two differences worth knowing:

- The side panel API works, but Opera's own sidebar is separate — the panel appears in
  the Chromium side panel slot, not the GX sidebar.
- Opera sometimes reloads unpacked extensions less eagerly. After an update, hit
  **Reload** on the extension card.

---

## First run

1. **Import your tracker files** — dashboard → _Import tracker files_ → select
   `01_tracker.md` … `06_bbb4m_handoff.md`. See "Seed data" below for what it reads.
2. **Log in to D2L** in a normal tab: <https://ldsb.elearningontario.ca>.
   For Economics, click through the LDSB homepage widget **"My Courses in Other Boards"**
   at least once so a Durham session cookie exists. After that, sync handles the jump itself.
3. **Press Sync now** in the dashboard sidebar.
4. _(Optional)_ add an AI key in **Settings** — the tracker is fully usable without one.
5. _(Optional)_ set up Google OAuth for the worksheet formatter — steps below.

---

## Google OAuth setup (you must do this part yourself)

The Docs formatter and "copy worksheet to my Drive" need a Google OAuth client ID
that belongs to **you**. There is no shared one, and there cannot be — a client ID
in a publicly distributed extension is not a secret.

1. Go to <https://console.cloud.google.com/> and sign in with your **personal** Google
   account (`/u/0`, the one where you keep worksheet copies). School accounts are often
   locked down by the board and will reject the consent screen.
2. Create a new project — call it "School Helper".
3. **APIs & Services → Library** → enable:
   - **Google Docs API**
   - **Google Drive API**
4. **APIs & Services → OAuth consent screen**:
   - User type: **External**
   - App name: School Helper, and your own email for support/developer contact
   - **Scopes** → Add:
     - `https://www.googleapis.com/auth/documents`
     - `https://www.googleapis.com/auth/drive.file`
   - **Test users** → add your own Google address (both `/u/0` and `/u/1` if you want
     the formatter to work on school-account docs)
   - Leave it in **Testing**. You do not need Google to verify the app for personal use.
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: School Helper
   - Under **Authorised redirect URIs**, add the exact value shown in
     **School Helper → Settings → Google Docs**. It looks like:
     `https://<your-extension-id>.chromiumapp.org/google`
     The extension id differs between Chrome and Opera GX, so **add both** if you use both.
6. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and paste it into
   **Settings → Google Docs → OAuth client ID**.
7. Click **Sign in to Google**. You will see an "unverified app" warning — that is
   expected for a personal app in Testing mode. Continue past it.

You will never be asked for a client _secret_: the extension uses the PKCE flow, which
does not need one.

**Scope note:** `drive.file` means the extension can only see documents you explicitly
open through it. It cannot list or read the rest of your Drive. On top of that, School
Helper keeps its own allow-list — a document is only touched after you click
"Use this document", and you can revoke the whole list in Settings.

---

## AI provider setup (bring any API)

**Settings → AI providers.** Two roles, configured independently:

| Role       | Used for                                      | Suggested                                |
| ---------- | --------------------------------------------- | ---------------------------------------- |
| **Cheap**  | sync summaries, tracker updates, email drafts | DeepSeek, GPT-4o-mini, a local model     |
| **Strong** | rubric checks, answer notes, essay feedback   | GPT-4o, Claude Sonnet, DeepSeek-Reasoner |

Each role takes **base URL + API key + model name**. The default format is
**OpenAI-compatible**, so these all work out of the box:

| Provider          | Base URL                       |
| ----------------- | ------------------------------ |
| OpenAI            | `https://api.openai.com/v1`    |
| DeepSeek          | `https://api.deepseek.com/v1`  |
| OpenRouter        | `https://openrouter.ai/api/v1` |
| Ollama (local)    | `http://localhost:11434/v1`    |
| LM Studio (local) | `http://localhost:1234/v1`     |

There is also a native **Anthropic** adapter — switch _Format_ to `Anthropic` and use
`https://api.anthropic.com/v1`.

Presets for all of these are one click in Settings. Hit **Test this model** to confirm.

### Privacy controls

- **Keys are encrypted at rest** with AES-GCM under a per-device key held in
  `chrome.storage.local`, and are never written to any log. If a provider echoes your
  key back inside an error message, it is scrubbed before the error is stored.
- **A disclosure appears before every call**, naming the exact host, model, token count
  and estimated cost, with a "show exactly what is sent" expander. This is enforced in
  the provider layer, not just the UI — a call without an accepted disclosure is refused.
- **"Local model only"** hard-blocks every non-local endpoint. Nothing is sent, at all.
- **Monthly budget** blocks calls that would push you past a dollar cap you set.
- **Running cost** per call and per month is tracked on the Settings page.

---

## What it does

### 1. Tracker dashboard

Every course, unit, lesson, assignment/drop box, quiz, discussion and announcement, with
due dates, points, weights, submission status, grades and feedback.

- **Today / This week / Overdue** view, plus a balanced **weekend plan**
- **Priority score** (0–100) combining due-date urgency, weight and how overdue something is
- **Per-teacher question lists** you can add to and tick off
- **Manual edits and notes on any item**, which are pinned and **survive every future sync**
  until you release them

### 2. Auto-sync from D2L (read-only)

Runs when you press Sync, quietly while you browse D2L, and on a timer.

- Prefers D2L's own **Valence LE/LP JSON endpoints** over scraping HTML, and negotiates
  the API version against each tenant
- Collects the content tree, drop boxes (**including ones linked from content but hidden
  from the list**), due/end dates, submission status, grades, feedback, level-4 rubrics,
  announcements, quizzes, discussions, and gradebook weights
- Handles the **LDSB → Durham SSO jump** automatically
- **Never stores passwords. Never submits, posts, or marks anything read. GET requests only** —
  enforced by a guard that throws on any other method and blocks state-changing URL shapes
- **Diffs against the last sync** and shows exactly what changed

### 3. Answer notes + rubric check (AI)

- **Answer notes** pull only from the sources the lesson itself provides, or one you name.
  Output is short bullets with an evidence link per claim. Anything the model brings in
  from outside the sources is flagged `NOT IN SOURCE`.
- **It will not write finished, submit-ready answers.** This is a hard product rule with no
  off switch, enforced in three independent layers (system prompt, output format, and a
  post-check that strips drafted prose).
- **Rubric check:** you paste your **own** answer; it compares it against that task's level-4
  descriptors, lists what's missing, corrects factual errors, and suggests targeted edits
  that keep your wording. Suggestions whose "before" text isn't actually in your answer are
  discarded, so it can't smuggle in new content.
- **Opinion questions** are detected and you are asked which side you take before any notes
  are produced.
- Paste `04_style_guide.md` into the rubric-check page so suggestions sound like you.

### 4. Formatting fixer (Google Docs)

One click on a worksheet:

- four blank lines between question/answer blocks
- the answer directly under its question
- lists and evidence each on their own line
- leftover horizontal answer lines and `____` blanks removed
- evidence turned into links, not bare URLs

Uses the **Google Docs API**, never DOM automation — the Docs editor is canvas-based and
hostile to scripting. **Always previews first, and every run is undoable.**

### 5. Small helpers

Due-date desktop notifications, a "what should I do next" button, one-click teacher email
drafts (**you** send them), an end-of-day summary, and "copy worksheet to my Drive".

---

## Seed data

The importer is deliberately shape-tolerant, because the exact layout of the tracker files
varies. It reads:

- **markdown tables** with a header row — columns like Task / Type / Due / Weight / Status / Notes
- **checklists** — `- [ ]` and `- [x]`
- **`# Course` headings** to switch course context (matched on course code or name)
- **"Questions for Ms. Pardy"** sections → that teacher's question list
- a file named like `04_style_guide.md` → stored verbatim for the rubric check
- `*_handoff.md` files → kept as notes rather than parsed into tasks

Re-importing is safe: items are keyed by normalised title, so a second import updates rather
than duplicates. Imported items are marked "not yet seen by sync", so when the real D2L item
shows up, sync takes over cleanly.

---

## Capture debug fixtures (please do this once — it's the most useful thing you can send back)

No parser in this extension has ever seen a real D2L response (`KNOWN_ISSUES.md` #1). This
button fixes that. It saves the actual JSON your D2L sends back, **with your name, email and
student number stripped out**, so the parsers can be checked against reality.

It takes about two minutes.

1. Open Chrome (or Opera GX) and log in to <https://ldsb.elearningontario.ca>.
   If you want Economics captured too, click through the **"My Courses in Other Boards"**
   widget into CIA4U once.
2. Click the **School Helper** toolbar icon to open the dashboard.
3. Go to **Settings** → scroll to **Debug fixtures**.
4. Tick **Capture debug fixtures on the next sync**.
5. Click **Sync now** in the left sidebar. Wait for the progress bar to finish.
6. Back in **Settings → Debug fixtures**, the counter next to it should now show a number
   (usually 20–60). Click **Export fixtures**.
7. Chrome saves `school-helper-fixtures-<numbers>.json` to your Downloads folder.
8. **Untick** _Capture debug fixtures_ so it doesn't keep recording.

### Check the file before you send it (PowerShell)

Open PowerShell (press `Win`, type `powershell`, Enter) and run:

```powershell
cd $HOME\Downloads
$f = Get-ChildItem school-helper-fixtures-*.json | Sort-Object LastWriteTime | Select-Object -Last 1
"File:  $($f.Name)"
"Size:  {0:N0} KB" -f ($f.Length / 1KB)
```

Confirm your personal details really are gone — these should all print **0**:

```powershell
$text = Get-Content $f.FullName -Raw
"Your first name : " + ([regex]::Matches($text, 'Sid')).Count
"Email addresses : " + ([regex]::Matches($text, '[\w.+-]+@(?!example\.com)[\w-]+\.[\w.-]+')).Count
"9-digit numbers : " + ([regex]::Matches($text, '\b\d{3}[- ]?\d{3}[- ]?\d{3}\b')).Count
```

If any of those come back non-zero, **don't send the file** — tell me which check failed and
I'll tighten the redaction first.

To see what was captured:

```powershell
(Get-Content $f.FullName -Raw | ConvertFrom-Json).fixtures |
  Group-Object endpoint | Select-Object Count, Name | Sort-Object Count -Descending
```

Then send me `school-helper-fixtures-<numbers>.json`.

### Deleting them again

Settings → Debug fixtures → **Delete captured fixtures**. They live only in this browser's
IndexedDB and are never uploaded anywhere by the extension.

## Reloading after an update, and turning the Jarvis link on

Every command below is PowerShell. Open it with `Win` → type `powershell` → Enter.

### 1. Reload the extension

If you installed from the release zip, replace the folder contents with the new
version, then reload. Check the version first:

```powershell
$ext = 'C:\Users\' + $env:USERNAME + '\school-helper-extension'
(Get-Content "$ext\manifest.json" -Raw | ConvertFrom-Json).version
```

Unpack the new zip over it:

```powershell
$zip = Get-ChildItem $HOME\Downloads\school-helper-1.1.0.zip
Expand-Archive -LiteralPath $zip.FullName -DestinationPath $ext -Force
(Get-Content "$ext\manifest.json" -Raw | ConvertFrom-Json).version   # should say 1.1.0
```

Then in the browser:

1. Open `chrome://extensions` (or `opera://extensions`).
2. Find **School Helper** and click the **reload** arrow.
3. If it is not installed yet: **Developer mode** on → **Load unpacked** → pick `$ext`.

Your data survives a reload — courses, manual edits and questions live in IndexedDB,
not in the extension folder. Take a backup first anyway (Settings → Backup → Export).

### 2. Retire the old Jarvis D2L collector

**Do not run both extensions.** They read the same two boards with the same account.

1. `opera://extensions` → find **Jarvis D2L collector** → **Remove**.
2. Ask Jarvis on Telegram: _"Show my D2L collector devices, then revoke the collector
   for &lt;the label you paired&gt;."_ Removing the extension does **not** revoke its
   server record.

### 3. Turn the Jarvis link on

The link is off by default. Nothing is sent until you finish this.

1. Open the School Helper dashboard → **Settings** → **Jarvis link**.
2. Leave the gateway URL as it is unless you are testing against a local server.
3. Type a name for this device — **Home PC** or **Laptop**. Each device pairs separately.
4. Click **Save and pair**. The browser asks for permission to talk to the gateway
   origin — accept it, or nothing can be sent.
5. A six-digit code appears, e.g. `481-902`. Jarvis sends you an approval request on
   Telegram. **Check the code matches**, then approve it there.
6. Back in Settings, click **Check pairing** until it says _Paired and active_.
   The window is ten minutes; if it expires, pair again.
7. Tick **Send evidence to Jarvis**.
8. Click **Send evidence now**, then read the **Link log** underneath. You want
   `/school/observations` rows with status `200`. Anything else is explained in the
   Detail column.

### 4. Check it from Jarvis's side

Ask Jarvis: _"What have I got due this week?"_ If it answers from real coursework,
the link works. If it says it has no school data, check the link log first.

### Turning it off

Untick **Send evidence to Jarvis**. Sending stops immediately; the device stays
paired. To unpair completely, remove the extension, then ask Jarvis to revoke the
device.

### If it will not pair

```powershell
# Is the gateway reachable at all from this machine?
Invoke-WebRequest -Uri 'https://jarvis-cloud-gateway.twilight-tree-70b1.workers.dev/health' -UseBasicParsing |
  Select-Object StatusCode
```

- `pairing-unavailable-or-refused` — the gateway rejected the call. Check the log's
  Detail column for the status code.
- `gateway-timeout` — no response in 15 seconds. Check your connection.
- Code expired — pair again; the window is ten minutes.
- Nothing in the log at all — the origin permission was refused. Turn the toggle off
  and on to be asked again.

## Backup and restore

Everything is local, so **you are the backup**. Settings → Backup:

- **Export backup** — full JSON of every table. API keys are _excluded_.
- **Export including keys** — same, with keys in their encrypted form (they only decrypt on
  the same device).
- **Import backup** — merge or replace. A key-less backup never wipes keys you already have.

---

## Development

```bash
npm install
npm test          # 120 unit tests against realistic D2L fixtures
npm run lint
npm run typecheck
npm run build     # -> dist/  (load this folder unpacked)
npm run pack      # -> release/school-helper-<version>.zip + notes + sha256
npm run release   # lint + test + build + pack
```

Stack: TypeScript, Vite, React 18, Dexie (IndexedDB), MV3.

See `AGENTS.md` for the code map, `TESTING.md` for the release gates,
`DECISIONS.md` for why things are built the way they are, and `docs/HANDOFF.md`
for the first-run checklist and what is still untested.
