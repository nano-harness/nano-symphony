import { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { bus } from "./event_bus.ts";
import type { RunPatch } from "./event_bus.ts";

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: string;
  state: string;
  branch: string | null;
  url: string | null;
  workspace_path: string | null;
  agent_kind: "nano" | "claude-code" | null;
  agent_binary: string | null;
  sandbox_mode: "default" | "off" | null;
  sandbox_extra_writable_paths: string[];
  created_at: string;
  updated_at: string;
  labels: string[];
  blockers: Array<{ blocker_id: string; blocker_state: string }>;
}

export interface IssueInput {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: string;
  state: string;
  branch?: string | null;
  url?: string | null;
  workspace_path?: string | null;
  agent_kind?: "nano" | "claude-code" | null;
  agent_binary?: string | null;
  sandbox_mode?: "default" | "off" | null;
  sandbox_extra_writable_paths?: string[];
  labels?: string[];
}

export interface SymphonyRun {
  issue_id: string;
  next_attempt: number;
  current_attempt: number | null;
  last_state: string;
  last_issue_state: string;
  workspace_path: string;
  workspace_managed: boolean;
  next_due_ts: number | null;
  last_event: string | null;
  last_event_ts: number | null;
  last_error: string | null;
  token_input: number;
  token_output: number;
  token_total: number;
}

export interface SymphonyEvent {
  id: string;
  issue_id: string;
  ts: number;
  kind: string;
  message: string;
  payload_json: string | null;
}

