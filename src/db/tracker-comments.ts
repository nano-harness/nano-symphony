import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import type { Comment } from "./tracker-types.ts";

export function createCommentOps(db: Database) {
  const insertCommentStmt = db.prepare(`
    INSERT INTO issue_comments (id, issue_id, ts, author, body, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const listCommentsStmt = db.prepare(`
    SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY ts ASC
  `);

  const listCommentsSinceStmt = db.prepare(`
    SELECT * FROM issue_comments WHERE issue_id = ? AND ts > ? ORDER BY ts ASC
  `);

  const listCommentsLimitStmt = db.prepare(`
    SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY ts ASC LIMIT ?
  `);

  const listCommentsSinceLimitStmt = db.prepare(`
    SELECT * FROM issue_comments WHERE issue_id = ? AND ts > ? ORDER BY ts ASC LIMIT ?
  `);

  const getCommentStmt = db.prepare(`
    SELECT * FROM issue_comments WHERE id = ?
  `);

  const deleteCommentStmt = db.prepare(`
    DELETE FROM issue_comments WHERE id = ?
  `);

  const countCommentsStmt = db.prepare(`
    SELECT COUNT(*) as count FROM issue_comments WHERE issue_id = ?
  `);

  function addComment(issueId: string, input: { body: string; author?: string; metadata?: unknown }): Comment {
    const id = nanoid();
    const ts = Date.now();
    const author = input.author || "operator";
    const metadataJson = input.metadata !== undefined ? JSON.stringify(input.metadata) : null;
    insertCommentStmt.run(id, issueId, ts, author, input.body, metadataJson);
    const comment: Comment = { id, issue_id: issueId, ts, author, body: input.body, metadata: input.metadata ?? null };
    return comment;
  }

  function listComments(issueId: string, opts?: { since?: number; limit?: number }): Comment[] {
    let rows: Array<{ id: string; issue_id: string; ts: number; author: string; body: string; metadata_json: string | null }>;
    if (opts?.since && opts?.limit) {
      rows = listCommentsSinceLimitStmt.all(issueId, opts.since, opts.limit) as typeof rows;
    } else if (opts?.since) {
      rows = listCommentsSinceStmt.all(issueId, opts.since) as typeof rows;
    } else if (opts?.limit) {
      rows = listCommentsLimitStmt.all(issueId, opts.limit) as typeof rows;
    } else {
      rows = listCommentsStmt.all(issueId) as typeof rows;
    }
    return rows.map((r) => ({
      id: r.id,
      issue_id: r.issue_id,
      ts: r.ts,
      author: r.author,
      body: r.body,
      metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
    }));
  }

  function getComment(commentId: string): Comment | null {
    const row = getCommentStmt.get(commentId) as { id: string; issue_id: string; ts: number; author: string; body: string; metadata_json: string | null } | null;
    if (!row) return null;
    return { id: row.id, issue_id: row.issue_id, ts: row.ts, author: row.author, body: row.body, metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null };
  }

  function deleteComment(commentId: string): boolean {
    const result = deleteCommentStmt.run(commentId);
    return result.changes > 0;
  }

  function countComments(issueId: string): number {
    const row = countCommentsStmt.get(issueId) as { count: number };
    return row.count;
  }

  return {
    addComment,
    listComments,
    getComment,
    deleteComment,
    countComments,
  };
}
