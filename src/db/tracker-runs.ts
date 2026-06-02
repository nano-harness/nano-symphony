import type { Database } from "bun:sqlite";
import { bus } from "./event_bus.ts";
import type { SymphonyRun } from "./tracker-types.ts";

export function createRunOps(db: Database) {
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

  const updateTokenStatsStmt = db.prepare(`
    UPDATE symphony_runs SET token_input = ?, token_output = ?, token_total = ? WHERE issue_id = ?
  `);

  const getActiveRunsStmt = db.prepare(`
    SELECT * FROM symphony_runs WHERE last_state NOT IN ('released')
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

  // S9: Track the agent PID in the DB so crash-restart can kill orphaned processes.
  const updateAgentPidStmt = db.prepare(`
    UPDATE symphony_runs SET agent_pid = ? WHERE issue_id = ?
  `);

  function hydrateRun(r: Omit<SymphonyRun, "workspace_managed" | "current_attempt"> & { workspace_managed: number; current_attempt: number | null }): SymphonyRun {
    return { ...r, workspace_managed: r.workspace_managed === 1, current_attempt: r.current_attempt };
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
    return runs.map(hydrateRun);
  }

  function updateTokenStats(issueId: string, input: number, output: number, total: number): void {
    updateTokenStatsStmt.run(input, output, total, issueId);
    bus.emit("run", { issue_id: issueId, token_input: input, token_output: output, token_total: total });
  }

  function getActiveRuns(): SymphonyRun[] {
    const runs = getActiveRunsStmt.all() as Array<Omit<SymphonyRun, "workspace_managed" | "current_attempt"> & { workspace_managed: number; current_attempt: number | null }>;
    return runs.map(hydrateRun);
  }

  function getRun(issueId: string): SymphonyRun | null {
    const run = getRunStmt.get(issueId) as (Omit<SymphonyRun, "workspace_managed" | "current_attempt"> & { workspace_managed: number; current_attempt: number | null }) | null;
    if (!run) return null;
    return hydrateRun(run);
  }

  function updateWorkspacePath(issueId: string, wsPath: string, managed: boolean): void {
    updateWorkspacePathStmt.run(wsPath, managed ? 1 : 0, issueId);
    bus.emit("run", { issue_id: issueId, workspace_path: wsPath, workspace_managed: managed });
  }

  function markCurrentAttempt(issueId: string, attempt: number): void {
    markCurrentAttemptStmt.run(attempt, issueId);
    bus.emit("run", { issue_id: issueId, current_attempt: attempt });
  }

  function recordPatch(issueId: string, _attempt: number, patch: string | null): void {
    recordPatchStmt.run(patch, issueId);
  }

  // S9: Persist the live agent PID so crash-restart can identify and kill orphaned agents.
  function updateAgentPid(issueId: string, pid: number | null): void {
    updateAgentPidStmt.run(pid, issueId);
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
  };
}
