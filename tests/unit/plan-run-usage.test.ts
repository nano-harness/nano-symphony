import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker, type Tracker } from "../../src/db/tracker.ts";

function makeTracker(): Tracker {
  const db = new Database(":memory:");
  runMigrations(db);
  return createTracker(db);
}

describe("getPlanRunUsage", () => {
  let tracker: Tracker;
  beforeEach(() => {
    tracker = makeTracker();
  });

  function seedRun(runId = "RUN-1") {
    tracker.insertPlanRun({ id: runId, script: "plan {}", meta: { name: "test", max_issues: 5 } });
    return runId;
  }

  it("returns an empty list when the run has no sub-issues", () => {
    const runId = seedRun();
    expect(tracker.getPlanRunUsage(runId)).toEqual([]);
  });

  it("aggregates tokens and cost across sub-issues", () => {
    const runId = seedRun();
    const a = tracker.insertIssue({ uuid: "uuid-a", title: "A", state: "done", plan_run_id: runId });
    const b = tracker.insertIssue({ uuid: "uuid-b", title: "B", state: "in_progress", plan_run_id: runId });
    tracker.recordLlmCall({ issue_uuid: a.uuid, attempt: 0, input_tokens: 100, output_tokens: 50, cost_usd: 0.01, provider: "test", model: "test", duration_ms: 1000, duration_api_ms: 800 });
    tracker.recordLlmCall({ issue_uuid: a.uuid, attempt: 1, input_tokens: 200, output_tokens: 80, cost_usd: 0.02, provider: "test", model: "test", duration_ms: 1000, duration_api_ms: 800 });
    tracker.recordLlmCall({ issue_uuid: b.uuid, attempt: 0, input_tokens: 300, output_tokens: 120, cost_usd: null, provider: "test", model: "test", duration_ms: 1000, duration_api_ms: 800 });

    const usage = tracker.getPlanRunUsage(runId);
    expect(usage.length).toBe(2);
    const rowA = usage.find((r) => r.issue_uuid === "uuid-a")!;
    expect(rowA.attempts).toBe(2);
    expect(rowA.input_tokens).toBe(300);
    expect(rowA.output_tokens).toBe(130);
    expect(rowA.cost_usd).toBeCloseTo(0.03);
    const rowB = usage.find((r) => r.issue_uuid === "uuid-b")!;
    expect(rowB.attempts).toBe(1);
    expect(rowB.cost_usd).toBe(0);
  });

  it("excludes issues belonging to other plan runs", () => {
    const runId = seedRun();
    seedRun("RUN-2");
    tracker.insertIssue({ uuid: "uuid-a", title: "A", state: "done", plan_run_id: runId });
    tracker.insertIssue({ uuid: "uuid-b", title: "B", state: "done", plan_run_id: "RUN-2" });
    tracker.insertIssue({ uuid: "uuid-c", title: "C", state: "todo" });

    const usage = tracker.getPlanRunUsage(runId);
    expect(usage.map((r) => r.issue_uuid)).toEqual(["uuid-a"]);
  });

  it("counts zero attempts for issues without llm_calls rows", () => {
    const runId = seedRun();
    tracker.insertIssue({ uuid: "uuid-a", title: "A", state: "todo", plan_run_id: runId });
    const usage = tracker.getPlanRunUsage(runId);
    expect(usage[0].attempts).toBe(0);
    expect(usage[0].input_tokens).toBe(0);
  });
});
