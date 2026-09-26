# Jarvis rebuild (agent-1)

A clean, isolated rebuild of Jarvis, living entirely under `rebuild/`. Cloudflare Workers +
Durable Objects + D1 + R2 + Vectorize + Queues. One brain (the Durable Object) that text and
voice both call. See `PROGRESS.md` for exactly what is built vs. faked vs. not-yet-built.

Everything below is **Windows PowerShell** (Sid runs Windows 11; there is no Linux).

## Run the tests (your PC)

```powershell
cd rebuild
npm install
npm test
```

Type-check:

```powershell
cd rebuild
npm run typecheck
```

## Run it locally against Cloudflare (Miniflare / wrangler dev)

You need Node 18+ and the Cloudflare CLI. Install wrangler once:

```powershell
npm install -g wrangler
```

Then, from the rebuild folder:

```powershell
cd rebuild
wrangler dev
```

`wrangler dev` serves the Worker locally. The Telegram webhook is `POST /telegram/webhook`;
health is `GET /health`.

## Secrets (never commit these)

Set each secret with wrangler. Run these one at a time; each prompts for the value:

```powershell
cd rebuild
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

```powershell
cd rebuild
wrangler d1 create jarvis          # once; copy the id into wrangler.toml database_id
wrangler d1 migrations apply jarvis
wrangler deploy
```

Deploy order matters when a migration changes a table the running code writes: apply the D1
migration **before** `wrangler deploy` for that release.

## What works today

All seven phases' feature code: text conversations; memory (save/recall/correct/forget/pin, meaning
+ literal search); connected apps (the plug); calling (same brain on voice, hashed PIN for the five
actions, guest isolation, Twilio signature + TwiML); the five confirmed actions with enforced
confirmation and shadow mode; receipts; wake-ups/cron/digest (the model decides digest time and
content); and plumbing (nightly backup, conversation archive + search, heartbeat, external watchdog,
token-gated one-way vault export). What remains is deploy-side wiring (real D1/DO/Vectorize/R2
persistence and the voice WebSocket loop) — see `PROGRESS.md`. The five action tools are **not
connected to real providers** — they say so rather than pretending.

The vault export endpoint is `GET /vault/export` with header `x-vault-token`. Set the token:

```powershell
cd rebuild
wrangler secret put VAULT_EXPORT_TOKEN
```

To connect the phone number after deploy, point your Twilio number's Voice webhook at
`https://<your-worker>.workers.dev/voice` (HTTP POST), and set the PIN + phone secrets:

```powershell
cd rebuild
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put OWNER_PHONE_E164
wrangler secret put OWNER_PIN_PEPPER
```
