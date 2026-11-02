import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import pino from "pino";
import { createTracker } from "../../src/db/tracker.ts";
import { runMigrations } from "../../src/db/migrations.ts";
import { syncParentPlanRunProgress } from "../../src/orchestrator/plan-progress.ts";

const logger = pino({ level: "silent" });

describe("parent plan-run progress aggregation", () => {
  let db: Database;
  let tracker: ReturnType<typeof createTracker>;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    tracker = createTracker(db);
  });

  it("updates parent progress from sub-issue states and completes parent when plan run done", () => {
    const parent = tracker.insertIssue({ uuid: nanoid(), title: "parent", state: "in_progress" });
    tracker.insertPlanRun({
      id: "RUN-1",
      caller_issue_uuid: parent.uuid,
      script: "",
      meta: { name: "test", max_issues: 10 },
      wall_time_ms: 60_000,
    });

    const sub1 = tracker.insertIssue({ uuid: nanoid(), title: "s1", state: "done", plan_run_id: "RUN-1" });
    const sub2 = tracker.insertIssue({ uuid: nanoid(), title: "s2", state: "in_progress", plan_run_id: "RUN-1" });

    syncParentPlanRunProgress(tracker, logger);

    const updatedParent = tracker.getIssue(parent.uuid);
    const progress = JSON.parse(updatedParent!.plan_progress_json ?? "{}") as Record<string, number>;
    expect(progress.total).toBe(2);
    expect(progress.done).toBe(1);
    expect(progress.in_progress).toBe(1);
    expect(progress.percent).toBe(50);
    expect(updatedParent!.state).toBe("in_progress");

    tracker.updateIssueState(sub2.uuid, "done");
    tracker.updatePlanRunState("RUN-1", "done");

    syncParentPlanRunProgress(tracker, logger);

    const finalParent = tracker.getIssue(parent.uuid);
    expect(finalParent!.state).toBe("done");
    const finalProgress = JSON.parse(finalParent!.plan_progress_json ?? "{}") as Record<string, number>;
    expect(finalProgress.percent).toBe(100);
  });

  it("cancels parent when plan run fails and all sub-issues are terminal", () => {
    const parent = tracker.insertIssue({ uuid: nanoid(), title: "parent", state: "in_progress" });
    tracker.insertPlanRun({
      id: "RUN-2",
      caller_issue_uuid: parent.uuid,
      script: "",
      meta: { name: "test", max_issues: 10 },
      wall_time_ms: 60_000,
    });
    tracker.insertIssue({ uuid: nanoid(), title: "s1", state: "cancelled", plan_run_id: "RUN-2" });

    tracker.updatePlanRunState("RUN-2", "failed");
    syncParentPlanRunProgress(tracker, logger);

    expect(tracker.getIssue(parent.uuid)!.state).toBe("cancelled");
  });
});
