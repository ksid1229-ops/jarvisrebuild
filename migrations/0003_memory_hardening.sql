-- Migration 0003: memory hardening.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the code that ships with
-- it. The new code writes these columns; the old code ignores them, so applying
-- the migration first is safe while the old Worker is still running.
--
-- 1. Conversation is never deleted. A summary now REPLACES older messages in the
--    model's context only; the rows stay (rolled_up = 1) so history_search and
--    memory reviews still see every word. Before this, summarizing DELETED them.
-- 2. Messages remember whether they were forwarded and which channel message
--    they came from, so a "stated" fact can be tied to one real message of Sid's.
-- 3. Facts record the exact message they rest on, why a correction happened, and
--    whether the fact is in the meaning-search index yet.
-- 4. memory_runs: a ledger of every memory review (what woke it, which model,
--    which window of conversation, what was saved, and whether it failed).
-- 5. wakeups.kind separates Sid's reminders from system timers (the
--    conversation-went-quiet memory review) sharing the one Durable Object alarm.

ALTER TABLE messages ADD COLUMN rolled_up  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN forwarded  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN source_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_context ON messages (rolled_up, is_summary);

ALTER TABLE facts ADD COLUMN source_message_id TEXT;
ALTER TABLE facts ADD COLUMN correction_reason TEXT;
ALTER TABLE facts ADD COLUMN indexed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_facts_active ON facts (hidden, superseded_by, expires_at);

CREATE TABLE IF NOT EXISTS memory_runs (
  id                 TEXT PRIMARY KEY,
  trigger            TEXT NOT NULL CHECK (trigger IN ('quiet_alarm','hourly_cron')),
  model              TEXT NOT NULL,
  window_start       TEXT,
  window_end         TEXT,
  messages_reviewed  INTEGER NOT NULL DEFAULT 0,
  messages_deferred  INTEGER NOT NULL DEFAULT 0,
  facts_saved        INTEGER NOT NULL DEFAULT 0,
  facts_corrected    INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('running','ok','nothing_new','error')),
  error              TEXT,
  started_at         TEXT NOT NULL,
  finished_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_runs_started ON memory_runs (started_at);

ALTER TABLE wakeups ADD COLUMN kind TEXT NOT NULL DEFAULT 'owner'
  CHECK (kind IN ('owner','memory_review'));
