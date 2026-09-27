# Jarvis rebuild (agent-1)

A clean rebuild of Jarvis. Cloudflare Workers +
Durable Objects + D1 + R2 + Vectorize (Queues come back with email). One brain (the Durable
Object) that Telegram, SMS and voice all call. See `PROGRESS.md` for exactly what is built vs. faked vs. not-yet-built.

Everything below is **Windows PowerShell** (Sid runs Windows 11; there is no Linux).

## Run the tests (your PC)

```powershell
cd $HOME\jarvisrebuild
npm install
npm test
```

Type-check:

```powershell
cd $HOME\jarvisrebuild
npm run typecheck
```

## Run it locally against Cloudflare (Miniflare / wrangler dev)

You need Node 18+ and the Cloudflare CLI. Install wrangler once:

```powershell
npm install -g wrangler
```

Then, from the repo folder:

```powershell
cd $HOME\jarvisrebuild
wrangler dev
```

`wrangler dev` serves the Worker locally. The Telegram webhook is `POST /telegram/webhook`;
health is `GET /health`.

## Secrets (never commit these)

Set each secret with wrangler. Run these one at a time; each prompts for the value:

```powershell
cd $HOME\jarvisrebuild
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put OWNER_ACTION_PIN
wrangler secret put VAULT_EXPORT_TOKEN
```

Non-secret settings live in `wrangler.toml` under `[vars]` (your timezone, the model id) and as
plain vars you can set the same way:

```powershell
wrangler secret put OWNER_CHAT_ID
```

`OWNER_CHAT_ID` is your own Telegram chat id. **If it is unset, Jarvis refuses to treat anyone
as the owner** — that is intentional. Likewise, with no `TELEGRAM_WEBHOOK_SECRET` every webhook
is refused, and with no `DEEPSEEK_API_KEY` Jarvis says it has no model rather than faking a reply.

## Point Telegram at the Worker

After deploy (below), tell Telegram where to send updates and set the secret header. Replace the
bracketed values:

```powershell
$token = "<your bot token>"
$url = "https://<your-worker>.workers.dev/telegram/webhook"
$secret = "<the same value you gave TELEGRAM_WEBHOOK_SECRET>"
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" -Body @{ url = $url; secret_token = $secret }
```

## Deploy (you do the production deploys)

One-time setup (PowerShell, from the repo folder). Each `create` prints an id or confirms the name:

```powershell
cd $HOME\jarvisrebuild
wrangler d1 create jarvis                     # copy the printed id into wrangler.toml database_id
wrangler r2 bucket create jarvis-archive
wrangler r2 bucket create jarvis-backup
wrangler vectorize create jarvis-memory --dimensions=768 --metric=cosine
wrangler queues create jarvis-work
```

The Vectorize index must be 768 dimensions / cosine: that is what the Workers AI embedding model
(`@cf/baai/bge-base-en-v1.5`) produces. The queue carries inbound-email wake-ups.

Every release, **in this order**:

```powershell
cd $HOME\jarvisrebuild
wrangler d1 migrations apply jarvis --remote   # 1. schema first (0004 adds emails/pc tables the new code writes)
wrangler deploy                                # 2. then the code
```

Optional settings:

```powershell
wrangler secret put WATCHDOG_PING_URL          # your Healthchecks.io ping URL
```

`MEMORY_EXTRACTION_MODEL` (a `[vars]` entry in `wrangler.toml`) makes memory reviews run on a
different model. Leave it unset to use the main model.

## Email (in and out)

Inbound: Cloudflare Email Routing hands every message for `school@onesid.ca` to the Worker
(`async email()`), which parses it, archives the untouched `.eml` to the ARCHIVE bucket, stores
it in D1 and wakes the brain over the queue. Set it up after your first deploy:

1. In the Cloudflare dashboard, your domain (`onesid.ca`) → **Email** → **Email Routing** →
   enable it.
2. Add a **Custom address** `school@onesid.ca` with the action **Send to a Worker** →
   `jarvis-rebuild`. (Your existing auto-forwards from your personal and school inboxes stay as
   they are — they feed this address.)
3. Nothing else to configure: the Worker's `email()` handler does the rest, and the
   `email_list` / `email_read` tools let Jarvis look back at any of it.

Outbound: `send_email` (one of the five confirmed actions) sends from your real accounts —
**personal** = `ksid1229@gmail.com` via the Gmail API, **school** =
`sk7qq09@limestone.on.ca` via Microsoft Graph. Jarvis picks the account; code never defaults it.
An account whose secrets are unset simply returns `not connected`, so you can wire one first.

```powershell
cd $HOME\jarvisrebuild
wrangler secret put GMAIL_CLIENT_ID
wrangler secret put GMAIL_CLIENT_SECRET
wrangler secret put GMAIL_REFRESH_TOKEN
wrangler secret put MS_GRAPH_CLIENT_ID
wrangler secret put MS_GRAPH_CLIENT_SECRET
wrangler secret put MS_GRAPH_REFRESH_TOKEN
wrangler secret put MS_GRAPH_TENANT_ID
```

