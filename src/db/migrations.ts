import { Database } from "bun:sqlite";
import sql from "./schema.sql" with { type: "text" };

export function runMigrations(db: Database): void {
  // A3: Enable WAL journal mode for better concurrency (multiple readers + one writer
  // simultaneously) and set a generous busy_timeout so concurrent callers retry
  // instead of throwing SQLITE_BUSY immediately.
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");

  db.exec(sql);

  // Best-effort forward migrations for older sqlite files.
  // SQLite doesn't support IF NOT EXISTS for ALTER COLUMN, so we probe.
  try {
    const cols = db.query("PRAGMA table_info(symphony_runs)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "last_issue_state")) {
      db.exec("ALTER TABLE symphony_runs ADD COLUMN last_issue_state TEXT DEFAULT ''");
    }
  } catch {
    // ignore
  }

  // Migration: Rename last_attempt to next_attempt
  try {
    const cols = db.query("PRAGMA table_info(symphony_runs)").all() as Array<{ name: string }>;
    const hasLastAttempt = cols.some((c) => c.name === "last_attempt");
    const hasNextAttempt = cols.some((c) => c.name === "next_attempt");

    if (hasLastAttempt && !hasNextAttempt) {
      // SQLite doesn't support RENAME COLUMN directly in older versions
      // Use temp table approach for maximum compatibility
      db.exec(`
        ALTER TABLE symphony_runs RENAME TO symphony_runs_old;

        CREATE TABLE symphony_runs (
          issue_id TEXT PRIMARY KEY,
          next_attempt INTEGER DEFAULT 0,
          last_state TEXT DEFAULT 'released',
          last_issue_state TEXT DEFAULT '',
          workspace_path TEXT DEFAULT '',
          next_due_ts INTEGER,
          last_event TEXT,
          last_event_ts INTEGER,
          last_error TEXT,
          token_input INTEGER DEFAULT 0,
          token_output INTEGER DEFAULT 0,
          token_total INTEGER DEFAULT 0
        );

        INSERT INTO symphony_runs
        SELECT issue_id, last_attempt, last_state, last_issue_state, workspace_path,
               next_due_ts, last_event, last_event_ts, last_error,
               token_input, token_output, token_total
        FROM symphony_runs_old;

        DROP TABLE symphony_runs_old;
      `);
    }
  } catch {
    // ignore - migration might have already run or table might not exist
  }

  // 2026-05: issues.workspace_path
  try {
    const cols = db.query("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "workspace_path")) {
      db.exec("ALTER TABLE issues ADD COLUMN workspace_path TEXT");
    }
  } catch {
    // ignore
  }

  // 2026-05: symphony_runs.workspace_managed
  try {
    const cols = db.query("PRAGMA table_info(symphony_runs)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "workspace_managed")) {
      db.exec("ALTER TABLE symphony_runs ADD COLUMN workspace_managed INTEGER DEFAULT 1");
    }
  } catch {
    // ignore
  }

  // 2026-05: issues.last_blocker_fingerprint
  try {
    const cols = db.query("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "last_blocker_fingerprint")) {
      db.exec("ALTER TABLE issues ADD COLUMN last_blocker_fingerprint TEXT");
    }
  } catch {
    // ignore
  }

  // 2026-05: symphony_runs.current_attempt
  try {
    const cols = db.query("PRAGMA table_info(symphony_runs)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "current_attempt")) {
      db.exec("ALTER TABLE symphony_runs ADD COLUMN current_attempt INTEGER");
    }
  } catch {
    // ignore
  }

  // 2026-05: symphony_runs.last_patch
  try {
    const cols = db.query("PRAGMA table_info(symphony_runs)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "last_patch")) {
      db.exec("ALTER TABLE symphony_runs ADD COLUMN last_patch TEXT DEFAULT NULL");
    }
  } catch {
    // ignore
  }

  // 2026-05: issues.agent_kind
  try {
    const cols = db.query("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "agent_kind")) {
      db.exec("ALTER TABLE issues ADD COLUMN agent_kind TEXT");
    }
  } catch {
    // ignore
  }

  // 2026-06: rebuild issues table — remove agent_binary, sandbox_mode,
  // sandbox_extra_writable_paths, sandbox_extra_read_only_paths,
  // sandbox_extra_denied_paths, permission_mode_override columns.
  try {
    const cols = db.query("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "sandbox_mode" || c.name === "agent_binary")) {
      db.exec(`
        CREATE TABLE issues_new (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          description TEXT,
          priority TEXT NOT NULL DEFAULT 'medium',
          state TEXT NOT NULL,
          branch TEXT,
          url TEXT,
          workspace_path TEXT,
          agent_kind TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_blocker_fingerprint TEXT
        );
        INSERT INTO issues_new (id, identifier, title, description, priority, state, branch, url, workspace_path, agent_kind, created_at, updated_at, last_blocker_fingerprint)
          SELECT id, identifier, title, description, priority, state, branch, url, workspace_path, agent_kind, created_at, updated_at, last_blocker_fingerprint FROM issues;
        DROP TABLE issues;
        ALTER TABLE issues_new RENAME TO issues;
        CREATE INDEX idx_issues_state ON issues(state);
        CREATE INDEX idx_issues_identifier ON issues(identifier);
      `);
    }
  } catch {
    // ignore
  }

  // 2026-05: issue_comments table
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='issue_comments'").all();
    if (tables.length === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS issue_comments (
          id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          author TEXT NOT NULL DEFAULT 'operator',
          body TEXT NOT NULL,
          metadata_json TEXT,
          FOREIGN KEY (issue_id) REFERENCES issues(id)
        );
        CREATE INDEX IF NOT EXISTS idx_issue_comments_issue_ts
          ON issue_comments(issue_id, ts ASC);
      `);
    }
  } catch {
    // ignore
  }

  // 2026-05: symphony_artifacts table
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='symphony_artifacts'").all();
    if (tables.length === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS symphony_artifacts (
          id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
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
          FOREIGN KEY (issue_id) REFERENCES issues(id)
        );
        CREATE INDEX IF NOT EXISTS idx_symphony_artifacts_issue_attempt
          ON symphony_artifacts(issue_id, attempt, ts ASC);
      `);
    }
  } catch {
    // ignore
  }

  // S9: symphony_runs.agent_pid — stores the PID of the live agent subprocess so
  // that a crash-restart can kill any orphaned agent processes.
  try {
    const cols = db.query("PRAGMA table_info(symphony_runs)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "agent_pid")) {
      db.exec("ALTER TABLE symphony_runs ADD COLUMN agent_pid INTEGER DEFAULT NULL");
    }
  } catch {
    // ignore
  }
}
