import type { Database } from "bun:sqlite";
import type { Issue, IssueInput } from "./tracker-types.ts";

export function hydrateIssueRow(base: Record<string, unknown>): Omit<Issue, "labels" | "blockers"> {
  return base as Omit<Issue, "labels" | "blockers">;
}

export function createIssueOps(db: Database) {
  const insertIssueStmt = db.prepare(`
    INSERT OR REPLACE INTO issues (id, identifier, title, description, priority, state, branch, url, workspace_path, agent_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  const getWorkspaceStmt = db.prepare(`
    SELECT workspace_path, workspace_managed FROM symphony_runs WHERE issue_id = ?
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

  const deleteIssueCommentsStmt = db.prepare(`
    DELETE FROM issue_comments WHERE issue_id = ?
  `);

  const deleteIssueArtifactsStmt = db.prepare(`
    DELETE FROM symphony_artifacts WHERE issue_id = ?
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

  const updateIssueStateStmt = db.prepare(`
    UPDATE issues SET state = ?, updated_at = ? WHERE id = ?
  `);

  const insertBlockerStmt = db.prepare(`
    INSERT OR REPLACE INTO issue_blockers (issue_id, blocker_id, blocker_state)
    VALUES (?, ?, ?)
  `);

  const updateLastBlockerFingerprintStmt = db.prepare(`
    UPDATE issues SET last_blocker_fingerprint = ? WHERE id = ?
  `);

  const getLastBlockerFingerprintStmt = db.prepare(`
    SELECT last_blocker_fingerprint FROM issues WHERE id = ?
  `);

  const getCandidatesStmt = db.prepare(`
    SELECT issues.*
    FROM issues
    LEFT JOIN symphony_runs ON issues.id = symphony_runs.issue_id
    WHERE issues.state NOT IN ('done', 'cancelled', 'backlog', 'plan_review')
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

  function deleteIssue(id: string): { deleted: boolean; workspace?: { path: string; managed: boolean } } {
    if (!getIssueBaseStmt.get(id)) return { deleted: false };
    // Read workspace info before the transaction deletes the run row
    const wsRow = getWorkspaceStmt.get(id) as { workspace_path: string | null; workspace_managed: number | null } | null;
    const workspace =
      wsRow?.workspace_path
        ? { path: wsRow.workspace_path, managed: wsRow.workspace_managed === 1 }
        : undefined;
    // A4: Wrap all 7-table delete in a single transaction to prevent orphaned
    // rows if the process is interrupted mid-delete.
    const deleteAll = db.transaction(() => {
      deleteLabelStmt.run(id);
      deleteIssueBlockersStmt.run(id, id);
      deleteIssueEventsStmt.run(id);
      deleteIssueCommentsStmt.run(id);
      deleteIssueArtifactsStmt.run(id);
      deleteIssueRunStmt.run(id);
      deleteIssueStmt.run(id);
    });
    deleteAll();
    return { deleted: true, workspace };
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
    deleteIssue,
    updateLastBlockerFingerprint,
    getLastBlockerFingerprint,
  };
}
