import type { Database } from "bun:sqlite";

export interface IssueResult {
  issue_uuid: string;
  attempt: number;
  version: number;
  data: string; // JSON
  validated: number; // 0 | 1
  created_at: number;
}

export function createIssueResultOps(db: Database) {
  const upsertStmt = db.prepare(`
    INSERT INTO issue_results (issue_uuid, attempt, version, data, validated, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(issue_uuid, attempt, version) DO UPDATE SET
      data = excluded.data,
      validated = excluded.validated,
      created_at = excluded.created_at
  `);

  const getLatestStmt = db.prepare(`
    SELECT * FROM issue_results
    WHERE issue_uuid = ? AND attempt = ?
    ORDER BY version DESC
    LIMIT 1
  `);

  const getNextVersionStmt = db.prepare(`
    SELECT COALESCE(MAX(version), -1) + 1 AS next_version
    FROM issue_results
    WHERE issue_uuid = ? AND attempt = ?
  `);

  const listByIssueStmt = db.prepare(`
    SELECT * FROM issue_results WHERE issue_uuid = ? ORDER BY attempt DESC, version DESC
  `);

  function upsertIssueResult(
    issueUuid: string,
    attempt: number,
    data: unknown,
    validated: boolean,
    version?: number,
  ): number {
    let v = version;
    if (v === undefined) {
      const row = getNextVersionStmt.get(issueUuid, attempt) as { next_version: number } | null;
      v = row?.next_version ?? 0;
    }
    upsertStmt.run(issueUuid, attempt, v, JSON.stringify(data), validated ? 1 : 0, Date.now());
    return v;
  }

  const getLatestAnyAttemptStmt = db.prepare(`
    SELECT * FROM issue_results WHERE issue_uuid = ? ORDER BY attempt DESC, version DESC LIMIT 1
  `);

  function getLatestIssueResult(issueUuid: string, attempt?: number): IssueResult | null {
    if (attempt === undefined) {
      return (getLatestAnyAttemptStmt.get(issueUuid) as IssueResult | null) ?? null;
    }
    return (getLatestStmt.get(issueUuid, attempt) as IssueResult | null) ?? null;
  }

  function listIssueResults(issueUuid: string): IssueResult[] {
    return listByIssueStmt.all(issueUuid) as IssueResult[];
  }

  return {
    upsertIssueResult,
    getLatestIssueResult,
    listIssueResults,
  };
}
