-- F0 Spike D1 schema. Columns match spike/src/types.ts row types and
-- spike/src/db.ts insert helpers exactly -- do not rename or drop columns
-- without updating both.
--
-- Note: is_redelivery lives on raw_events (not just in application code)
-- because report.ts's redelivery-count matrix item (contract requirement
-- (5) "redelivery／亂序出現次數") reads it directly via SQL aggregation.

CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_event_id TEXT UNIQUE,
  received_at INTEGER NOT NULL,
  line_timestamp INTEGER,
  source_type TEXT,
  group_id TEXT,
  user_id TEXT,
  event_type TEXT,
  is_redelivery INTEGER DEFAULT 0,
  raw_json TEXT NOT NULL
);

CREATE TABLE media_fetches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  webhook_event_id TEXT,
  mime TEXT,
  size_bytes INTEGER,
  success INTEGER,
  duration_ms INTEGER,
  error TEXT,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE profile_probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT,
  user_id TEXT,
  display_name TEXT,
  status_code INTEGER,
  success INTEGER,
  raw_response TEXT,
  probed_at INTEGER NOT NULL
);

CREATE TABLE push_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_type TEXT,
  group_id TEXT,
  recipient_count INTEGER,
  status_code INTEGER,
  pushed_at INTEGER NOT NULL
);

CREATE TABLE errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context TEXT,
  message TEXT,
  stack TEXT,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX idx_raw_events_group_id ON raw_events(group_id);
CREATE INDEX idx_raw_events_event_type ON raw_events(event_type);
CREATE INDEX idx_profile_probes_group_user ON profile_probes(group_id, user_id);
CREATE INDEX idx_push_log_pushed_at ON push_log(pushed_at);
