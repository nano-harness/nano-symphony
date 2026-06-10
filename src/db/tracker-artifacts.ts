import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { unlinkSync } from "node:fs";

export interface Artifact {
  id: string;
  issue_uuid: string;
  attempt: number;
  source: "git_diff" | "mcp";
  kind: string;
  label: string | null;
  path: string | null;
  content: string | null;
  metadata_json: string | null;
  storage_path: string | null;
  content_size: number;
  mime_type: string;
  ts: number;
}

export interface ArtifactInput {
  issue_uuid: string;
  attempt: number;
  source: "git_diff" | "mcp";
  kind: string;
  label?: string;
  path?: string;
  content?: string;
  metadata?: unknown;
  storage_path?: string;
  content_size?: number;
  mime_type?: string;
}

export function createArtifactOps(db: Database) {
  const insertStmt = db.prepare(`
    INSERT INTO symphony_artifacts (id, issue_uuid, attempt, source, kind, label, path, content, metadata_json, storage_path, content_size, mime_type, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const listByIssueStmt = db.prepare(`
    SELECT * FROM symphony_artifacts WHERE issue_uuid = ? ORDER BY attempt ASC, ts ASC
  `);

  const listByIssueAttemptStmt = db.prepare(`
    SELECT * FROM symphony_artifacts WHERE issue_uuid = ? AND attempt = ? ORDER BY ts ASC
  `);

  const getByIdStmt = db.prepare(`
    SELECT * FROM symphony_artifacts WHERE id = ?
  `);

  const deleteByIssueStmt = db.prepare(`
    DELETE FROM symphony_artifacts WHERE issue_uuid = ?
  `);

  const listRecentStmt = db.prepare(`
    SELECT * FROM symphony_artifacts ORDER BY ts DESC LIMIT ?
  `);

  const existsByPathStmt = db.prepare(`
    SELECT 1 FROM symphony_artifacts
    WHERE issue_uuid = ? AND attempt = ? AND path = ?
    LIMIT 1
  `);

  function insertArtifact(input: ArtifactInput): Artifact {
    const id = nanoid();
    const ts = Date.now();
    const metadataJson = input.metadata !== undefined ? JSON.stringify(input.metadata) : null;
    const contentSize = input.content_size ?? (input.content ? Buffer.byteLength(input.content, "utf-8") : 0);

    insertStmt.run(
      id,
      input.issue_uuid,
      input.attempt,
      input.source,
      input.kind,
      input.label ?? null,
      input.path ?? null,
      input.content ?? null,
      metadataJson,
      input.storage_path ?? null,
      contentSize,
      input.mime_type ?? "application/octet-stream",
      ts,
    );

    return {
      id,
      issue_uuid: input.issue_uuid,
      attempt: input.attempt,
      source: input.source,
      kind: input.kind,
      label: input.label ?? null,
      path: input.path ?? null,
      content: input.content ?? null,
      metadata_json: metadataJson,
      storage_path: input.storage_path ?? null,
      content_size: contentSize,
      mime_type: input.mime_type ?? "application/octet-stream",
      ts,
    };
  }

  function listArtifacts(issueUuid: string, attempt?: number): Artifact[] {
    if (attempt !== undefined) {
      return listByIssueAttemptStmt.all(issueUuid, attempt) as Artifact[];
    }
    return listByIssueStmt.all(issueUuid) as Artifact[];
  }

  function getArtifact(id: string): Artifact | null {
    return (getByIdStmt.get(id) as Artifact) ?? null;
  }

  function deleteArtifactsByIssue(issueUuid: string): void {
    // Remove artifact files from disk before deleting DB records
    const artifacts = listByIssueStmt.all(issueUuid) as Artifact[];
    for (const artifact of artifacts) {
      if (artifact.storage_path) {
        try { unlinkSync(artifact.storage_path); } catch { /* file may already be gone */ }
      }
    }
    deleteByIssueStmt.run(issueUuid);
  }

  function listRecentArtifacts(limit: number): Artifact[] {
    return listRecentStmt.all(limit) as Artifact[];
  }

  function artifactExistsByPath(issueUuid: string, attempt: number, filePath: string): boolean {
    return !!existsByPathStmt.get(issueUuid, attempt, filePath);
  }

  return {
    insertArtifact,
    listArtifacts,
    getArtifact,
    deleteArtifactsByIssue,
    listRecentArtifacts,
    artifactExistsByPath,
  };
}
