import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import type { Tracker } from "../../src/db/tracker.ts";

function makeDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

// Simulate the plan guard logic from worker.ts
function applyPlanGuard(
  issue: { require_plan: boolean | null; state: string; uuid: string },
  semantics: string,
  tracker: Tracker,
  attempt: number
): { semantics: string; summary?: string; blockerFingerprint?: string; targetState: string | null; eventRecorded: boolean } {
  let resultSemantics = semantics;
  let resultSummary: string | undefined;
  let resultFingerprint: string | undefined;
  let resultTargetState: string | null = null;
  let eventRecorded = false;

  if (issue.require_plan === true) {
    const planSpawned = tracker.getLatestEventByKind(issue.uuid, "plan_run_spawned");
    if (!planSpawned && semantics === "success") {
      resultSemantics = "needs_retry";
      resultSummary = "Issue requires a plan but agent did not spawn one — retrying";
      resultFingerprint = "plan_required_no_plan_run_spawned";
      resultTargetState = null; // Keep in current state for retry
      tracker.recordEvent(issue.uuid, "plan_guard", resultSummary, { attempt });
      eventRecorded = true;
    }
  }

  return {
    semantics: resultSemantics,
    summary: resultSummary,
    blockerFingerprint: resultFingerprint,
    targetState: resultTargetState,
    eventRecorded,
  };
}

describe("plan guard", () => {
  let db: Database;
  let tracker: Tracker;

  beforeEach(() => {
    db = makeDb();
    tracker = createTracker(db);
  });

  test("require_plan=true with no plan_run_spawned overrides success to needs_retry", () => {
    tracker.insertIssue({ uuid: "1", title: "Test", state: "in_progress", require_plan: true });
    tracker.claimIssue("1", 0);

    const result = applyPlanGuard(
      { require_plan: true, state: "in_progress", uuid: "1" },
      "success",
      tracker,
      0
    );

    expect(result.semantics).toBe("needs_retry");
    expect(result.summary).toContain("requires a plan");
    expect(result.blockerFingerprint).toBe("plan_required_no_plan_run_spawned");
    expect(result.targetState).toBeNull();
    expect(result.eventRecorded).toBe(true);

    const events = tracker.getEvents();
    const guardEvent = events.find(e => e.kind === "plan_guard");
    expect(guardEvent).toBeDefined();
    expect(guardEvent?.message).toContain("requires a plan");
  });

  test("require_plan=true with plan_run_spawned allows success", () => {
    tracker.insertIssue({ uuid: "1", title: "Test", state: "in_progress", require_plan: true });
    tracker.claimIssue("1", 0);
    tracker.recordEvent("1", "plan_run_spawned", "Plan run dispatched", { attempt: 0 });

    const result = applyPlanGuard(
      { require_plan: true, state: "in_progress", uuid: "1" },
      "success",
      tracker,
      0
    );

    expect(result.semantics).toBe("success");
    expect(result.blockerFingerprint).toBeUndefined();
    expect(result.eventRecorded).toBe(false);

    const events = tracker.getEvents();
    const guardEvent = events.find(e => e.kind === "plan_guard");
    expect(guardEvent).toBeUndefined();
  });

  test("require_plan=false does not trigger guard", () => {
    tracker.insertIssue({ uuid: "1", title: "Test", state: "in_progress", require_plan: false });
    tracker.claimIssue("1", 0);

    const result = applyPlanGuard(
      { require_plan: false, state: "in_progress", uuid: "1" },
      "success",
      tracker,
      0
    );

    expect(result.semantics).toBe("success");
    expect(result.eventRecorded).toBe(false);
  });

  test("require_plan=true with non-success semantics does not trigger guard", () => {
    tracker.insertIssue({ uuid: "1", title: "Test", state: "in_progress", require_plan: true });
    tracker.claimIssue("1", 0);

    const result = applyPlanGuard(
      { require_plan: true, state: "in_progress", uuid: "1" },
      "needs_retry",
      tracker,
      0
    );

    expect(result.semantics).toBe("needs_retry");
    expect(result.eventRecorded).toBe(false);
  });

  test("require_plan=null does not trigger guard", () => {
    tracker.insertIssue({ uuid: "1", title: "Test", state: "in_progress" });
    tracker.claimIssue("1", 0);

    const result = applyPlanGuard(
      { require_plan: null, state: "in_progress", uuid: "1" },
      "success",
      tracker,
      0
    );

    expect(result.semantics).toBe("success");
    expect(result.eventRecorded).toBe(false);
  });
});
