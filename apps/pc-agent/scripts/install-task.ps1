<#
.SYNOPSIS
  Installs the Jarvis PC agent on Sid's Windows 11 PC: a config file, a logon
  Task Scheduler task for the daemon, and an hourly task for the Obsidian
  vault sync. All PowerShell, no manual steps.

.EXAMPLE
  .\scripts\install-task.ps1 -JarvisUrl "https://jarvis-rebuild.<account>.workers.dev" `
      -PcToken "<PC_AGENT_TOKEN>" -VaultToken "<VAULT_EXPORT_TOKEN>" `
      -VaultDir "$HOME\Documents\Obsidian\Sid\Jarvis" -ChromeProfileDir "$HOME\AppData\Local\Google\Chrome\User Data"

  If you don't have the tokens yet: cd to the repo root and run
  `wrangler secret list` — set them first with `wrangler secret put NAME`.
#>
param(
  [Parameter(Mandatory = $true)][string]$JarvisUrl,
  [Parameter(Mandatory = $true)][string]$PcToken,
  [Parameter(Mandatory = $true)][string]$VaultToken,
  [Parameter(Mandatory = $true)][string]$VaultDir,
  # Chrome's user-data dir. The DEFAULT profile usually holds the saved card;
  # if your card is saved under a different Chrome profile, point this at that
  # profile folder instead (e.g. ...\User Data\Profile 1).
  [string]$ChromeProfileDir = "$env:LOCALAPPDATA\Google\Chrome\User Data\Default",
  [int]$PollSeconds = 30
)

$ErrorActionPreference = "Stop"
$appDir = Split-Path -Parent $PSScriptRoot   # apps\pc-agent

# 1) Build the app (TypeScript -> dist\).
Write-Host "Building the PC agent in $appDir ..."
Push-Location $appDir
try {
  if (-not (Test-Path "node_modules")) { npm install }
  if (-not (Test-Path "node_modules\playwright")) {
    # Browser jobs (checkout autofill) need Playwright. Without it they fail
    # honestly with install instructions — installing it here is recommended.
    npm install playwright
  }
  npm run build
} finally {
  Pop-Location
}

# 2) Write config.json (next to dist\, where the agent looks for it).
$config = [ordered]@{
  jarvisUrl        = $JarvisUrl.TrimEnd('/')
  pcAgentToken     = $PcToken
  vaultToken       = $VaultToken
  vaultDir         = $VaultDir
  chromeProfileDir = $ChromeProfileDir
  pollMs           = $PollSeconds * 1000
}
$configPath = Join-Path $appDir "config.json"
$config | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8
Write-Host "Wrote $configPath"

# The token lives in that file, on Sid's own PC, under his own user account —
# the same trust as his saved passwords in Chrome. Nothing is sent anywhere
# except to his Jarvis Worker.
Write-Host "NOTE: config.json contains the PC agent token. Keep the PC account locked as usual."

# 3) Task Scheduler: the daemon at logon.
$node = (Get-Command node).Source
$agentAction = New-ScheduledTaskAction -Execute $node -Argument "`"$appDir\dist\agent.js`"" -WorkingDirectory $appDir
$agentTrigger = New-ScheduledTaskTrigger -AtLogOn
$agentSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0)
Register-ScheduledTask -TaskName "Jarvis PC Agent" -Action $agentAction -Trigger $agentTrigger -Settings $agentSettings -Force | Out-Null
Write-Host "Registered task 'Jarvis PC Agent' (starts at logon)."

# 4) Task Scheduler: vault sync, hourly.
$vaultAction = New-ScheduledTaskAction -Execute $node -Argument "`"$appDir\dist\vault-sync.js`"" -WorkingDirectory $appDir
$vaultTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "Jarvis Vault Sync" -Action $vaultAction -Trigger $vaultTrigger -Settings $agentSettings -Force | Out-Null
Write-Host "Registered task 'Jarvis Vault Sync' (hourly)."

# 5) Start the daemon now, without waiting for the next logon.
Start-ScheduledTask -TaskName "Jarvis PC Agent"
Write-Host "Started 'Jarvis PC Agent'. Jarvis can now use this PC."
Write-Host ""
Write-Host "Check it is alive:    Get-ScheduledTask 'Jarvis PC Agent' | Get-ScheduledTaskInfo"
Write-Host "Watch its output:     node `"$appDir\dist\agent.js`""
Write-Host "Uninstall:            Unregister-ScheduledTask 'Jarvis PC Agent','Jarvis Vault Sync' -Confirm:`$false"
