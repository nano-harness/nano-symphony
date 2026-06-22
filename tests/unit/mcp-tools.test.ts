import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { handleTool } from "../../src/mcp/tools.ts";
function makeTracker() { const db = new Database(":memory:"); runMigrations(db); return createTracker(db); }
describe("MCP tools", () => {
  let tracker: ReturnType<typeof createTracker>;
  beforeEach(() => { tracker = makeTracker(); tracker.insertIssue({ uuid: "issue-1", title: "Test Issue", description: "Test description", state: "in_progress", priority: "medium" }); });
  test("symphony.fetch_issue returns issue", async () => { const r = await handleTool("symphony.fetch_issue", {}, "issue-1", 0, tracker) as { issue: { uuid: string }; attempt: number }; expect(r.issue.uuid).toBe("issue-1"); expect(r.attempt).toBe(0); });
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

  test("A6: suggest_state_transition to 'in_progress' is allowed", async () => {
    tracker.updateIssueState("issue-1", "todo");
    const r = await handleTool("symphony.suggest_state_transition", { suggested_state: "in_progress", reason: "start working" }, "issue-1", 0, tracker) as { ok: boolean; state?: string };
    expect(r.ok).toBe(true);
    expect(r.state).toBe("in_progress");
  });
});
