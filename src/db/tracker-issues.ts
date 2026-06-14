import type { Database } from "bun:sqlite";
import type { Issue, IssueInput } from "./tracker-types.ts";
import { WAIT_STATES } from "./wait-states.ts";

type IssueRow = Omit<Issue, "labels" | "blockers">;

export function hydrateIssueRow(base: Record<string, unknown>): IssueRow {
  const raw = base as Record<string, unknown>;
  const rp = raw["require_plan"];
  return {
    ...(raw as IssueRow),
    id: Number(raw["id"]),
    identifier: (raw["identifier"] as string | null) ?? `TASK-${raw["id"]}`,
    require_plan: rp === 1 ? true : rp === 0 ? false : null,
    plan_run_id: (raw["plan_run_id"] as string | null) ?? null,
    expected_schema: (raw["expected_schema"] as string | null) ?? null,
    scratchpad: (raw["scratchpad"] as string | null) ?? null,
    agent_binary: (raw["agent_binary"] as string | null) ?? null,
    agent_role: (raw["agent_role"] as string | null) ?? null,
    plan_estimates_json: (raw["plan_estimates_json"] as string | null) ?? null,
    plan_actuals_json: (raw["plan_actuals_json"] as string | null) ?? null,
    plan_progress_json: (raw["plan_progress_json"] as string | null) ?? null,
    cost_budget_usd: (raw["cost_budget_usd"] as number | null) ?? null,
    token_budget: (raw["token_budget"] as number | null) ?? null,
    cost_usd: (raw["cost_usd"] as number | null) ?? null,
    token_total: (raw["token_total"] as number | null) ?? null,
  };
}

export function serializeIssue(
  row: IssueRow & { labels: string[]; blockers: Array<{ blocker_uuid: string; blocker_state: string }> },
): Issue {
  return { ...row, identifier: row.identifier ?? `TASK-${row.id}` };
}

