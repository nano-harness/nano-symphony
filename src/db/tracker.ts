import { Database } from "bun:sqlite";
import { createIssueOps } from "./tracker-issues.ts";
import { createRunOps } from "./tracker-runs.ts";
import { createEventOps } from "./tracker-events.ts";
import { createCommentOps } from "./tracker-comments.ts";
import { createArtifactOps } from "./tracker-artifacts.ts";
import { createPlanRunOps } from "./tracker-plan-runs.ts";
import { createIssueResultOps } from "./tracker-issue-results.ts";
import { createLlmCallOps } from "./tracker-llm-calls.ts";
import { createIssueMetricsOps } from "./tracker-issue-metrics.ts";

// Re-export all types for backward compatibility
export type { Issue, IssueInput, SymphonyRun, SymphonyEvent, Comment } from "./tracker-types.ts";
export type { LlmCall } from "./tracker-llm-calls.ts";
export type { IssueMetrics } from "./tracker-issue-metrics.ts";
export type { Artifact, ArtifactInput } from "./tracker-artifacts.ts";
export type { PlanRun, PlanRunState, PlanRunApprovalStatus } from "./tracker-plan-runs.ts";
export type { IssueResult } from "./tracker-issue-results.ts";

export function createTracker(db: Database) {
  const issues = createIssueOps(db);
  const runs = createRunOps(db);
  const events = createEventOps(db);
  const comments = createCommentOps(db);
  const artifacts = createArtifactOps(db);
  const planRuns = createPlanRunOps(db);
  const issueResults = createIssueResultOps(db);
  const llmCalls = createLlmCallOps(db);
  const issueMetrics = createIssueMetricsOps(db);

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
    ...planRuns,
    ...issueResults,
    ...llmCalls,
    ...issueMetrics,
    withTransaction,
  };
}

export type Tracker = ReturnType<typeof createTracker>;
