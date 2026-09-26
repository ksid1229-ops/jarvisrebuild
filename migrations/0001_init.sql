-- Jarvis rebuild (agent-1) — initial D1 schema.
-- Timestamps are RFC 3339 UTC strings with milliseconds. Booleans are 0/1.
--
-- NOTE (honesty): in the sandbox these tables are NOT executed against a real
-- D1. The logic is tested against in-memory repositories that mirror this shape
-- (see rebuild/PROGRESS.md, "What is faked and why"). A D1-backed adapter that
-- runs this SQL is the production path.

CREATE TABLE IF NOT EXISTS facts (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('durable','temporary')),
  confidence    TEXT NOT NULL CHECK (confidence IN ('stated','inferred','confirmed')),
  source_type   TEXT NOT NULL CHECK (source_type IN ('conversation','call','email','app')),
  source_ref    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT,
  superseded_by TEXT,
  hidden        INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_facts_pinned ON facts (pinned);
CREATE INDEX IF NOT EXISTS idx_facts_hidden ON facts (hidden);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  channel    TEXT NOT NULL CHECK (channel IN ('text','voice')),
  created_at TEXT NOT NULL,
  is_summary INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);

CREATE TABLE IF NOT EXISTS receipts (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  tool       TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  trigger    TEXT NOT NULL CHECK (trigger IN ('text','call','email','wakeup','app_event')),
  performed  INTEGER NOT NULL,
  status     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_at ON receipts (at);

CREATE TABLE IF NOT EXISTS pending_actions (
  id                TEXT PRIMARY KEY,
  tool              TEXT NOT NULL,
  args_json         TEXT NOT NULL,
  args_hash         TEXT NOT NULL,
  summary           TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  creating_event_id TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled','expired','executed'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connected_apps (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  auth_secret TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  added_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guests (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  pin_hash   TEXT NOT NULL,
  access     TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guests_phone ON guests (phone);

CREATE TABLE IF NOT EXISTS wakeups (
  id         TEXT PRIMARY KEY,
  fire_at    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wakeups_fire ON wakeups (fire_at);
