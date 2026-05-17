import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { handleTool } from "../../src/mcp/tools.ts";
function makeTracker() { const db = new Database(":memory:"); runMigrations(db); return createTracker(db); }
describe("MCP tools", () => {
  let tracker: ReturnType<typeof createTracker>;
  beforeEach(() => { tracker = makeTracker(); tracker.insertIssue({ id: "issue-1", identifier: "TASK-1", title: "Test Issue", description: "Test description", state: "in_progress", priority: "medium" }); });
  test("symphony.fetch_issue returns issue", async () => { const r = await handleTool("symphony.fetch_issue", {}, "issue-1", 0, tracker) as { issue: { id: string }; attempt: number }; expect(r.issue.id).toBe("issue-1"); expect(r.attempt).toBe(0); });
  test("symphony.fetch_issue throws for missing issue", async () => { await expect(handleTool("symphony.fetch_issue", {}, "nonexistent", 0, tracker)).rejects.toThrow(); });
  test("symphony.report_event records event", async () => { const r = await handleTool("symphony.report_event", { kind: "progress", message: "Working on it" }, "issue-1", 0, tracker) as { ok: boolean }; expect(r.ok).toBe(true); expect(tracker.getEvents().length).toBe(1); });
  test("symphony.report_goal_state records goal progress event", async () => {
    const r = await handleTool("symphony.report_goal_state", { turns_evaluated: 2, max_turns: 5, last_reason: "Need tests" }, "issue-1", 0, tracker) as { ok: boolean };
    expect(r.ok).toBe(true);
    const ev = tracker.getEvents().find(e => e.kind === "goal_evaluated");
    expect(ev?.message).toBe("Need tests");
  });
  test("symphony.report_goal_state records achieved event", async () => {
    await handleTool("symphony.report_goal_state", { achieved_at: "now", last_reason: "Done" }, "issue-1", 0, tracker);
    expect(tracker.getEvents().some(e => e.kind === "goal_achieved")).toBe(true);
  });
  test("symphony.request_workflow_section returns full template", async () => { const r = await handleTool("symphony.request_workflow_section", {}, "issue-1", 0, tracker, { template: "# Full Template\n\n## Section A\n\nContent A" }) as { content: string }; expect(r.content).toContain("Full Template"); });
  test("symphony.request_workflow_section returns specific section", async () => { const r = await handleTool("symphony.request_workflow_section", { section: "Section A" }, "issue-1", 0, tracker, { template: "# Full Template\n\n## Section A\n\nContent A\n\n## Section B\n\nContent B" }) as { content: string }; expect(r.content).toBe("Content A"); });
  test("symphony.create_issue defaults to TASK-1", async () => {
    tracker = makeTracker();
    tracker.insertIssue({ id: "issue-1", identifier: "ROOT-1", title: "Test Issue", state: "in_progress", priority: "medium" });
    const r = await handleTool("symphony.create_issue", { title: "Child" }, "issue-1", 0, tracker) as { id: string; identifier: string; state: string };
    expect(r.identifier).toBe("TASK-1");
    expect(r.state).toBe("backlog");
    expect(tracker.getIssue(r.id)!.state).toBe("backlog");
  });
  test("symphony.create_issue generates TASK-2 and TASK-3 sequentially", async () => {
    const first = await handleTool("symphony.create_issue", { title: "Child 1" }, "issue-1", 0, tracker) as { identifier: string };
    const second = await handleTool("symphony.create_issue", { title: "Child 2" }, "issue-1", 0, tracker) as { identifier: string };
    expect(first.identifier).toBe("TASK-2");
    expect(second.identifier).toBe("TASK-3");
  });
  test("symphony.create_issue links current issue as blocker", async () => {
    const r = await handleTool("symphony.create_issue", { title: "Blocked child", link_current_as_blocker: true }, "issue-1", 0, tracker) as { id: string };
    expect(tracker.getIssue(r.id)!.blockers).toEqual([{ blocker_id: "issue-1", blocker_state: "in_progress" }]);
  });
  test("symphony.create_issue can create immediately schedulable todo issue", async () => {
    const r = await handleTool("symphony.create_issue", { title: "Ready child", state: "todo" }, "issue-1", 0, tracker) as { id: string };
    expect(tracker.getCandidates(10).map((i) => i.id)).toContain(r.id);
  });
  test("symphony.activate_issue moves backlog issue to todo", async () => {
    const created = await handleTool("symphony.create_issue", { title: "Backlog child" }, "issue-1", 0, tracker) as { id: string };
    const r = await handleTool("symphony.activate_issue", { issue_id: created.id }, "issue-1", 0, tracker) as { ok: boolean; id: string; state: string };
    expect(r.ok).toBe(true);
    expect(r.state).toBe("todo");
    expect(tracker.getIssue(created.id)!.state).toBe("todo");
    expect(tracker.getCandidates(10).map((i) => i.id)).toContain(created.id);
  });
  test("symphony.activate_issue rejects invalid target_state", async () => {
    const created = await handleTool("symphony.create_issue", { title: "Backlog child" }, "issue-1", 0, tracker) as { id: string };
    await expect(handleTool("symphony.activate_issue", { issue_id: created.id, target_state: "backlog" }, "issue-1", 0, tracker)).rejects.toThrow("must not be one of");
  });
  test("symphony.session_completed records event", async () => { const r = await handleTool("symphony.session_completed", { semantics: "success", summary: "Task completed successfully" }, "issue-1", 0, tracker) as { ok: boolean }; expect(r.ok).toBe(true); const ev = tracker.getEvents().find(e => e.kind === "session_completed"); expect(ev).toBeDefined(); });
  test("unknown tool throws error", async () => { await expect(handleTool("symphony.unknown_tool", {}, "issue-1", 0, tracker)).rejects.toThrow("Unknown tool"); });
});
