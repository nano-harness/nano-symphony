import type { Database } from "bun:sqlite";
import { bus } from "./event_bus.ts";
import type { SymphonyRun } from "./tracker-types.ts";

export function createRunOps(db: Database) {
  const claimIssueStmt = db.prepare(`
    INSERT INTO symphony_runs (issue_uuid, next_attempt, last_state)
    VALUES (?, ?, 'claimed')
    ON CONFLICT(issue_uuid) DO UPDATE SET
      next_attempt = excluded.next_attempt,
      last_state = 'claimed'
    WHERE last_state IN ('released', 'retry_queued')
  `);

  const getRunStmt = db.prepare(`
    SELECT * FROM symphony_runs WHERE issue_uuid = ?
  `);

  const releaseIssueStmt = db.prepare(`
    UPDATE symphony_runs SET last_state = ? WHERE issue_uuid = ?
  `);

  const updateLastIssueStateStmt = db.prepare(`
    UPDATE symphony_runs SET last_issue_state = ? WHERE issue_uuid = ?
  `);

  const scheduleRetryStmt = db.prepare(`
    UPDATE symphony_runs SET last_state = 'retry_queued', next_due_ts = ?, next_attempt = ? WHERE issue_uuid = ?
  `);

  const fetchDueRetriesStmt = db.prepare(`
    SELECT * FROM symphony_runs
    WHERE last_state = 'retry_queued'
      AND (next_due_ts IS NULL OR next_due_ts <= ?)
  `);

  const updateTokenStatsStmt = db.prepare(`
    UPDATE symphony_runs SET token_input = ?, token_output = ?, token_total = ? WHERE issue_uuid = ?
  `);

  const getActiveRunsStmt = db.prepare(`
    SELECT * FROM symphony_runs WHERE last_state NOT IN ('released')
  `);

  const updateWorkspacePathStmt = db.prepare(`
    UPDATE symphony_runs SET workspace_path = ?, workspace_managed = ? WHERE issue_uuid = ?
  `);

  const markCurrentAttemptStmt = db.prepare(`
    UPDATE symphony_runs SET current_attempt = ? WHERE issue_uuid = ?
  `);

  const recordPatchStmt = db.prepare(`
    UPDATE symphony_runs SET last_patch = ? WHERE issue_uuid = ?
  `);

  // S9: Track the agent PID in the DB so crash-restart can kill orphaned processes.
  const updateAgentPidStmt = db.prepare(`
    UPDATE symphony_runs SET agent_pid = ? WHERE issue_uuid = ?
  `);

  const updateHeartbeatStmt = db.prepare(`
    UPDATE symphony_runs SET heartbeat_at = ? WHERE issue_uuid = ?
  `);

  const setHeartbeatTimeoutStmt = db.prepare(`
    UPDATE symphony_runs SET heartbeat_timeout_ms = ? WHERE issue_uuid = ?
  `);

  const fetchStaleRunsStmt = db.prepare(`
    SELECT * FROM symphony_runs
    WHERE last_state = 'claimed'
      AND (heartbeat_at IS NULL OR heartbeat_at < ?)
  `);

  function hydrateRun(r: Omit<SymphonyRun, "workspace_managed" | "current_attempt"> & { workspace_managed: number; current_attempt: number | null }): SymphonyRun {
    return { ...r, workspace_managed: r.workspace_managed === 1, current_attempt: r.current_attempt };
  }

  function claimIssue(issueUuid: string, attempt: number): boolean {
    const result = claimIssueStmt.run(issueUuid, attempt);
    if (result.changes > 0) {
      bus.emit("run", { issue_uuid: issueUuid, next_attempt: attempt, last_state: "claimed" });
    }
    return result.changes > 0;
  }

  function releaseIssue(issueUuid: string, state: string): void {
    releaseIssueStmt.run(state, issueUuid);
    bus.emit("run", { issue_uuid: issueUuid, last_state: state });
  }

  function updateLastIssueState(issueUuid: string, issueState: string): void {
    updateLastIssueStateStmt.run(issueState, issueUuid);
  }

  function scheduleRetry(issueUuid: string, nextDueTs: number, attempt: number): void {
    scheduleRetryStmt.run(nextDueTs, attempt, issueUuid);
    bus.emit("run", { issue_uuid: issueUuid, last_state: "retry_queued", next_due_ts: nextDueTs, next_attempt: attempt });
  }

  function fetchDueRetries(now: number): SymphonyRun[] {
    const runs = fetchDueRetriesStmt.all(now) as Array<Omit<SymphonyRun, "workspace_managed" | "current_attempt"> & { workspace_managed: number; current_attempt: number | null }>;
    return runs.map(hydrateRun);
  }

  function updateTokenStats(issueUuid: string, input: number, output: number, total: number): void {
    updateTokenStatsStmt.run(input, output, total, issueUuid);
    bus.emit("run", { issue_uuid: issueUuid, token_input: input, token_output: output, token_total: total });
  }

  function getActiveRuns(): SymphonyRun[] {
    const runs = getActiveRunsStmt.all() as Array<Omit<SymphonyRun, "workspace_managed" | "current_attempt"> & { workspace_managed: number; current_attempt: number | null }>;
    return runs.map(hydrateRun);
  }

  function getRun(issueUuid: string): SymphonyRun | null {
    const run = getRunStmt.get(issueUuid) as (Omit<SymphonyRun, "workspace_managed" | "current_attempt"> & { workspace_managed: number; current_attempt: number | null }) | null;
    if (!run) return null;
    return hydrateRun(run);
  }

  function updateWorkspacePath(issueUuid: string, wsPath: string, managed: boolean): void {
    updateWorkspacePathStmt.run(wsPath, managed ? 1 : 0, issueUuid);
    bus.emit("run", { issue_uuid: issueUuid, workspace_path: wsPath, workspace_managed: managed });
  }

  function markCurrentAttempt(issueUuid: string, attempt: number): void {
    markCurrentAttemptStmt.run(attempt, issueUuid);
    bus.emit("run", { issue_uuid: issueUuid, current_attempt: attempt });
  }

  function recordPatch(issueUuid: string, _attempt: number, patch: string | null): void {
    recordPatchStmt.run(patch, issueUuid);
  }

  // S9: Persist the live agent PID so crash-restart can identify and kill orphaned agents.
  function updateAgentPid(issueUuid: string, pid: number | null): void {
    updateAgentPidStmt.run(pid, issueUuid);
  }

  // Heartbeat: update timestamp when agent reports liveness (process-level or MCP tool)
  function updateHeartbeat(issueUuid: string, ts: number): void {
    updateHeartbeatStmt.run(ts, issueUuid);
  }

  // Heartbeat: set custom timeout per-run (defaults to config on worker start)
  function setHeartbeatTimeout(issueUuid: string, timeoutMs: number): void {
    setHeartbeatTimeoutStmt.run(timeoutMs, issueUuid);
  }

  // Fetch stale claimed runs: heartbeat_at is null or older than timeout
  function fetchStaleRuns(now: number): SymphonyRun[] {
    const runs = fetchStaleRunsStmt.all(now) as Array<Omit<SymphonyRun, "workspace_managed" | "current_attempt"> & { workspace_managed: number; current_attempt: number | null }>;
    return runs.map(hydrateRun);
  }

  return {
    claimIssue,
    releaseIssue,
    updateLastIssueState,
    scheduleRetry,
    fetchDueRetries,
    updateTokenStats,
    getActiveRuns,
    getRun,
    updateWorkspacePath,
    markCurrentAttempt,
    recordPatch,
    updateAgentPid,
    updateHeartbeat,
    setHeartbeatTimeout,
    fetchStaleRuns,
  };
}
