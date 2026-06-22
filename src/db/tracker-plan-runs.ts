import type { Database } from "bun:sqlite";
import { readJournal } from "../plan-runtime/journal.ts";
import type { JournalEntry } from "../plan-runtime/sdk.ts";

export interface PlanRun {
  id: string;
  caller_issue_uuid: string | null;
  script: string;
  meta: string; // JSON
  args: string | null; // JSON
  state: PlanRunState;
  dry_run_summary: string | null; // JSON
  approval_status: PlanRunApprovalStatus | null;
  approval_reason: string | null;
  approved_at: number | null;
  approved_by: string | null;
  result: string | null;
  wall_time_ms: number;
  started_at: number | null;
  created_at: number;
  finished_at: number | null;
}

export interface PlanRunNode {
  run_id: string;
  node_key: string;
  issue_uuid: string | null;
  state: string;
  started_at: number | null;
  finished_at: number | null;
  result_json: string | null;
  error: string | null;
}

export type PlanRunState =
  | "pending"
  | "dry_running"
  | "awaiting_approval"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type PlanRunApprovalStatus = "pending" | "approved" | "rejected";

export const PLAN_RUN_WALL_TIME_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createPlanRunOps(db: Database) {
  const insertStmt = db.prepare(`
    INSERT INTO plan_runs
      (id, caller_issue_uuid, script, meta, args, state, wall_time_ms, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  const getStmt = db.prepare(`SELECT * FROM plan_runs WHERE id = ?`);

  const listStmt = db.prepare(`SELECT * FROM plan_runs ORDER BY created_at DESC LIMIT ?`);

  const listByStateStmt = db.prepare(`
    SELECT * FROM plan_runs WHERE state = ? ORDER BY created_at DESC LIMIT ?
  `);

  const updateStateStmt = db.prepare(`
    UPDATE plan_runs SET state = ? WHERE id = ?
  `);

  const updateDryRunSummaryStmt = db.prepare(`
    UPDATE plan_runs SET state = 'awaiting_approval', dry_run_summary = ?, approval_status = 'pending' WHERE id = ?
  `);

  const setRunningStmt = db.prepare(`
    UPDATE plan_runs SET state = 'running', started_at = ? WHERE id = ?
  `);

  const finishStmt = db.prepare(`
    UPDATE plan_runs SET state = ?, result = ?, finished_at = ? WHERE id = ?
  `);

  const approveStmt = db.prepare(`
    UPDATE plan_runs
    SET approval_status = 'approved', approved_at = ?, approved_by = ?
    WHERE id = ?
  `);

  const rejectStmt = db.prepare(`
    UPDATE plan_runs
    SET state = 'cancelled', approval_status = 'rejected', approval_reason = ?, finished_at = ?
    WHERE id = ?
  `);

  const listPendingStmt = db.prepare(`
    SELECT * FROM plan_runs WHERE state = 'pending'
  `);

  const listRunningStmt = db.prepare(`
    SELECT * FROM plan_runs WHERE state = 'running'
  `);

  const listAwaitingApprovalStmt = db.prepare(`
    SELECT * FROM plan_runs WHERE state = 'awaiting_approval' AND approval_status = 'approved'
  `);

  const listFinalizedWithCallerStmt = db.prepare(`
    SELECT pr.* FROM plan_runs pr
    WHERE pr.state IN ('done', 'cancelled', 'failed')
      AND pr.caller_issue_uuid IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM symphony_events se
        WHERE se.issue_uuid = pr.caller_issue_uuid
          AND se.kind = 'caller_resumed'
          AND JSON_EXTRACT(se.payload_json, '$.plan_run_id') = pr.id
      )
  `);

  const listExpiredRunningStmt = db.prepare(`
    SELECT * FROM plan_runs
    WHERE state = 'running'
      AND started_at IS NOT NULL
      AND (? - started_at) > wall_time_ms
  `);

  const listByCallerStmt = db.prepare(`
    SELECT * FROM plan_runs WHERE caller_issue_uuid = ? ORDER BY created_at DESC
  `);

  const listNeedingProgressSyncStmt = db.prepare(`
    SELECT pr.* FROM plan_runs pr
    WHERE pr.state NOT IN ('done', 'failed', 'cancelled')
      OR (
        pr.state IN ('done', 'failed', 'cancelled')
        AND pr.caller_issue_uuid IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM issues i
          WHERE i.uuid = pr.caller_issue_uuid
            AND i.state NOT IN ('done', 'cancelled')
        )
      )
  `);

  const upsertPlanRunNodeStmt = db.prepare(`
    INSERT INTO plan_run_nodes (run_id, node_key, issue_uuid, state, started_at, finished_at, result_json, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, node_key) DO UPDATE SET
      issue_uuid = excluded.issue_uuid,
      state = excluded.state,
      started_at = COALESCE(excluded.started_at, plan_run_nodes.started_at),
      finished_at = excluded.finished_at,
      result_json = excluded.result_json,
      error = excluded.error
  `);

  const listPlanRunNodesStmt = db.prepare(`
    SELECT * FROM plan_run_nodes WHERE run_id = ? ORDER BY started_at ASC, node_key ASC
  `);

  function insertPlanRun(run: {
    id: string;
    caller_issue_uuid?: string | null;
    script: string;
    meta: unknown;
    args?: unknown;
    wall_time_ms?: number;
  }): void {
    insertStmt.run(
      run.id,
      run.caller_issue_uuid ?? null,
      run.script,
      JSON.stringify(run.meta),
      run.args !== undefined ? JSON.stringify(run.args) : null,
      run.wall_time_ms ?? PLAN_RUN_WALL_TIME_DEFAULT_MS,
      Date.now(),
    );
  }

  function getPlanRun(id: string): PlanRun | null {
    return (getStmt.get(id) as PlanRun | null) ?? null;
  }

  function listPlanRuns(filter?: { state?: PlanRunState; limit?: number }): PlanRun[] {
    const limit = filter?.limit ?? 100;
    if (filter?.state) {
      return listByStateStmt.all(filter.state, limit) as PlanRun[];
    }
    return listStmt.all(limit) as PlanRun[];
  }

  function updatePlanRunState(id: string, state: PlanRunState): void {
    updateStateStmt.run(state, id);
  }

  function setPlanRunDryRunSummary(id: string, summary: unknown): void {
    updateDryRunSummaryStmt.run(JSON.stringify(summary), id);
  }

  function setPlanRunRunning(id: string): void {
    setRunningStmt.run(Date.now(), id);
  }

  function finishPlanRun(id: string, state: "done" | "failed" | "cancelled", result?: string): void {
    finishStmt.run(state, result ?? null, Date.now(), id);
  }

  function approvePlanRun(id: string, approvedBy?: string): void {
    approveStmt.run(Date.now(), approvedBy ?? "operator", id);
  }

  function rejectPlanRun(id: string, reason?: string): void {
    rejectStmt.run(reason ?? null, Date.now(), id);
  }

  function listPendingPlanRuns(): PlanRun[] {
    return listPendingStmt.all() as PlanRun[];
  }

  function listRunningPlanRuns(): PlanRun[] {
    return listRunningStmt.all() as PlanRun[];
  }

  function listApprovedPlanRuns(): PlanRun[] {
    return listAwaitingApprovalStmt.all() as PlanRun[];
  }

  function listFinalizedPlanRunsWithCaller(): PlanRun[] {
    return listFinalizedWithCallerStmt.all() as PlanRun[];
  }

  function listExpiredRunningPlanRuns(now: number): PlanRun[] {
    return listExpiredRunningStmt.all(now) as PlanRun[];
  }

  function listPlanRunsByCaller(callerIssueId: string): PlanRun[] {
    return listByCallerStmt.all(callerIssueId) as PlanRun[];
  }

  function listPlanRunsNeedingProgressSync(): PlanRun[] {
    return listNeedingProgressSyncStmt.all() as PlanRun[];
  }

  function getPlanRunJournal(runId: string): JournalEntry[] {
    return readJournal(runId);
  }

  function upsertPlanRunNode(node: {
    run_id: string;
    node_key: string;
    issue_uuid?: string | null;
    state: string;
    started_at?: number | null;
    finished_at?: number | null;
    result?: unknown;
    error?: string | null;
  }): void {
    upsertPlanRunNodeStmt.run(
      node.run_id,
      node.node_key,
      node.issue_uuid ?? null,
      node.state,
      node.started_at ?? null,
      node.finished_at ?? null,
      node.result !== undefined ? JSON.stringify(node.result) : null,
      node.error ?? null,
    );
  }

  function listPlanRunNodes(runId: string): PlanRunNode[] {
    return listPlanRunNodesStmt.all(runId) as PlanRunNode[];
  }

  return {
    insertPlanRun,
    getPlanRun,
    listPlanRuns,
    updatePlanRunState,
    setPlanRunDryRunSummary,
    setPlanRunRunning,
    finishPlanRun,
    approvePlanRun,
    rejectPlanRun,
    listPendingPlanRuns,
    listRunningPlanRuns,
    listApprovedPlanRuns,
    listFinalizedPlanRunsWithCaller,
    listExpiredRunningPlanRuns,
    listPlanRunsByCaller,
    listPlanRunsNeedingProgressSync,
    getPlanRunJournal,
    upsertPlanRunNode,
    listPlanRunNodes,
  };
}
