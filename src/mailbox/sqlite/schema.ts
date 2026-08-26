/** Host-owned SQLite mailbox schema. */
export const INBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',
  process_after  TEXT,
  recurrence     TEXT,
  series_id      TEXT,
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,
  source_session_id TEXT,
  on_wake        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);

CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,
  channel_type    TEXT,
  platform_id     TEXT,
  agent_group_id  TEXT
);

CREATE TABLE IF NOT EXISTS session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);
`;

/** Runner-owned SQLite mailbox schema. */
export const OUTBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  in_reply_to    TEXT,
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);

-- Per-turn usage ledger. The runner appends one row per provider turn: the
-- prompt that turn answered (clipped to a preview), the tokens and cost it
-- reported, and the task series it belonged to. The runner ages rows out on a
-- fixed time window as it writes, so a session that stopped running keeps its
-- last window; the lifetime totals live in session_state.
-- Numeric columns are nullable: null means the provider reported nothing,
-- which is not the same as zero.
CREATE TABLE IF NOT EXISTS token_usage_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp             TEXT NOT NULL,
  task_series_id        TEXT,
  prompt_preview        TEXT NOT NULL,
  prompt_chars          INTEGER NOT NULL,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd              REAL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_log_timestamp
  ON token_usage_log(timestamp);
`;
