import { describe, test, expect } from "bun:test";
import { diffMarkdown, diffSteps, diffEstimates, computePlanDiff } from "../../src/http/plan-diff.ts";

describe("plan diff", () => {
  test("diffMarkdown detects added and removed lines", () => {
    const oldText = "line 1\nline 2\nline 3";
    const newText = "line 1\nline 2 modified\nline 3";
    const diff = diffMarkdown(oldText, newText);
    expect(diff.hunks.length).toBeGreaterThan(0);
    const allLines = diff.hunks.flatMap((h) => h.lines);
    expect(allLines.some((l) => l.kind === "removed" && l.text === "line 2")).toBe(true);
    expect(allLines.some((l) => l.kind === "added" && l.text === "line 2 modified")).toBe(true);
    expect(allLines.some((l) => l.kind === "context" && l.text === "line 1")).toBe(true);
  });

  test("diffSteps detects added, removed, and changed steps", () => {
    const oldSteps = [{ id: "a", title: "A", description: "desc a" }];
    const newSteps = [
      { id: "a", title: "A updated", description: "desc a" },
      { id: "b", title: "B" },
    ];
    const diff = diffSteps(oldSteps, newSteps);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].id).toBe("b");
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changedFields).toContain("title");
  });

  test("diffEstimates detects added, removed, and changed fields", () => {
    const oldEst = { files_touched: 3, complexity: "low" as const };
    const newEst = { files_touched: 5, complexity: "low" as const, estimated_turns: 4 };
    const diff = diffEstimates(oldEst, newEst);
    expect(diff.changed.files_touched).toEqual({ from: 3, to: 5 });
    expect(diff.added.estimated_turns).toBe(4);
    expect(diff.removed).toEqual({});
  });

  test("computePlanDiff returns full diff structure", () => {
    const fromPayload = {
      revision: 1,
      markdown: "# Plan\n\nStep one",
      steps: [{ id: "s1", title: "Step 1" }],
      estimates: { files_touched: 2 },
    };
    const toPayload = {
      revision: 2,
      markdown: "# Plan\n\nStep one updated",
      steps: [
        { id: "s1", title: "Step 1" },
        { id: "s2", title: "Step 2" },
      ],
      estimates: { files_touched: 3 },
    };
    const diff = computePlanDiff(fromPayload, toPayload);
    expect(diff.from_revision).toBe(1);
    expect(diff.to_revision).toBe(2);
    expect(diff.steps.added).toHaveLength(1);
    expect(diff.estimates.changed.files_touched).toEqual({ from: 2, to: 3 });
  });
});
