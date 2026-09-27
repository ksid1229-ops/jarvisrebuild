# Jarvis rebuild (agent-1)

A clean rebuild of Jarvis. Cloudflare Workers +
Durable Objects + D1 + R2 + Vectorize + Queues. One brain (the Durable Object) that text and
voice both call. See `PROGRESS.md` for exactly what is built vs. faked vs. not-yet-built.

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
```

The Vectorize index must be 768 dimensions / cosine: that is what the Workers AI embedding model
(`@cf/baai/bge-base-en-v1.5`) produces.

Every release, **in this order**:

```powershell
cd $HOME\jarvisrebuild
wrangler d1 migrations apply jarvis --remote   # 1. schema first (0003 adds columns the new code writes)
wrangler deploy                                # 2. then the code
```

Optional settings:

```powershell
wrangler secret put WATCHDOG_PING_URL          # your Healthchecks.io ping URL
```

`MEMORY_EXTRACTION_MODEL` (a `[vars]` entry in `wrangler.toml`) makes memory reviews run on a
different model. Leave it unset to use the main model.

## What works today

See `PROGRESS.md` for the exact, verified list. In short: text conversations, memory (save,
recall, correct, forget, pin; meaning + literal search; automatic memory reviews when a
conversation goes quiet and hourly), connected apps, the five confirmed actions with enforced
confirmation and shadow mode, receipts, wake-ups (Durable Object alarm + hourly cron), backups to
R2, the conversation archive, the school receiver, and **inbound phone calls** (Twilio
ConversationRelay WebSocket on the Durable Object; owner PIN and guest PIN by voice or keypad —
tested against fakes only, never on a live Twilio call yet). **Not built yet:** email in/out,
Twilio outbound (Jarvis calling or texting), and the Windows PC agent. The five action tools say
`not connected` rather than pretending.

The vault export endpoint is `GET /vault/export` with header `x-vault-token`. Set the token:

```powershell
cd $HOME\jarvisrebuild
wrangler secret put VAULT_EXPORT_TOKEN
```

To connect the phone number after deploy:

1. In the Twilio Console, accept the **Predictive and Generative AI/ML Features Addendum**
   (Voice → Settings). ConversationRelay refuses calls until it is accepted.
2. Point your Twilio number's Voice webhook at `https://<your-worker>.workers.dev/voice`
   (HTTP POST).
3. Set the phone secrets:

```powershell
cd $HOME\jarvisrebuild
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put OWNER_PHONE_E164      # your cell, e.g. +16135550123
wrangler secret put OWNER_ACTION_PIN      # your 4-digit PIN for the five actions on a call
wrangler secret put OWNER_PIN_PEPPER      # any long random string
wrangler secret put PUBLIC_ORIGIN         # exactly the origin in step 2, e.g. https://<your-worker>.workers.dev
```

`PUBLIC_ORIGIN` must match the address Twilio dials, character for character, because Twilio
signs that exact URL and Jarvis refuses any call whose signature does not check out. On a call
you can say your PIN or type it on the keypad (`*` clears, `#` sends early). Three wrong PINs lock
PIN entry for the rest of that call; hang up and call back to try again.
