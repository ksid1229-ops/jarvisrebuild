-- Migration 0004: email surface + the Windows PC agent queue.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the code that ships with
-- it. New code writes these tables; the running old Worker ignores them, so
-- applying the migration first is safe.
--
-- 1. emails: every inbound email Cloudflare Email Routing hands the Worker
--    (school@onesid.ca, which auto-forwards Sid's personal and school inboxes).
--    The raw .eml goes to the ARCHIVE R2 bucket; this row is the parsed record
--    the email_list / email_read tools serve. reviewed_at marks when the brain
--    was woken with it.
-- 2. pc_jobs: work Jarvis queues for Sid's Windows PC (shell, open_url, browser
--    autofill for spend_money). The PC agent authenticates with PC_AGENT_TOKEN,
--    pulls the oldest queued jobs, and posts results. When the PC is off the
--    rows simply wait — that is Sid's chosen behaviour ("queue it for later").
-- 3. pc_heartbeat: one row ('pc'). pc_status reads it to say whether the PC is
--    online and how many jobs are waiting; the backup dumps it like every table.

CREATE TABLE IF NOT EXISTS emails (
  id          TEXT PRIMARY KEY,
  from_addr   TEXT NOT NULL,
  to_addr     TEXT NOT NULL,
  subject     TEXT NOT NULL,
  text_body   TEXT NOT NULL,
  received_at TEXT NOT NULL,
  r2_key      TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails (received_at);

CREATE TABLE IF NOT EXISTS pc_jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('shell','open_url','browser')),
  args_json    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued','delivered','done','failed')),
  created_at   TEXT NOT NULL,
  delivered_at TEXT,
  finished_at  TEXT,
  result_json  TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_pc_jobs_status ON pc_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS pc_heartbeat (
  id        TEXT PRIMARY KEY,
  last_seen TEXT NOT NULL,
  version   TEXT
);
