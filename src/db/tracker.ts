import { Database } from "bun:sqlite";
import { createIssueOps } from "./tracker-issues.ts";
import { createRunOps } from "./tracker-runs.ts";
import { createEventOps } from "./tracker-events.ts";
import { createCommentOps } from "./tracker-comments.ts";
import { createArtifactOps } from "./tracker-artifacts.ts";

// Re-export all types for backward compatibility
export type { Issue, IssueInput, SymphonyRun, SymphonyEvent, Comment } from "./tracker-types.ts";
export type { Artifact, ArtifactInput } from "./tracker-artifacts.ts";

export function createTracker(db: Database) {
  const issues = createIssueOps(db);
  const runs = createRunOps(db);
  const events = createEventOps(db);
  const comments = createCommentOps(db);
  const artifacts = createArtifactOps(db);

  /**
   * Wraps a synchronous function in a SQLite transaction.
   * If the function throws, all DB writes within it are rolled back.
   * Note: bun:sqlite transactions cannot span async boundaries — fn must be synchronous.
   */
  function withTransaction<T>(fn: () => T): T {
    const txn = db.transaction(fn);
    return txn();
  }

  return {
    ...issues,
    ...runs,
    ...events,
    ...comments,
    ...artifacts,
    withTransaction,
  };
}

export type Tracker = ReturnType<typeof createTracker>;
