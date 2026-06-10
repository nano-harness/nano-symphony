/**
 * W2: Failure event payload tests.
 * When a plan run fails, executePlan emits a plan_run_failed event with
 * phase, last_log, error_message, and sub-issue counters.
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
  return `test-fail-${randomUUID()}`;
}

afterEach(() => {
  const dir = ".symphony/plan-runs";
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
})

describe("plan-run failure context (W2)", () => {
  test("lastPhase is null when no phase() was called", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 5 } });

    const result = await runPlan({
      runId,
      script: `throw new Error("boom")`,
      args: {},
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.lastPhase).toBeNull();
    expect(result.error).toContain("boom");
  });

  test("lastPhase reflects final phase() call before failure", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 5 } });

    const result = await runPlan({
      runId,
      script: `
        phase("setup");
        log("starting");
        phase("execution");
        log("executing");
        throw new Error("execution-failed");
      `,
      args: {},
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.lastPhase).toBe("execution");
    expect(result.error).toContain("execution-failed");
  });

  test("lastLog reflects last log() call before failure", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 5 } });

    const result = await runPlan({
      runId,
      script: `
        phase("A");
        log("first log");
        phase("B");
        log("second log");
        throw new Error("boom");
      `,
      args: {},
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.lastLog).toBe("second log");
    expect(result.lastLogAt).not.toBeNull();
    expect(result.lastLogAt).toBeGreaterThan(0);
  });

  test("lastLog is null when no log() was called", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 5 } });

    const result = await runPlan({
      runId,
      script: `throw new Error("no-logs")`,
      args: {},
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.lastLog).toBeNull();
    expect(result.lastLogAt).toBeNull();
  });

  test("vmContext fields are populated on success too", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 5 } });

    const result = await runPlan({
      runId,
      script: `
        phase("done");
        log("finished");
        return { ok: true };
      `,
      args: {},
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.lastPhase).toBe("done");
    expect(result.lastLog).toBe("finished");
    expect(result.subIssuesStarted).toBe(0);
    expect(result.subIssuesDone).toBe(0);
    expect(result.subIssuesFailed).toBe(0);
  });

  test("subIssuesStarted/Done/Failed are 0 for script with no issue() calls", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 5 } });

    const result = await runPlan({
      runId,
      script: `return 42`,
      args: {},
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.subIssuesStarted).toBe(0);
    expect(result.subIssuesDone).toBe(0);
    expect(result.subIssuesFailed).toBe(0);
  });

  test("terminationReason is undefined for non-cancel errors", async () => {
    const tracker = makeTracker();
    const runId = makeRunId();
    tracker.insertPlanRun({ id: runId, script: "", meta: { max_issues: 5 } });

    const result = await runPlan({
      runId,
      script: `throw new Error("vm_error_example")`,
      args: {},
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("vm_error_example");
    // Non-cancel errors do not set terminationReason
    expect(result.terminationReason).toBeUndefined();
  });
});
