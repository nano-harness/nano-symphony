CREATE TABLE IF NOT EXISTS issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid        TEXT NOT NULL UNIQUE,
  identifier  TEXT UNIQUE,
  title       TEXT NOT NULL,
  description TEXT,
  priority    TEXT NOT NULL DEFAULT 'medium',
  state       TEXT NOT NULL,
  branch      TEXT,
  url         TEXT,
  workspace_path TEXT,
  agent_kind  TEXT CHECK (agent_kind IS NULL OR agent_kind IN ('nano', 'claude-code')),
  agent_binary TEXT,
  agent_role TEXT,
  require_plan INTEGER DEFAULT NULL,
  plan_run_id TEXT,
  expected_schema TEXT,
  scratchpad  TEXT,
  last_blocker_fingerprint TEXT,
  plan_estimates_json TEXT,
  plan_actuals_json TEXT,
  plan_progress_json TEXT,
  cost_budget_usd REAL,
  token_budget INTEGER,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_state       ON issues(state);
CREATE INDEX IF NOT EXISTS idx_issues_plan_run    ON issues(plan_run_id);
CREATE INDEX IF NOT EXISTS idx_issues_identifier  ON issues(identifier);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_uuid TEXT NOT NULL,
  label      TEXT NOT NULL,
  PRIMARY KEY (issue_uuid, label),
  FOREIGN KEY (issue_uuid) REFERENCES issues(uuid)
);

CREATE TABLE IF NOT EXISTS issue_blockers (
  issue_uuid   TEXT NOT NULL,
  blocker_uuid TEXT NOT NULL,
  blocker_state TEXT NOT NULL,
  PRIMARY KEY (issue_uuid, blocker_uuid)
);

CREATE TABLE IF NOT EXISTS symphony_runs (
  issue_uuid TEXT PRIMARY KEY,
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
  last_patch TEXT DEFAULT NULL,
  agent_pid INTEGER DEFAULT NULL,
  token_input INTEGER DEFAULT 0,
  token_output INTEGER DEFAULT 0,
  token_total INTEGER DEFAULT 0,
  heartbeat_at INTEGER DEFAULT NULL,
  heartbeat_timeout_ms INTEGER DEFAULT 120000
);

CREATE TABLE IF NOT EXISTS symphony_events (
  id TEXT PRIMARY KEY,
  issue_uuid TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT,
  FOREIGN KEY (issue_uuid) REFERENCES issues(uuid)
);

-- rowid is used as an implicit tie-breaker by latest-event queries.
CREATE INDEX IF NOT EXISTS idx_symphony_events_issue_kind_ts
ON symphony_events(issue_uuid, kind, ts DESC);

CREATE TABLE IF NOT EXISTS symphony_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS issue_comments (
  id TEXT PRIMARY KEY,
  issue_uuid TEXT NOT NULL,
  ts INTEGER NOT NULL,
  author TEXT NOT NULL DEFAULT 'operator',
  body TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (issue_uuid) REFERENCES issues(uuid)
);

CREATE INDEX IF NOT EXISTS idx_issue_comments_issue_ts
  ON issue_comments(issue_uuid, ts ASC);

CREATE TABLE IF NOT EXISTS symphony_artifacts (
  id TEXT PRIMARY KEY,
  issue_uuid TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mcp', 'git_diff')),
  kind TEXT NOT NULL,
  label TEXT,
  path TEXT,
  content TEXT,
  metadata_json TEXT,
  storage_path TEXT,
  content_size INTEGER DEFAULT 0,
  mime_type TEXT DEFAULT 'application/octet-stream',
  ts INTEGER NOT NULL,
  FOREIGN KEY (issue_uuid) REFERENCES issues(uuid)
);

CREATE INDEX IF NOT EXISTS idx_symphony_artifacts_issue_attempt
  ON symphony_artifacts(issue_uuid, attempt, ts ASC);

CREATE TABLE IF NOT EXISTS plan_runs (
  id                TEXT PRIMARY KEY,
  caller_issue_uuid TEXT,
  script            TEXT NOT NULL,
  meta              JSON NOT NULL,
  args              JSON,
  state             TEXT NOT NULL,
  dry_run_summary   JSON,
  approval_status   TEXT,
  approval_reason   TEXT,
  approved_at       INTEGER,
  approved_by       TEXT,
  result            TEXT,
  wall_time_ms      INTEGER NOT NULL,
  started_at        INTEGER,
  created_at        INTEGER NOT NULL,
  finished_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plan_runs_caller ON plan_runs(caller_issue_uuid);
CREATE INDEX IF NOT EXISTS idx_plan_runs_state  ON plan_runs(state);

CREATE TABLE IF NOT EXISTS plan_run_nodes (
  run_id        TEXT NOT NULL,
  node_key      TEXT NOT NULL,
  issue_uuid    TEXT,
  state         TEXT NOT NULL DEFAULT 'pending',
  started_at    INTEGER,
  finished_at   INTEGER,
  result_json   TEXT,
  error         TEXT,
  PRIMARY KEY (run_id, node_key)
);
CREATE INDEX IF NOT EXISTS idx_plan_run_nodes_run ON plan_run_nodes(run_id);

CREATE TABLE IF NOT EXISTS llm_calls (
  id              TEXT PRIMARY KEY,
  issue_uuid      TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  provider        TEXT,
  model           TEXT,
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  cost_usd        REAL,
  duration_ms     INTEGER,
  duration_api_ms INTEGER,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (issue_uuid) REFERENCES issues(uuid)
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_issue ON llm_calls(issue_uuid, attempt);

CREATE TABLE IF NOT EXISTS issue_results (
  issue_uuid  TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  version     INTEGER NOT NULL,
  data        JSON NOT NULL,
  validated   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (issue_uuid, attempt, version)
);

CREATE TABLE IF NOT EXISTS issue_metrics (
  issue_uuid    TEXT PRIMARY KEY,
  final_state   TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  sessions      INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  blocked       INTEGER NOT NULL DEFAULT 0,
  recorded_at   INTEGER NOT NULL,
  FOREIGN KEY (issue_uuid) REFERENCES issues(uuid)
);
