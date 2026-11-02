import { describe, test, expect } from "bun:test";
import { renderPrompt } from "../../src/prompt/renderer.ts";
describe("renderPrompt", () => {
  test("renders simple variables", async () => { const r = await renderPrompt("Hello {{ name }}!", { name: "World" }); expect(r.text).toBe("Hello World!"); });
  test("renders nested object properties", async () => { const r = await renderPrompt("Issue: {{ issue.title }}", { issue: { title: "Fix the bug" } }); expect(r.text).toBe("Issue: Fix the bug"); });
  test("renders attempt number", async () => { const r = await renderPrompt("Attempt: {{ attempt }}", { attempt: 2 }); expect(r.text).toBe("Attempt: 2"); });
  test("prefixes goal command when requested", async () => {
    const r = await renderPrompt("Do work", {}, { goal: { condition: "tests pass", inject_mode: "prefix" } }); expect(r.text).toBe("/goal tests pass\n\nDo work");
  });
  test("does not prefix goal command when inject mode is none", async () => {
    const r = await renderPrompt("Do work", {}, { goal: { condition: "tests pass", inject_mode: "none" } }); expect(r.text).toBe("Do work");
  });
  test("throws on undefined variable in strict mode", async () => { await expect(renderPrompt("{{ undefined_var }}", {})).rejects.toThrow(); });
  test("returns empty commentIds meta by default", async () => {
    const r = await renderPrompt("Hello", { });
    expect(r.meta.commentIds).toEqual([]);
    expect(r.meta.truncated).toBe(false);
  });
  test("injects structured plan revision feedback into planning prompt", async () => {
    const tracker = {
      getLatestEventByKind: (issueUuid: string, kind: string) => {
        if (kind === "plan_revision_requested") {
          return {
            id: "rev1",
            issue_uuid: issueUuid,
            ts: 2000,
            kind: "plan_revision_requested",
            message: "Revise",
            payload_json: JSON.stringify({
              note: "Add more tests",
              feedback: { category: "missing_tests", severity: "blocking", must_fix: ["Cover edge cases", "Add integration test"] },
            }),
          };
        }
        if (kind === "started") return { ts: 1000 } as unknown as ReturnType<typeof tracker.getLatestEventByKind>;
        return null;
      },
      listComments: () => [],
      getIssue: () => ({ state: "planning" }),
    } as unknown as NonNullable<Parameters<typeof renderPrompt>[2]>["tracker"] & { listComments: () => [] };
    const r = await renderPrompt("Plan", {}, { tracker, issueUuid: "issue-1" });
    expect(r.text).toContain("Reviewer requested changes:");
    expect(r.text).toContain("Category: missing_tests");
    expect(r.text).toContain("Severity: blocking");
    expect(r.text).toContain("Must fix:");
    expect(r.text).toContain("Cover edge cases");
    expect(r.text).toContain("Add integration test");
    expect(r.text).toContain("Add more tests");
  });
});