export function createTracker(db: Database) {
  const insertIssueStmt = db.prepare(`
    INSERT OR REPLACE INTO issues (id, identifier, title, description, priority, state, branch, url, workspace_path, agent_kind, agent_binary, sandbox_mode, sandbox_extra_writable_paths, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertLabelStmt = db.prepare(`
    INSERT OR IGNORE INTO issue_labels (issue_id, label) VALUES (?, ?)
  `);

  const deleteLabelStmt = db.prepare(`
    DELETE FROM issue_labels WHERE issue_id = ?
  `);

  const deleteIssueStmt = db.prepare(`
    DELETE FROM issues WHERE id = ?
  `);

  const deleteIssueRunStmt = db.prepare(`
    DELETE FROM symphony_runs WHERE issue_id = ?
  `);

  const deleteIssueEventsStmt = db.prepare(`
    DELETE FROM symphony_events WHERE issue_id = ?
  `);

  const deleteIssueBlockersStmt = db.prepare(`
    DELETE FROM issue_blockers WHERE issue_id = ? OR blocker_id = ?
  `);

  const getIssueBaseStmt = db.prepare(`
    SELECT * FROM issues WHERE id = ?
  `);

  const getLabelsStmt = db.prepare(`
    SELECT label FROM issue_labels WHERE issue_id = ?
  `);

  const getBlockersStmt = db.prepare(`
    SELECT blocker_id, blocker_state FROM issue_blockers WHERE issue_id = ?
  `);

  const listIssuesStmt = db.prepare(`
    SELECT * FROM issues ORDER BY created_at DESC
  `);

  const listIssuesByStateStmt = db.prepare(`
    SELECT * FROM issues WHERE state = ? ORDER BY created_at DESC
  `);

  const getNextTaskNumStmt = db.prepare(`
    SELECT MAX(CAST(SUBSTR(identifier, 6) AS INTEGER)) AS max_n
    FROM issues
    WHERE identifier GLOB 'TASK-[0-9]*'
  `);

  const insertBlockerStmt = db.prepare(`
    INSERT OR REPLACE INTO issue_blockers (issue_id, blocker_id, blocker_state)
    VALUES (?, ?, ?)
  `);

  const updateIssueStateStmt = db.prepare(`
    UPDATE issues SET state = ?, updated_at = ? WHERE id = ?
  `);

  const getCandidatesStmt = db.prepare(`
    SELECT issues.*
    FROM issues
    LEFT JOIN symphony_runs ON issues.id = symphony_runs.issue_id
    WHERE issues.state NOT IN ('done', 'cancelled', 'backlog')
      AND (
        symphony_runs.issue_id IS NULL
        OR (
          symphony_runs.last_state IN ('released', 'retry_queued')
          AND (
            symphony_runs.last_issue_state IS NULL
            OR symphony_runs.last_issue_state = ''
            OR symphony_runs.last_issue_state != issues.state
          )
        )
      )
      AND (
        symphony_runs.last_state != 'retry_queued'
        OR symphony_runs.next_due_ts IS NULL
        OR symphony_runs.next_due_ts <= ?
      )
      AND issues.id NOT IN (
        SELECT issue_id FROM issue_blockers
        WHERE blocker_state NOT IN ('done', 'cancelled')
      )
    ORDER BY
      CASE issues.priority
        WHEN 'urgent' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
        ELSE 5
      END,
      issues.created_at
    LIMIT ?
  `);

  const claimIssueStmt = db.prepare(`
    INSERT INTO symphony_runs (issue_id, next_attempt, last_state)
    VALUES (?, ?, 'claimed')
    ON CONFLICT(issue_id) DO UPDATE SET
      next_attempt = excluded.next_attempt,
      last_state = 'claimed'
    WHERE last_state IN ('released', 'retry_queued')
  `);

  const getRunStmt = db.prepare(`
    SELECT * FROM symphony_runs WHERE issue_id = ?
  `);

  const releaseIssueStmt = db.prepare(`
    UPDATE symphony_runs SET last_state = ? WHERE issue_id = ?
  `);

  const updateLastIssueStateStmt = db.prepare(`
    UPDATE symphony_runs SET last_issue_state = ? WHERE issue_id = ?
  `);

  const scheduleRetryStmt = db.prepare(`
    UPDATE symphony_runs SET last_state = 'retry_queued', next_due_ts = ?, next_attempt = ? WHERE issue_id = ?
  `);

  const fetchDueRetriesStmt = db.prepare(`
    SELECT * FROM symphony_runs
    WHERE last_state = 'retry_queued'
      AND (next_due_ts IS NULL OR next_due_ts <= ?)
  `);

  const recordEventStmt = db.prepare(`
    INSERT INTO symphony_events (id, issue_id, ts, kind, message, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const updateTokenStatsStmt = db.prepare(`
    UPDATE symphony_runs SET token_input = ?, token_output = ?, token_total = ? WHERE issue_id = ?
  `);

  const getActiveRunsStmt = db.prepare(`
    SELECT * FROM symphony_runs WHERE last_state NOT IN ('released')
  `);

  const getEventsSinceStmt = db.prepare(`
    SELECT * FROM symphony_events WHERE ts > ? ORDER BY ts ASC
  `);

  const getAllEventsStmt = db.prepare(`
    SELECT * FROM symphony_events ORDER BY ts ASC
  `);

  const getLatestEventByKindStmt = db.prepare(`
    SELECT * FROM symphony_events
    WHERE issue_id = ? AND kind = ?
    -- Multiple events can share a millisecond timestamp; rowid keeps "latest" deterministic.
    ORDER BY ts DESC, rowid DESC
    LIMIT 1
  `);

  const updateWorkspacePathStmt = db.prepare(`
    UPDATE symphony_runs SET workspace_path = ?, workspace_managed = ? WHERE issue_id = ?
  `);

  const markCurrentAttemptStmt = db.prepare(`
    UPDATE symphony_runs SET current_attempt = ? WHERE issue_id = ?
  `);

  const recordPatchStmt = db.prepare(`
    UPDATE symphony_runs SET last_patch = ? WHERE issue_id = ?
  `);

  const updateLastBlockerFingerprintStmt = db.prepare(`
    UPDATE issues SET last_blocker_fingerprint = ? WHERE id = ?
  `);

  const getLastBlockerFingerprintStmt = db.prepare(`
    SELECT last_blocker_fingerprint FROM issues WHERE id = ?
  `);

  function hydrateIssueRow(base: Record<string, unknown>): Omit<Issue, "labels" | "blockers"> {
    const row = base as Omit<Issue, "labels" | "blockers" | "sandbox_extra_writable_paths"> & { sandbox_extra_writable_paths: string | null };
    let paths: string[] = [];
    if (row.sandbox_extra_writable_paths) {
      try { paths = JSON.parse(row.sandbox_extra_writable_paths); } catch { /* ignore */ }
    }
    return { ...row, sandbox_extra_writable_paths: paths };
  }

  function getIssue(id: string): Issue | null {
    const raw = getIssueBaseStmt.get(id) as Record<string, unknown> | null;
    if (!raw) return null;
    const base = hydrateIssueRow(raw);
    const labels = (getLabelsStmt.all(id) as { label: string }[]).map((r) => r.label);
    const blockers = getBlockersStmt.all(id) as Array<{ blocker_id: string; blocker_state: string }>;
    return { ...base, labels, blockers };
  }

  function getNextTaskNumber(): number {
    const row = getNextTaskNumStmt.get() as { max_n: number | null } | null;
    return (row?.max_n ?? 0) + 1;
  }

  function insertIssue(issue: IssueInput): void {
    const now = new Date().toISOString();
    insertIssueStmt.run(
      issue.id,
      issue.identifier,
      issue.title,
      issue.description ?? null,
      issue.priority ?? "medium",
      issue.state,
      issue.branch ?? null,
      issue.url ?? null,
      issue.workspace_path ?? null,
      issue.agent_kind ?? null,
      issue.agent_binary ?? null,
      issue.sandbox_mode ?? null,
      issue.sandbox_extra_writable_paths?.length ? JSON.stringify(issue.sandbox_extra_writable_paths) : null,
      (issue as { created_at?: string }).created_at ?? now,
      (issue as { updated_at?: string }).updated_at ?? now,
    );
    deleteLabelStmt.run(issue.id);
    for (const label of issue.labels ?? []) {
      insertLabelStmt.run(issue.id, label);
    }
  }

  function insertBlocker(issueId: string, blockerId: string, blockerState: string): void {
    insertBlockerStmt.run(issueId, blockerId, blockerState);
  }

  function updateIssueState(issueId: string, newState: string): void {
    updateIssueStateStmt.run(newState, new Date().toISOString(), issueId);
  }

  function listIssues(filter?: { state?: string }): Issue[] {
    let rows: Record<string, unknown>[];
    if (filter?.state) {
      rows = listIssuesByStateStmt.all(filter.state) as Record<string, unknown>[];
    } else {
      rows = listIssuesStmt.all() as Record<string, unknown>[];
    }
    return rows.map((raw) => {
      const row = hydrateIssueRow(raw);
      const labels = (getLabelsStmt.all(row.id) as { label: string }[]).map((r) => r.label);
      const blockers = getBlockersStmt.all(row.id) as Array<{ blocker_id: string; blocker_state: string }>;
      return { ...row, labels, blockers };
    });
  }

  function getCandidates(limit: number): Issue[] {
    const now = Date.now();
    const rows = getCandidatesStmt.all(now, limit) as Record<string, unknown>[];
    return rows.map((raw) => {
      const row = hydrateIssueRow(raw);
      const labels = (getLabelsStmt.all(row.id) as { label: string }[]).map((r) => r.label);
      const blockers = getBlockersStmt.all(row.id) as Array<{ blocker_id: string; blocker_state: string }>;
      return { ...row, labels, blockers };
    });
  }

  function claimIssue(issueId: string, attempt: number): boolean {
    const result = claimIssueStmt.run(issueId, attempt);
    if (result.changes > 0) {
      bus.emit("run", { issue_id: issueId, next_attempt: attempt, last_state: "claimed" });
    }
    return result.changes > 0;
  }

  function releaseIssue(issueId: string, state: string): void {
    releaseIssueStmt.run(state, issueId);
    bus.emit("run", { issue_id: issueId, last_state: state });
  }

  function updateLastIssueState(issueId: string, issueState: string): void {
    updateLastIssueStateStmt.run(issueState, issueId);
  }

  function scheduleRetry(issueId: string, nextDueTs: number, attempt: number): void {
    scheduleRetryStmt.run(nextDueTs, attempt, issueId);
    bus.emit("run", { issue_id: issueId, last_state: "retry_queued", next_due_ts: nextDueTs, next_attempt: attempt });
  }

  function fetchDueRetries(now: number): SymphonyRun[] {
    const runs = fetchDueRetriesStmt.all(now) as Array<Omit<SymphonyRun, "workspace_managed" | "current_attempt"> & { workspace_managed: number; current_attempt: number | null }>;
    return runs.map((r) => ({ ...r, workspace_managed: r.workspace_managed === 1, current_attempt: r.current_attempt }));
  }

  function recordEvent(issueId: string, kind: string, message: string, payload?: unknown): void {
    const id = nanoid();
    const ts = Date.now();
    const payloadJson = payload !== undefined ? JSON.stringify(payload) : null;
    recordEventStmt.run(id, issueId, ts, kind, message, payloadJson);
    // Emit event on bus after DB write succeeds
    bus.emit("event", { id, issue_id: issueId, ts, kind, message, payload_json: payloadJson });
  }

  function updateTokenStats(issueId: string, input: number, output: number, total: number): void {
    updateTokenStatsStmt.run(input, output, total, issueId);
    bus.emit("run", { issue_id: issueId, token_input: input, token_output: output, token_total: total });
  }

  function getActiveRuns(): SymphonyRun[] {
    const runs = getActiveRunsStmt.all() as Array<Omit<SymphonyRun, "workspace_managed" | "current_attempt"> & { workspace_managed: number; current_attempt: number | null }>;
    return runs.map((r) => ({ ...r, workspace_managed: r.workspace_managed === 1, current_attempt: r.current_attempt }));
  }

  function getRun(issueId: string): SymphonyRun | null {
    const run = getRunStmt.get(issueId) as (Omit<SymphonyRun, "workspace_managed" | "current_attempt"> & { workspace_managed: number; current_attempt: number | null }) | null;
    if (!run) return null;
    return { ...run, workspace_managed: run.workspace_managed === 1, current_attempt: run.current_attempt };
  }

  function getEvents(since?: number): SymphonyEvent[] {
    if (since !== undefined) {
      return getEventsSinceStmt.all(since) as SymphonyEvent[];
    }
    return getAllEventsStmt.all() as SymphonyEvent[];
  }

  function getLatestEventByKind(issueId: string, kind: string): SymphonyEvent | null {
    return (getLatestEventByKindStmt.get(issueId, kind) as SymphonyEvent | null) ?? null;
  }

  function updateWorkspacePath(issueId: string, wsPath: string, managed: boolean): void {
    updateWorkspacePathStmt.run(wsPath, managed ? 1 : 0, issueId);
    bus.emit("run", { issue_id: issueId, workspace_path: wsPath, workspace_managed: managed });
  }

  function markCurrentAttempt(issueId: string, attempt: number): void {
    markCurrentAttemptStmt.run(attempt, issueId);
    bus.emit("run", { issue_id: issueId, current_attempt: attempt });
  }

  function recordPatch(issueId: string, attempt: number, patch: string | null): void {
    recordPatchStmt.run(patch, issueId);
  }

  function deleteIssue(id: string): boolean {
    if (!getIssueBaseStmt.get(id)) return false;
    deleteLabelStmt.run(id);
    deleteIssueBlockersStmt.run(id, id);
    deleteIssueEventsStmt.run(id);
    deleteIssueRunStmt.run(id);
    deleteIssueStmt.run(id);
    return true;
  }

  function updateLastBlockerFingerprint(issueId: string, fingerprint: string | null): void {
    updateLastBlockerFingerprintStmt.run(fingerprint, issueId);
  }

  function getLastBlockerFingerprint(issueId: string): string | null {
    const row = getLastBlockerFingerprintStmt.get(issueId) as { last_blocker_fingerprint: string | null } | null;
    return row?.last_blocker_fingerprint ?? null;
  }

  return {
    getIssue,
    getNextTaskNumber,
    insertIssue,
    insertBlocker,
    updateIssueState,
    listIssues,
    getCandidates,
    claimIssue,
    releaseIssue,
    updateLastIssueState,
    scheduleRetry,
    fetchDueRetries,
    recordEvent,
    updateTokenStats,
    getActiveRuns,
    getRun,
    getEvents,
    getLatestEventByKind,
    updateWorkspacePath,
    markCurrentAttempt,
    recordPatch,
    deleteIssue,
    updateLastBlockerFingerprint,
    getLastBlockerFingerprint,
  };
}

export type Tracker = ReturnType<typeof createTracker>;
