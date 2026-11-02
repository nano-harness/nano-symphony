import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { runPlan } from "../../src/plan-runtime/runner.ts";
import { dryRun } from "../../src/plan-runtime/dry-run.ts";

function makeTracker() {
  const db = new Database(":memory:");
  runMigrations(db);
  return createTracker(db);
}

/** Background helper: auto-completes sub-issues created by a plan run so that
 *  runPlan's polling loop sees them in terminal state immediately. */
function autoCompleteSubIssues(tracker: ReturnType<typeof makeTracker>, runId: string) {
  const interval = setInterval(() => {
    for (const issue of tracker.listIssuesByPlanRun(runId)) {
      if (issue.state !== "done" && issue.state !== "cancelled") {
        tracker.updateIssueState(issue.uuid, "done");
        tracker.upsertIssueResult(issue.uuid, 0, `result-${issue.uuid}`, true);
      }
    }
  }, 50);
  return () => clearInterval(interval);
}

describe("plan runtime: artifact SDK globals", () => {
  test("list_artifacts/get_artifact expose artifacts of in-run sub-issues", async () => {
    const tracker = makeTracker();
    tracker.insertPlanRun({ id: "run-1", script: "", meta: { name: "p", max_issues: 5 } });
    tracker.insertIssue({
      uuid: "sub-1",
      title: "sub",
      state: "done",
      plan_run_id: "run-1",
    });
    const art = tracker.insertArtifact({
      issue_uuid: "sub-1",
      attempt: 1,
      source: "mcp",
      kind: "note",
      label: "summary",
      content: "hello",
      metadata: { a: 1 },
    });

    const result = await runPlan({
      runId: "run-1",
      script: `
        const list = list_artifacts(args.issueId);
        const one = get_artifact(args.artifactId);
        return { count: list.length, kind: list[0].kind, label: one.label, meta: one.metadata };
      `,
      args: { issueId: "sub-1", artifactId: art.id },
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ count: 1, kind: "note", label: "summary", meta: { a: 1 } });
  });

  test("list_artifacts rejects issues outside the plan run", async () => {
    const tracker = makeTracker();
    tracker.insertPlanRun({ id: "run-1", script: "", meta: { name: "p", max_issues: 5 } });
    // Sub-issue belongs to a different run
    tracker.insertIssue({
      uuid: "other",
      title: "other",
      state: "done",
      plan_run_id: "run-2",
    });

    const result = await runPlan({
      runId: "run-1",
      script: `return list_artifacts(args.issueId);`,
      args: { issueId: "other" },
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not part of plan run");
  });

  test("get_artifact returns null for unknown artifact id", async () => {
    const tracker = makeTracker();
    tracker.insertPlanRun({ id: "run-1", script: "", meta: { name: "p", max_issues: 5 } });

    const result = await runPlan({
      runId: "run-1",
      script: `return get_artifact("missing");`,
      args: null,
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBeNull();
  });

  test("dry-run injects artifact globals as no-op stubs", async () => {
    const summary = await dryRun({
      script: `
        const a = list_artifacts("anything");
        const b = get_artifact("anything");
        if (a.length !== 0 || b !== null) throw new Error("unexpected");
      `,
      args: null,
      maxIssues: 5,
    });
    expect(summary.ok).toBe(true);
  });
});

describe("plan runtime: dag SDK", () => {
  test("dag dry-run estimates nodes and returns stub results", async () => {
    const summary = await dryRun({
      script: `
        const r = await dag(
          [
            { id: "a", prompt: "task A" },
            { id: "b", prompt: "task B" },
            { id: "c", prompt: "task C" }
          ],
          [
            { from: "a", to: "b" },
            { from: "a", to: "c" }
          ]
        );
        if (r.a !== "<DRY_RUN>" || r.b !== "<DRY_RUN>" || r.c !== "<DRY_RUN>") {
          throw new Error("unexpected dry-run result");
        }
      `,
      args: null,
      maxIssues: 5,
    });
    expect(summary.ok).toBe(true);
    expect(summary.estimated_issues).toBe(3);
  });

  test("dag dry-run detects cycles", async () => {
    const summary = await dryRun({
      script: `
        await dag(
          [{ id: "a", prompt: "A" }, { id: "b", prompt: "B" }],
          [{ from: "a", to: "b" }, { from: "b", to: "a" }]
        );
      `,
      args: null,
      maxIssues: 5,
    });
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("cycle detected");
  });

  test("dag run executes nodes in topological order", async () => {
    const tracker = makeTracker();
    const runId = `run-dag-${nanoid(6)}`;
    tracker.insertPlanRun({ id: runId, script: "", meta: { name: "p", max_issues: 10 } });

    const stopAutoComplete = autoCompleteSubIssues(tracker, runId);

    const result = await runPlan({
      runId,
      script: `
        const r = await dag(
          [
            { id: "root", prompt: "root task" },
            { id: "left", prompt: "left task" },
            { id: "right", prompt: "right task" },
            { id: "merge", prompt: "merge task" }
          ],
          [
            { from: "root", to: "left" },
            { from: "root", to: "right" },
            { from: "left", to: "merge" },
            { from: "right", to: "merge" }
        ]);
        return { order: Object.keys(r), root: r.root, merge: r.merge };
      `,
      args: null,
      maxIssues: 10,
      wallTimeMs: 30_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    stopAutoComplete();
    expect(result.ok).toBe(true);
    const res = result.result as Record<string, unknown>;
    expect(res.order).toEqual(["root", "left", "right", "merge"]);
  }, 15_000);

  test("dag run interpolates {{nodeId}} prompts", async () => {
    const tracker = makeTracker();
    const runId = `run-dag-${nanoid(6)}`;
    tracker.insertPlanRun({ id: runId, script: "", meta: { name: "p", max_issues: 10 } });

    const stopAutoComplete = autoCompleteSubIssues(tracker, runId);

    const result = await runPlan({
      runId,
      script: `
        const r = await dag(
          [
            { id: "first", prompt: "first task" },
            { id: "second", prompt: "Follow-up: {{first}}" }
          ],
          [{ from: "first", to: "second" }]
        );
        return r;
      `,
      args: null,
      maxIssues: 10,
      wallTimeMs: 30_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    stopAutoComplete();
    expect(result.ok).toBe(true);

    // Both sub-issues were created; the "second" one's description should contain
    // the interpolated result from the "first" node.
    const issues = tracker.listIssuesByPlanRun(runId);
    expect(issues.length).toBe(2);
    const second = issues.find(i => i.description?.includes("Follow-up"));
    expect(second).not.toBeUndefined();
    expect(second!.description).toContain("result-");
  });

  test("dag run detects duplicate node ids", async () => {
    const tracker = makeTracker();
    const runId = `run-dag-${nanoid(6)}`;
    tracker.insertPlanRun({ id: runId, script: "", meta: { name: "p", max_issues: 10 } });

    const result = await runPlan({
      runId,
      script: `
        await dag(
          [{ id: "a", prompt: "A" }, { id: "a", prompt: "A2" }],
          []
        );
      `,
      args: null,
      maxIssues: 10,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("duplicate node id");
  });

  test("dag run detects cycles", async () => {
    const tracker = makeTracker();
    const runId = `run-dag-${nanoid(6)}`;
    tracker.insertPlanRun({ id: runId, script: "", meta: { name: "p", max_issues: 10 } });

    const result = await runPlan({
      runId,
      script: `
        await dag(
          [{ id: "a", prompt: "A" }, { id: "b", prompt: "B" }],
          [{ from: "a", to: "b" }, { from: "b", to: "a" }]
        );
      `,
      args: null,
      maxIssues: 10,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cycle detected");
  });

  test("dag run detects unknown predecessor in prompt interpolation", async () => {
    const tracker = makeTracker();
    const runId = `run-dag-${nanoid(6)}`;
    tracker.insertPlanRun({ id: runId, script: "", meta: { name: "p", max_issues: 10 } });

    const stopAutoComplete = autoCompleteSubIssues(tracker, runId);

    const result = await runPlan({
      runId,
      script: `
        await dag(
          [
            { id: "a", prompt: "A" },
            { id: "b", prompt: "Uses {{unknown}}" }
          ],
          [{ from: "a", to: "b" }]
        );
      `,
      args: null,
      maxIssues: 10,
      wallTimeMs: 10_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    stopAutoComplete();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown predecessor");
  });

  test("gated issue waits in plan_review until approved", async () => {
    const tracker = makeTracker();
    const runId = "run-gate";
    tracker.insertPlanRun({ id: runId, script: "", meta: { name: "p", max_issues: 5 } });

    // Approve the gated issue after a short delay, then let auto-complete finish it.
    let approved = false;
    const approveTimer = setInterval(() => {
      for (const issue of tracker.listIssuesByPlanRun(runId)) {
        if (issue.state === "plan_review") {
          tracker.updateIssueState(issue.uuid, "todo");
          approved = true;
        }
      }
      if (approved) clearInterval(approveTimer);
    }, 100);

    const stopAutoComplete = autoCompleteSubIssues(tracker, runId);

    const result = await runPlan({
      runId,
      script: `return await issue("Gated work", { gate: true });`,
      args: null,
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    clearInterval(approveTimer);
    stopAutoComplete();
    expect(result.ok).toBe(true);
  });

  test("reviewer node auto-blocks downstream successor", async () => {
    const tracker = makeTracker();
    const runId = `run-reviewer-blocker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tracker.insertPlanRun({ id: runId, script: "", meta: { name: "p", max_issues: 5 } });

    // Approve the reviewer quickly so the successor can eventually run.
    let approved = false;
    const approveTimer = setInterval(() => {
      for (const issue of tracker.listIssuesByPlanRun(runId)) {
        if (issue.state === "plan_review") {
          tracker.updateIssueState(issue.uuid, "todo");
          approved = true;
        }
      }
      if (approved) clearInterval(approveTimer);
    }, 100);

    const stopAutoComplete = autoCompleteSubIssues(tracker, runId);

    const result = await runPlan({
      runId,
      script: `
        return await dag(
          [{ id: "review", prompt: "Review the design", role: "reviewer", gate: true }, { id: "implement", prompt: "Implement {{review}}" }],
          [{ from: "review", to: "implement" }]
        );
      `,
      args: null,
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });

    clearInterval(approveTimer);
    stopAutoComplete();
    expect(result.ok, `plan run failed: ${(result as any).error}`).toBe(true);

    const issues = tracker.listIssuesByPlanRun(runId);
    const implementIssue = issues.find((i) => i.title.includes("Implement"));
    expect(implementIssue).toBeDefined();
    if (implementIssue) {
      expect(implementIssue.blockers.length).toBeGreaterThanOrEqual(1);
      const reviewIssue = issues.find((i) => i.title.includes("Review"));
      expect(implementIssue.blockers.some((b) => b.blocker_uuid === reviewIssue?.uuid)).toBe(true);
    }
  });

  test("stable resume identity: second run skips already-completed issue", async () => {
    const tracker = makeTracker();
    const runId = `run-resume-id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tracker.insertPlanRun({ id: runId, script: "", meta: { name: "p", max_issues: 5 } });

    // Clear any leftover journal from a previous test run.
    try {
      const journalPath = `.symphony/plan-runs/${runId}/journal.jsonl`;
      await import("node:fs").then((fs) => fs.rmSync(journalPath, { recursive: true, force: true }));
    } catch { /* ignore */ }

    const stopAutoComplete = autoCompleteSubIssues(tracker, runId);

    // First run: creates and completes one sub-issue.
    const result1 = await runPlan({
      runId,
      script: `return await issue("Do work", { key: "my-task" });`,
      args: null,
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });
    stopAutoComplete();
    expect(result1.ok).toBe(true);

    const issuesAfterFirst = tracker.listIssuesByPlanRun(runId).length;
    expect(issuesAfterFirst).toBeGreaterThanOrEqual(1);

    // Second run: same plan key, but prompt can differ. Should resume, not create new issue.
    const stopAutoComplete2 = autoCompleteSubIssues(tracker, runId);
    const result2 = await runPlan({
      runId,
      script: `return await issue("Do work with a different prompt wording", { key: "my-task" });`,
      args: null,
      maxIssues: 5,
      wallTimeMs: 5_000,
      tracker,
      tokenSpent: () => 0,
      tokenTotal: 0,
    });
    stopAutoComplete2();
    expect(result2.ok).toBe(true);
    expect(tracker.listIssuesByPlanRun(runId).length).toBe(issuesAfterFirst);
  });
});
