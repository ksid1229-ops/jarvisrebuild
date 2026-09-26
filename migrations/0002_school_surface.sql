-- Jarvis rebuild — school ingestion surface + tables the first migration missed.
-- Timestamps are RFC 3339 UTC strings with milliseconds. Booleans are 0/1.
--
-- app_events and heartbeats back AppEventsRepo and HeartbeatRepo: the first
-- migration defined the repos' tables everywhere except here, which the mirror
-- hid. The school_* tables back the collector protocol (src/school/).

CREATE TABLE IF NOT EXISTS app_events (
  id           TEXT PRIMARY KEY,
  app_name     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_events_received ON app_events (received_at);

CREATE TABLE IF NOT EXISTS heartbeats (
  component TEXT PRIMARY KEY,
  last_beat TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS school_collector_keys (
  collector_id      TEXT PRIMARY KEY,
  principal_id      TEXT NOT NULL,
  public_key_base64 TEXT NOT NULL,
  device_label      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  challenge         TEXT NOT NULL,
  pairing_code      TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  decision_id       TEXT
);

CREATE TABLE IF NOT EXISTS school_collector_nonces (
  collector_id TEXT NOT NULL,
  nonce        TEXT NOT NULL,
  used_at      TEXT NOT NULL,
  PRIMARY KEY (collector_id, nonce)
);

CREATE TABLE IF NOT EXISTS school_evidence (
  batch_id            TEXT PRIMARY KEY,
  host                TEXT NOT NULL,
  read_id             TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  course_id           TEXT,
  course_name         TEXT,
  enrollment_complete INTEGER NOT NULL,
  routes_json         TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  outcome             TEXT NOT NULL CHECK (outcome IN ('good','failed'))
);
CREATE INDEX IF NOT EXISTS idx_school_evidence_course ON school_evidence (host, course_id, received_at);

-- Jarvis -> device intents (the pull channel). The extension fetches queued
-- rows, executes only its allow-list, and posts results back.
CREATE TABLE IF NOT EXISTS school_requests (
  id         TEXT PRIMARY KEY,
  action     TEXT NOT NULL CHECK (action IN ('sync_now','open_item','notify')),
  args_json  TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('queued','delivered','succeeded','failed','expired')) DEFAULT 'queued',
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_school_requests_status ON school_requests (status, created_at);
