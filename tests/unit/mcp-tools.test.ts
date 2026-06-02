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

  test("symphony.session_completed with blocker_fingerprint updates issues row", async () => {
    const r = await handleTool("symphony.session_completed", {
      semantics: "abandoned",
      summary: "Cannot proceed",
      blocker_fingerprint: "sandbox_denied:/home/user/.aws"
    }, "issue-1", 0, tracker) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(tracker.getLastBlockerFingerprint("issue-1")).toBe("sandbox_denied:/home/user/.aws");
  });

  test("symphony.session_completed with termination_cause persists in payload_json", async () => {
    await handleTool("symphony.session_completed", {
      semantics: "abandoned",
      summary: "Gave up",
      termination_cause: "error_threshold"
    }, "issue-1", 0, tracker);

    const ev = tracker.getEvents().find(e => e.kind === "session_completed");
    expect(ev).toBeDefined();
    const payload = JSON.parse(ev!.payload_json!);
    expect(payload.termination_cause).toBe("error_threshold");
  });

  test("symphony.session_completed clears fingerprint on success", async () => {
    tracker.updateLastBlockerFingerprint("issue-1", "previous_blocker");
    expect(tracker.getLastBlockerFingerprint("issue-1")).toBe("previous_blocker");

    await handleTool("symphony.session_completed", {
      semantics: "success",
      summary: "Done"
    }, "issue-1", 0, tracker);

    expect(tracker.getLastBlockerFingerprint("issue-1")).toBeNull();
  });

  test("symphony.session_completed clears fingerprint on handoff", async () => {
    tracker.updateLastBlockerFingerprint("issue-1", "previous_blocker");

    await handleTool("symphony.session_completed", {
      semantics: "handoff",
      summary: "Ready for review",
      handoff_state: "in_review"
    }, "issue-1", 0, tracker);

    expect(tracker.getLastBlockerFingerprint("issue-1")).toBeNull();
  });

  test("unknown tool throws error", async () => { await expect(handleTool("symphony.unknown_tool", {}, "issue-1", 0, tracker)).rejects.toThrow("Unknown tool"); });

  // S2 — RegExp injection / ReDoS: malicious section names must not cause catastrophic backtracking
  test("S2: request_workflow_section with ReDoS-prone section name returns in time", async () => {
    // "(a+)+" style patterns would cause exponential backtracking if injected un-escaped
    const maliciousSection = "(a+)+ Section";
    const start = Date.now();
    const r = await handleTool(
      "symphony.request_workflow_section",
      { section: maliciousSection },
      "issue-1", 0, tracker,
      { template: "## Normal Section\n\nContent A\n\n## Another Section\n\nContent B" }
    ) as { content: string };
    const elapsed = Date.now() - start;
    // If RegExp was injected without escaping, this would take seconds; escaped it's instant.
    expect(elapsed).toBeLessThan(500);
    // The escaped pattern won't match any actual section — returns empty string, not an error
    expect(typeof r.content).toBe("string");
  });

  // S2 — Valid section names with parentheses must still match correctly after escaping
  test("S2: request_workflow_section with valid section name containing parentheses returns content", async () => {
    const r = await handleTool(
      "symphony.request_workflow_section",
      { section: "(Notes) Section" },
      "issue-1", 0, tracker,
      { template: "## (Notes) Section\n\nHello from notes\n\n## Other\n\nOther content" }
    ) as { content: string };
    // The section name contains literal parentheses — after escaping they should match
    expect(r.content).toBe("Hello from notes");
  });

  // S7 — Oversized payload must be rejected by ReportEventSchema
  test("S7: report_event rejects payload exceeding 64KB", async () => {
    const bigPayload = { data: "x".repeat(65 * 1024) };
    await expect(
      handleTool("symphony.report_event", { kind: "progress", message: "msg", payload: bigPayload }, "issue-1", 0, tracker)
    ).rejects.toThrow();
  });

  test("S7: report_event accepts payload under 64KB", async () => {
    const smallPayload = { data: "x".repeat(1024) };
    const r = await handleTool("symphony.report_event", { kind: "progress", message: "msg", payload: smallPayload }, "issue-1", 0, tracker) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  // A6 — suggest_state_transition must reject disallowed states
  test("A6: suggest_state_transition to 'backlog' is rejected", async () => {
    const r = await handleTool("symphony.suggest_state_transition", { suggested_state: "backlog", reason: "test" }, "issue-1", 0, tracker) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("backlog");
  });

  test("A6: suggest_state_transition to 'done' is rejected (must use session_completed)", async () => {
    const r = await handleTool("symphony.suggest_state_transition", { suggested_state: "done", reason: "test" }, "issue-1", 0, tracker) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("session_completed");
  });

  test("A6: suggest_state_transition to unknown state is rejected", async () => {
    const r = await handleTool("symphony.suggest_state_transition", { suggested_state: "unknown_state", reason: "test" }, "issue-1", 0, tracker) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("allowed states");
  });

  test("A6: suggest_state_transition to 'in_review' is allowed", async () => {
    const r = await handleTool("symphony.suggest_state_transition", { suggested_state: "in_review", reason: "test" }, "issue-1", 0, tracker) as { ok: boolean; state?: string };
    expect(r.ok).toBe(true);
    expect(r.state).toBe("in_review");
  });

  // Plan workflow tests
  describe("symphony.submit_plan", () => {
    test("submit_plan records plan_submitted event and transitions to plan_review", async () => {
      tracker.updateIssueState("issue-1", "planning");
      const r = await handleTool("symphony.submit_plan", { markdown: "# My Plan\n\n- Step 1\n- Step 2" }, "issue-1", 0, tracker) as { ok: boolean; message: string };
      expect(r.ok).toBe(true);
      expect(r.message).toContain("Plan submitted");
      expect(tracker.getIssue("issue-1")!.state).toBe("plan_review");
      const event = tracker.getLatestEventByKind("issue-1", "plan_submitted");
      expect(event).toBeDefined();
      const payload = JSON.parse(event!.payload_json ?? "{}");
      expect(payload.markdown).toContain("My Plan");
      expect(payload.revision).toBe(0);
    });

    test("submit_plan increments revision on subsequent submissions", async () => {
      tracker.updateIssueState("issue-1", "planning");
      await handleTool("symphony.submit_plan", { markdown: "# Plan v1" }, "issue-1", 0, tracker);
      tracker.updateIssueState("issue-1", "planning");
      await handleTool("symphony.submit_plan", { markdown: "# Plan v2" }, "issue-1", 0, tracker);
      const event = tracker.getLatestEventByKind("issue-1", "plan_submitted");
      const payload = JSON.parse(event!.payload_json ?? "{}");
      expect(payload.revision).toBe(1);
    });

    test("submit_plan rejects when issue is not in planning state", async () => {
      // issue-1 is in_progress by default in beforeEach
      const r = await handleTool("symphony.submit_plan", { markdown: "# Plan" }, "issue-1", 0, tracker) as { ok: boolean; error?: string };
      expect(r.ok).toBe(false);
      expect(r.error).toContain("planning");
    });

    test("submit_plan stores steps and estimates in payload", async () => {
      tracker.updateIssueState("issue-1", "planning");
      const steps = [{ id: "s1", title: "Step 1", description: "Do step 1" }];
      const estimates = { files_touched: 3, complexity: "low" as const, estimated_turns: 5 };
      await handleTool("symphony.submit_plan", { markdown: "# Plan", steps, estimates }, "issue-1", 0, tracker);
      const event = tracker.getLatestEventByKind("issue-1", "plan_submitted");
      const payload = JSON.parse(event!.payload_json ?? "{}");
      expect(payload.steps).toEqual(steps);
      expect(payload.estimates).toEqual(estimates);
    });
  });

  describe("symphony.session_completed in planning phase", () => {
    test("handoff semantics in planning phase auto-submits plan and transitions to plan_review", async () => {
      tracker.updateIssueState("issue-1", "planning");
      const r = await handleTool("symphony.session_completed", { semantics: "handoff", summary: "Finished planning" }, "issue-1", 0, tracker) as { ok: boolean };
      expect(r.ok).toBe(true);
      expect(tracker.getIssue("issue-1")!.state).toBe("plan_review");
      const event = tracker.getLatestEventByKind("issue-1", "plan_submitted");
      expect(event).toBeDefined();
    });

    test("needs_retry semantics in planning phase keeps normal retry behavior", async () => {
      tracker.updateIssueState("issue-1", "planning");
      const r = await handleTool("symphony.session_completed", { semantics: "needs_retry", summary: "Cannot plan yet" }, "issue-1", 0, tracker) as { ok: boolean };
      expect(r.ok).toBe(true);
      // Should NOT create plan_submitted event
      const event = tracker.getLatestEventByKind("issue-1", "plan_submitted");
      expect(event).toBeNull();
    });
  });

  test("A6: suggest_state_transition to 'planning' is allowed", async () => {
    tracker.updateIssueState("issue-1", "todo");
    const r = await handleTool("symphony.suggest_state_transition", { suggested_state: "planning", reason: "entering planning phase" }, "issue-1", 0, tracker) as { ok: boolean; state?: string };
    expect(r.ok).toBe(true);
    expect(r.state).toBe("planning");
  });
});