export function createIssueOps(db: Database) {
  const insertIssueStmt = db.prepare(`
    INSERT INTO issues (uuid, identifier, title, description, priority, state, branch, url, workspace_path, agent_kind, agent_binary, agent_role, require_plan, plan_run_id, expected_schema, scratchpad, plan_estimates_json, plan_actuals_json, plan_progress_json, cost_budget_usd, token_budget, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateIssueStmt = db.prepare(`
    UPDATE issues
    SET identifier = ?, title = ?, description = ?, priority = ?, state = ?, branch = ?, url = ?,
        workspace_path = ?, agent_kind = ?, agent_binary = ?, agent_role = ?, require_plan = ?, plan_run_id = ?,
        expected_schema = ?, scratchpad = ?, plan_estimates_json = ?, plan_actuals_json = ?, plan_progress_json = ?, cost_budget_usd = ?, token_budget = ?, updated_at = ?
    WHERE uuid = ?
  `);

  const insertLabelStmt = db.prepare(`
    INSERT OR IGNORE INTO issue_labels (issue_uuid, label) VALUES (?, ?)
  `);

  const deleteLabelStmt = db.prepare(`
    DELETE FROM issue_labels WHERE issue_uuid = ?
  `);

  const deleteIssueStmt = db.prepare(`
    DELETE FROM issues WHERE uuid = ?
  `);

  const getWorkspaceStmt = db.prepare(`
    SELECT workspace_path, workspace_managed FROM symphony_runs WHERE issue_uuid = ?
  `);

  const deleteIssueRunStmt = db.prepare(`
    DELETE FROM symphony_runs WHERE issue_uuid = ?
  `);

  const deleteIssueEventsStmt = db.prepare(`
    DELETE FROM symphony_events WHERE issue_uuid = ?
  `);

  const deleteIssueBlockersStmt = db.prepare(`
    DELETE FROM issue_blockers WHERE issue_uuid = ? OR blocker_uuid = ?
  `);

  const deleteIssueCommentsStmt = db.prepare(`
    DELETE FROM issue_comments WHERE issue_uuid = ?
  `);

  const deleteIssueArtifactsStmt = db.prepare(`
    DELETE FROM symphony_artifacts WHERE issue_uuid = ?
  `);

  const getIssueBaseStmt = db.prepare(`
    SELECT * FROM issues WHERE uuid = ?
  `);

  const getIssueByIdentifierStmt = db.prepare(`
    SELECT * FROM issues WHERE identifier = ?
  `);

  const getLabelsStmt = db.prepare(`
    SELECT label FROM issue_labels WHERE issue_uuid = ?
  `);

  const getBlockersStmt = db.prepare(`
    SELECT blocker_uuid, blocker_state FROM issue_blockers WHERE issue_uuid = ?
  `);

  const listIssuesStmt = db.prepare(`
    SELECT
      issues.*,
      COALESCE(llm_summary.cost_usd, 0) AS cost_usd,
      COALESCE(llm_summary.total_tokens, 0) AS token_total
    FROM issues
    LEFT JOIN (
      SELECT issue_uuid, COALESCE(SUM(cost_usd), 0) AS cost_usd, COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
      FROM llm_calls
      GROUP BY issue_uuid
    ) AS llm_summary ON issues.uuid = llm_summary.issue_uuid
    ORDER BY issues.created_at DESC
  `);

  const listIssuesByStateStmt = db.prepare(`
    SELECT
      issues.*,
      COALESCE(llm_summary.cost_usd, 0) AS cost_usd,
      COALESCE(llm_summary.total_tokens, 0) AS token_total
    FROM issues
    LEFT JOIN (
      SELECT issue_uuid, COALESCE(SUM(cost_usd), 0) AS cost_usd, COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
      FROM llm_calls
      GROUP BY issue_uuid
    ) AS llm_summary ON issues.uuid = llm_summary.issue_uuid
    WHERE issues.state = ?
    ORDER BY issues.created_at DESC
  `);

  const listIssuesByPlanRunStmt = db.prepare(`
    SELECT * FROM issues WHERE plan_run_id = ? ORDER BY created_at ASC
  `);

  const updateIssueStateStmt = db.prepare(`
    UPDATE issues SET state = ?, updated_at = ? WHERE uuid = ?
  `);

  const updateIssuePlanRunIdStmt = db.prepare(`
    UPDATE issues SET plan_run_id = ?, updated_at = ? WHERE uuid = ?
  `);

  const updateIssueScratchpadStmt = db.prepare(`
    UPDATE issues SET scratchpad = ?, updated_at = ? WHERE uuid = ?
  `);

  const updateIssuePlanEstimatesStmt = db.prepare(`
    UPDATE issues SET plan_estimates_json = ?, updated_at = ? WHERE uuid = ?
  `);

  const updateIssuePlanActualsStmt = db.prepare(`
    UPDATE issues SET plan_actuals_json = ?, updated_at = ? WHERE uuid = ?
  `);

  const updateIssuePlanProgressStmt = db.prepare(`
    UPDATE issues SET plan_progress_json = ?, updated_at = ? WHERE uuid = ?
  `);

  const insertBlockerStmt = db.prepare(`
    INSERT OR REPLACE INTO issue_blockers (issue_uuid, blocker_uuid, blocker_state)
    VALUES (?, ?, ?)
  `);

  const removeBlockerStmt = db.prepare(`
    DELETE FROM issue_blockers WHERE issue_uuid = ? AND blocker_uuid = ?
  `);

  const syncBlockerStateStmt = db.prepare(`
    UPDATE issue_blockers SET blocker_state = ? WHERE blocker_uuid = ?
  `);

  const updateLastBlockerFingerprintStmt = db.prepare(`
    UPDATE issues SET last_blocker_fingerprint = ? WHERE uuid = ?
  `);

  const getLastBlockerFingerprintStmt = db.prepare(`
    SELECT last_blocker_fingerprint FROM issues WHERE uuid = ?
  `);

  const getCandidatesStmt = db.prepare(`
    SELECT issues.*
    FROM issues
    LEFT JOIN symphony_runs ON issues.uuid = symphony_runs.issue_uuid
    WHERE issues.state NOT IN ('done', 'cancelled', 'backlog', 'plan_review', ${WAIT_STATES.map(() => "?").join(", ")})
      AND (
        symphony_runs.issue_uuid IS NULL
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
      AND issues.uuid NOT IN (
        SELECT issue_uuid FROM issue_blockers
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

  function getIssue(uuid: string): Issue | null {
    const raw = getIssueBaseStmt.get(uuid) as Record<string, unknown> | null;
    if (!raw) return null;
    const base = hydrateIssueRow(raw);
    const labels = (getLabelsStmt.all(uuid) as { label: string }[]).map((r) => r.label);
    const blockers = getBlockersStmt.all(uuid) as Array<{ blocker_uuid: string; blocker_state: string }>;
    return serializeIssue({ ...base, labels, blockers });
  }

  function getIssueByIdentifier(identifier: string): Issue | null {
    const raw = getIssueByIdentifierStmt.get(identifier) as Record<string, unknown> | null;
    if (!raw) return null;
    const base = hydrateIssueRow(raw);
    const labels = (getLabelsStmt.all(base.uuid) as { label: string }[]).map((r) => r.label);
    const blockers = getBlockersStmt.all(base.uuid) as Array<{ blocker_uuid: string; blocker_state: string }>;
    return serializeIssue({ ...base, labels, blockers });
  }

  function resolveIssue(id: string): Issue | null {
    // Try UUID first, then custom identifier.
    return getIssue(id) ?? getIssueByIdentifier(id);
  }

  function insertIssue(issue: IssueInput): Issue {
    const now = new Date().toISOString();
    const requirePlan = issue.require_plan === true ? 1 : issue.require_plan === false ? 0 : null;
    insertIssueStmt.run(
      issue.uuid,
      issue.identifier ?? null,
      issue.title,
      issue.description ?? null,
      issue.priority ?? "medium",
      issue.state,
      issue.branch ?? null,
      issue.url ?? null,
      issue.workspace_path ?? null,
      issue.agent_kind ?? null,
      issue.agent_binary ?? null,
      issue.agent_role ?? null,
      requirePlan,
      issue.plan_run_id ?? null,
      issue.expected_schema ?? null,
      issue.scratchpad ?? null,
      issue.plan_estimates_json ?? null,
      issue.plan_actuals_json ?? null,
      issue.plan_progress_json ?? null,
      issue.cost_budget_usd ?? null,
      issue.token_budget ?? null,
      (issue as { created_at?: string }).created_at ?? now,
      (issue as { updated_at?: string }).updated_at ?? now,
    );
    deleteLabelStmt.run(issue.uuid);
    for (const label of issue.labels ?? []) {
      insertLabelStmt.run(issue.uuid, label);
    }
    const created = getIssue(issue.uuid);
    if (!created) throw new Error(`Issue ${issue.uuid} not found after creation`);
    return created;
  }

  function updateIssue(uuid: string, patch: Omit<IssueInput, "uuid"> & { updated_at?: string }): Issue | null {
    if (!getIssueBaseStmt.get(uuid)) return null;
    const now = new Date().toISOString();
    const requirePlan = patch.require_plan === true ? 1 : patch.require_plan === false ? 0 : null;
    updateIssueStmt.run(
      patch.identifier ?? null,
      patch.title,
      patch.description ?? null,
      patch.priority ?? "medium",
      patch.state,
      patch.branch ?? null,
      patch.url ?? null,
      patch.workspace_path ?? null,
      patch.agent_kind ?? null,
      patch.agent_binary ?? null,
      patch.agent_role ?? null,
      requirePlan,
      patch.plan_run_id ?? null,
      patch.expected_schema ?? null,
      patch.scratchpad ?? null,
      patch.plan_estimates_json ?? null,
      patch.plan_actuals_json ?? null,
      patch.plan_progress_json ?? null,
      patch.cost_budget_usd ?? null,
      patch.token_budget ?? null,
      patch.updated_at ?? now,
      uuid,
    );
    if (patch.labels !== undefined) {
      deleteLabelStmt.run(uuid);
      for (const label of patch.labels) insertLabelStmt.run(uuid, label);
    }
    return getIssue(uuid);
  }

  function insertBlocker(issueUuid: string, blockerUuid: string, blockerState: string): void {
    insertBlockerStmt.run(issueUuid, blockerUuid, blockerState);
  }

  function removeBlocker(issueUuid: string, blockerUuid: string): void {
    removeBlockerStmt.run(issueUuid, blockerUuid);
  }

  function updateIssueState(issueUuid: string, newState: string): void {
    updateIssueStateStmt.run(newState, new Date().toISOString(), issueUuid);
    // Keep dependent issue_blockers rows in sync so candidate queries remain accurate.
    syncBlockerStateStmt.run(newState, issueUuid);
  }

  function updateIssuePlanRunId(issueUuid: string, planRunId: string | null): void {
    updateIssuePlanRunIdStmt.run(planRunId, new Date().toISOString(), issueUuid);
  }

  function updateIssueScratchpad(issueUuid: string, scratchpad: string | null): void {
    updateIssueScratchpadStmt.run(scratchpad, new Date().toISOString(), issueUuid);
  }

  function updateIssuePlanEstimates(issueUuid: string, estimates: unknown): void {
    updateIssuePlanEstimatesStmt.run(JSON.stringify(estimates), new Date().toISOString(), issueUuid);
  }

  function updateIssuePlanActuals(issueUuid: string, actuals: unknown): void {
    updateIssuePlanActualsStmt.run(JSON.stringify(actuals), new Date().toISOString(), issueUuid);
  }

  function updateIssuePlanProgress(issueUuid: string, progress: unknown): void {
    updateIssuePlanProgressStmt.run(JSON.stringify(progress), new Date().toISOString(), issueUuid);
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
      const labels = (getLabelsStmt.all(row.uuid) as { label: string }[]).map((r) => r.label);
      const blockers = getBlockersStmt.all(row.uuid) as Array<{ blocker_uuid: string; blocker_state: string }>;
      return serializeIssue({ ...row, labels, blockers });
    });
  }

  function listIssuesByPlanRun(planRunId: string): Issue[] {
    const rows = listIssuesByPlanRunStmt.all(planRunId) as Record<string, unknown>[];
    return rows.map((raw) => {
      const row = hydrateIssueRow(raw);
      const labels = (getLabelsStmt.all(row.uuid) as { label: string }[]).map((r) => r.label);
      const blockers = getBlockersStmt.all(row.uuid) as Array<{ blocker_uuid: string; blocker_state: string }>;
      return serializeIssue({ ...row, labels, blockers });
    });
  }

  function getCandidates(limit: number): Issue[] {
    const now = Date.now();
    // Parameters: [...WAIT_STATES for NOT IN, now for next_due_ts, limit]
    const rows = getCandidatesStmt.all(...WAIT_STATES, now, limit) as Record<string, unknown>[];
    return rows.map((raw) => {
      const row = hydrateIssueRow(raw);
      const labels = (getLabelsStmt.all(row.uuid) as { label: string }[]).map((r) => r.label);
      const blockers = getBlockersStmt.all(row.uuid) as Array<{ blocker_uuid: string; blocker_state: string }>;
      return serializeIssue({ ...row, labels, blockers });
    });
  }

  function deleteIssue(uuid: string): { deleted: boolean; workspace?: { path: string; managed: boolean } } {
    if (!getIssueBaseStmt.get(uuid)) return { deleted: false };
    // Read workspace info before the transaction deletes the run row
    const wsRow = getWorkspaceStmt.get(uuid) as { workspace_path: string | null; workspace_managed: number | null } | null;
    const workspace =
      wsRow?.workspace_path
        ? { path: wsRow.workspace_path, managed: wsRow.workspace_managed === 1 }
        : undefined;
    // A4: Wrap all 7-table delete in a single transaction to prevent orphaned
    // rows if the process is interrupted mid-delete.
    const deleteAll = db.transaction(() => {
      deleteLabelStmt.run(uuid);
      deleteIssueBlockersStmt.run(uuid, uuid);
      deleteIssueEventsStmt.run(uuid);
      deleteIssueCommentsStmt.run(uuid);
      deleteIssueArtifactsStmt.run(uuid);
      deleteIssueRunStmt.run(uuid);
      deleteIssueStmt.run(uuid);
    });
    deleteAll();
    return { deleted: true, workspace };
  }

  function updateLastBlockerFingerprint(issueUuid: string, fingerprint: string | null): void {
    updateLastBlockerFingerprintStmt.run(fingerprint, issueUuid);
  }

  function getLastBlockerFingerprint(issueUuid: string): string | null {
    const row = getLastBlockerFingerprintStmt.get(issueUuid) as { last_blocker_fingerprint: string | null } | null;
    return row?.last_blocker_fingerprint ?? null;
  }

  return {
    getIssue,
    getIssueByIdentifier,
    resolveIssue,
    insertIssue,
    updateIssue,
    insertBlocker,
    removeBlocker,
    updateIssueState,
    updateIssuePlanRunId,
    updateIssueScratchpad,
    updateIssuePlanEstimates,
    updateIssuePlanActuals,
    updateIssuePlanProgress,
    listIssues,
    listIssuesByPlanRun,
    getCandidates,
    deleteIssue,
    updateLastBlockerFingerprint,
    getLastBlockerFingerprint,
  };
}
