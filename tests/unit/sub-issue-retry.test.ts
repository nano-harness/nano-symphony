/**
 * W1: Sub-issue retry logic.
 * When a sub-issue is transiently cancelled (plan run not cancelled),
 * the runner should retry up to maxRetries times before giving up.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { runPlan } from "../../src/plan-runtime/runner.ts";
import { rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

function makeTracker() {
  const db = new Database(":memory:");
  runMigrations(db);
  return createTracker(db);
}

function makeRunId() {
  return `test-retry-${randomUUID()}`;
}

afterEach(() => {
  // Remove journal files created during tests to prevent cross-test contamination
  const dir = ".symphony/plan-runs";
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
})

/**
 * Simulate a sub-issue being resolved after `cancelCount` transient cancels.
 * Returns a promise that resolves when done.
 */
function autoResolveSubIssues(
  tracker: ReturnType<typeof createTracker>,
  cancelCount: number,
  resolveWith: unknown = { status: "success" },
  intervalMs = 10,
): () => void {
  let seenIssues = new Set<string>();
  let cancelsSoFar = 0;
  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    const pending = tracker.listIssues({ state: "todo" });
    for (const issue of pending) {
      if (seenIssues.has(issue.uuid)) continue;
      seenIssues.add(issue.uuid);

      if (cancelsSoFar < cancelCount) {
        // Cancel the issue (transient)
        cancelsSoFar++;
        tracker.updateIssueState(issue.uuid, "cancelled");
      } else {
        // Resolve the issue as done with a result
        tracker.upsertIssueResult(issue.uuid, 0, resolveWith, true);
        tracker.updateIssueState(issue.uuid, "done");
      }
    }
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

describe("plan-run sub-issue retry (W1)", () => {
  test("resolves on first try (0 cancels) when maxRetries=0", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 5 } });

    const stop = autoResolveSubIssues(tracker, 0, { echo: "pong" });
    try {
      const result = await runPlan({
        runId,
        script: `return await issue("ping?")`,
        args: {},
        maxIssues: 5,
        wallTimeMs: 5_000,
        tracker,
        tokenSpent: () => 0,
        tokenTotal: 0,
        maxRetries: 0,
      });
      expect(result.ok).toBe(true);
      expect(result.subIssuesDone).toBe(1);
      expect(result.subIssuesFailed).toBe(0);
    } finally {
      stop();
    }
  });

  test("retries once on transient cancel and succeeds on second attempt", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 5 } });

    const stop = autoResolveSubIssues(tracker, 1, { echo: "pong" });
    try {
      const result = await runPlan({
        runId,
        script: `return await issue("do work")`,
        args: {},
        maxIssues: 5,
        wallTimeMs: 10_000,
        tracker,
        tokenSpent: () => 0,
        tokenTotal: 0,
        maxRetries: 2,
      });
      expect(result.ok).toBe(true);
      expect(result.subIssuesDone).toBe(1);
    } finally {
      stop();
    }
  });

  test("retries up to maxRetries and fails when all attempts are cancelled", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 10 } });

    // Always cancel — plan run itself is not cancelled
    const stop = autoResolveSubIssues(tracker, 999);
    try {
      const result = await runPlan({
        runId,
        script: `return await issue("always fails")`,
        args: {},
        maxIssues: 10,
        wallTimeMs: 30_000,
        tracker,
        tokenSpent: () => 0,
        tokenTotal: 0,
        maxRetries: 1, // 1 original + 1 retry = 2 polls × 2s = ~4s
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("cancelled");
    } finally {
      stop();
    }
  }, 15_000 /* bun test timeout: allow up to 15s for 2 poll rounds */);

  test("cancelled_by_user when plan run itself is cancelled", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 5 } });

    let stopped = false;
    const interval = setInterval(() => {
      if (stopped) return;
      const pending = tracker.listIssues({ state: "todo" });
      for (const issue of pending) {
        // Cancel the sub-issue AND the plan run
        tracker.updateIssueState(issue.uuid, "cancelled");
        tracker.finishPlanRun(runId, "cancelled", "operator-cancelled");
      }
    }, 10);

    try {
      const result = await runPlan({
        runId,
        script: `return await issue("do work")`,
        args: {},
        maxIssues: 5,
        wallTimeMs: 10_000,
        tracker,
        tokenSpent: () => 0,
        tokenTotal: 0,
        maxRetries: 3,
      });
      expect(result.ok).toBe(false);
      expect(result.terminationReason).toBe("cancelled_by_user");
      expect(result.error).toContain("cancelled_by_user");
    } finally {
      stopped = true;
      clearInterval(interval);
    }
  });

  test("subIssuesFailed increments for each final cancellation", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 10 } });

    // Cancel always (no retries)
    const stop = autoResolveSubIssues(tracker, 999);
    try {
      const result = await runPlan({
        runId,
        script: `return await issue("work")`,
        args: {},
        maxIssues: 10,
        wallTimeMs: 5_000,
        tracker,
        tokenSpent: () => 0,
        tokenTotal: 0,
        maxRetries: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.subIssuesFailed).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });
});
