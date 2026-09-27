# Jarvis PC Agent (Windows 11)

Jarvis's hands on Sid's PC. It runs in the background, tells Jarvis the PC is
alive, pulls queued work (shell commands, opening pages, driving his real
Chrome), and syncs the Obsidian vault. When the PC is off, work simply waits
on the cloud — that's by design ("queue it for later").

Everything here runs on Sid's own PC under his own user account. It talks to
exactly one place: his Jarvis Worker.

## What it can do

| Job kind | What runs | Honesty |
|---|---|---|
| `shell` | PowerShell command (`powershell.exe -NoProfile -NonInteractive -Command …`) with a timeout | Reports exit code, stdout, stderr — facts only |
| `open_url` | Opens a page in his default browser | Says "asked the browser to open" — never claims the page loaded |
| `browser` | Opens a page in his REAL Chrome profile via Playwright; for purchases, tries Chrome's own autofill for the saved card ending 2286 (keyboard only — it never types card digits, it doesn't have them) | Says exactly what happened, including when autofill didn't take; the payment is never submitted by the agent |

## Install (PowerShell, one time)

You need the two tokens from the Worker (`wrangler secret put PC_AGENT_TOKEN`
and `VAULT_EXPORT_TOKEN` — keep the values you typed). Then:

```powershell
cd $HOME\jarvisrebuild\apps\pc-agent
.\scripts\install-task.ps1 -JarvisUrl "https://<your-worker>.<your-subdomain>.workers.dev" `
    -PcToken "<PC_AGENT_TOKEN>" -VaultToken "<VAULT_EXPORT_TOKEN>" `
    -VaultDir "$HOME\Documents\Obsidian\Sid\Jarvis"
```

The script installs Playwright (for browser jobs), builds the agent, writes
`config.json`, registers two Task Scheduler tasks — **Jarvis PC Agent** (at
logon) and **Jarvis Vault Sync** (hourly) — and starts the daemon immediately.

Notes:

- **Chrome profile.** Browser jobs use your real Chrome profile (saved logins,
  saved card). The default is `%LOCALAPPDATA%\Google\Chrome\User Data\Default`.
  If Chrome is running with that profile when a job starts, Chrome may just
  open a tab in the running window — either way the page ends up on your
  screen. If your card is saved in a different Chrome profile, pass
  `-ChromeProfileDir "...\User Data\Profile 1"`.
- **The token** lives in `config.json` on your PC, under your user account.
  Treat the PC account like you treat your saved passwords.
- **Verify it's alive:** `Get-ScheduledTask 'Jarvis PC Agent' | Get-ScheduledTaskInfo`
  or ask Jarvis (it has `pc_status`).

## Run it manually (no Task Scheduler)

```powershell
cd $HOME\jarvisrebuild\apps\pc-agent
npm install
npm run build
$env:JARVIS_URL = "https://<your-worker>.workers.dev"
$env:PC_AGENT_TOKEN = "<PC_AGENT_TOKEN>"
npm start
```

## Uninstall

```powershell
Unregister-ScheduledTask 'Jarvis PC Agent','Jarvis Vault Sync' -Confirm:$false
```

## Tests

```powershell
cd $HOME\jarvisrebuild\apps\pc-agent
npm install
npm test        # 26 tests: config, shell, browser honesty paths, loop, vault sync
```