Each account needs OAuth credentials (a one-time consent; the refresh token then lasts while the
app stays authorized): Gmail — Google Cloud Console, enable the Gmail API, OAuth consent
(Desktop app), run the flow once with `access_type=offline`, exchange the code for a refresh
token. Microsoft — Azure Portal, App registration (Delegated, `Mail.Send` + `offline_access`),
same idea. Ask in the chat for the exact click-path if you want it.

## The Windows PC agent

`apps/pc-agent` is Jarvis's hands on your PC: it runs at logon, pulls queued jobs (PowerShell,
open-a-page, drive-your-real-Chrome), reports results, and syncs the Obsidian vault hourly.
Install it (PowerShell):

```powershell
cd $HOME\jarvisrebuild
wrangler secret put PC_AGENT_TOKEN            # a long random string; the agent needs the same value
cd apps\pc-agent
.\scripts\install-task.ps1 -JarvisUrl "https://<your-worker>.<your-subdomain>.workers.dev" `
    -PcToken "<the PC_AGENT_TOKEN value>" -VaultToken "<the VAULT_EXPORT_TOKEN value>" `
    -VaultDir "$HOME\Documents\Obsidian\Sid\Jarvis"
```

`spend_money` (confirmed, like all five actions) queues a checkout on your PC: your real Chrome
opens the page and tries Chrome's own autofill for the saved card ending 2286 — Jarvis never
holds the card number and the payment itself is never auto-submitted. When the PC is off, the
job waits in D1 and runs when the PC checks in. Details and options: `apps/pc-agent/README.md`.

## What works today

See `PROGRESS.md` for the exact, verified list. In short: text conversations, memory (save,
recall, correct, forget, pin; meaning + literal search; automatic memory reviews when a
conversation goes quiet and hourly), connected apps (the confirmation you see when connecting one
lists its tools and which run without asking), the five confirmed actions with enforced
confirmation and shadow mode, receipts, wake-ups (Durable Object alarm + hourly cron), backups to
R2, the conversation archive, the school receiver, **inbound phone calls** (Twilio
ConversationRelay WebSocket on the Durable Object; owner PIN and guest PIN by voice or keypad),
**SMS as a second text channel** next to Telegram (same brain; replies go back on the channel you
used), **Jarvis phoning you** (`call_place`), **texting or one-way calling someone for you**
after you confirm (`contact_on_behalf`), **two-way calls to other people** (`make_call`: a real
spoken conversation carrying only the reason you confirmed; the transcript is kept as proof),
**email in and out** (Cloudflare Email Routing → queue → the same brain; sending from your real
Gmail and school accounts), and the **Windows PC agent** (shell, open-page and Chrome-driving
jobs, plus the Obsidian vault sync). The still-not-connected action is `submit_schoolwork`
(the School Helper is read-only by design). All the Twilio, Gmail/Graph and browser-automation
parts are tested against fakes only — none has run on a live number, inbox or checkout yet.

Searches have no hidden caps: leave `limit` off and Jarvis gets every match (paged with
`offset`). The one ceiling left is Vectorize's own 100 results per meaning search, which the
tool reports when it is hit.

The vault export endpoint is `GET /vault/export` with header `x-vault-token`. Set the token:

```powershell
cd $HOME\jarvisrebuild
wrangler secret put VAULT_EXPORT_TOKEN
```

To connect the phone number after deploy:

1. In the Twilio Console, accept the **Predictive and Generative AI/ML Features Addendum**
   (Voice → Settings). ConversationRelay refuses calls until it is accepted.
2. On your Twilio number (Phone Numbers → Manage → Active numbers → your number), set:
   - **Voice → A call comes in:** Webhook, `https://<your-worker>.workers.dev/voice`, HTTP POST
   - **Messaging → A message comes in:** Webhook, `https://<your-worker>.workers.dev/sms`, HTTP POST
3. Set the phone secrets:

```powershell
cd $HOME\jarvisrebuild
wrangler secret put TWILIO_ACCOUNT_SID    # starts with AC, from the Twilio Console home page
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put TWILIO_FROM_E164      # your Twilio number, e.g. +16135550999
wrangler secret put OWNER_PHONE_E164      # your cell, e.g. +16135550123
wrangler secret put OWNER_ACTION_PIN      # your 4-digit PIN for the five actions on a call
wrangler secret put OWNER_PIN_PEPPER      # any long random string
wrangler secret put PUBLIC_ORIGIN         # exactly the origin in step 2, e.g. https://<your-worker>.workers.dev
```

`PUBLIC_ORIGIN` must match the address Twilio dials, character for character, because Twilio
signs that exact URL and Jarvis refuses any call or text whose signature does not check out. It is
also the address Jarvis gives Twilio when it phones you. On a call you can say your PIN or type it
on the keypad (`*` clears, `#` sends early). Three wrong PINs lock PIN entry for the rest of that
call; hang up and call back to try again. PINs are stored salted (`v1$salt$hash`, a fresh salt per
PIN); a legacy unsalted hash from an older deploy still verifies, so upgrading does not reset
your PIN.

Texts from any number other than `OWNER_PHONE_E164` are ignored. Depending on your Twilio
number's country and type, Twilio may require it to be registered for messaging (for example A2P
10DLC for US numbers, or toll-free verification) before texts are delivered — if texts to or from
Jarvis never arrive, check Messaging → Regulatory Compliance in the Twilio Console.
