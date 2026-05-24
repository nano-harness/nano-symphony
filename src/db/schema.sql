CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  identifier TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'medium',
  state TEXT NOT NULL,
  branch TEXT,
  url TEXT,
  workspace_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_blocker_fingerprint TEXT,
  agent_kind TEXT CHECK (agent_kind IS NULL OR agent_kind IN ('nano', 'claude-code')),
  agent_binary TEXT
);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (issue_id, label),
  FOREIGN KEY (issue_id) REFERENCES issues(id)
);

CREATE TABLE IF NOT EXISTS issue_blockers (
  issue_id TEXT NOT NULL,
  blocker_id TEXT NOT NULL,
  blocker_state TEXT NOT NULL,
  PRIMARY KEY (issue_id, blocker_id)
);

CREATE TABLE IF NOT EXISTS symphony_runs (
  issue_id TEXT PRIMARY KEY,
  next_attempt INTEGER DEFAULT 0,
  current_attempt INTEGER,
  last_state TEXT DEFAULT 'released',
  last_issue_state TEXT DEFAULT '',
  workspace_path TEXT DEFAULT '',
  workspace_managed INTEGER DEFAULT 1,
  next_due_ts INTEGER,
  last_event TEXT,
  last_event_ts INTEGER,
  last_error TEXT,
  token_input INTEGER DEFAULT 0,
  token_output INTEGER DEFAULT 0,
  token_total INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS symphony_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT,
  FOREIGN KEY (issue_id) REFERENCES issues(id)
);

-- rowid is used as an implicit tie-breaker by latest-event queries.
CREATE INDEX IF NOT EXISTS idx_symphony_events_issue_kind_ts
ON symphony_events(issue_id, kind, ts DESC);

CREATE TABLE IF NOT EXISTS symphony_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
