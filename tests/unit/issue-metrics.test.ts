import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { createTracker } from "../../src/db/tracker.ts";
import { runMigrations } from "../../src/db/migrations.ts";

describe("issue metrics persistence", () => {
  let db: Database;
  let tracker: ReturnType<typeof createTracker>;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    tracker = createTracker(db);
  });

  it("records a terminal snapshot and reads it back", () => {
    const issue = tracker.insertIssue({
      uuid: nanoid(),
      title: "m1",
      state: "done",
      cost_budget_usd: null,
      token_budget: null,
    });
    tracker.claimIssue(issue.uuid, 1);
    tracker.markCurrentAttempt(issue.uuid, 1);
    tracker.recordLlmCall({
      issue_uuid: issue.uuid,
      attempt: 1,
      provider: "test",
      model: "t",
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0.0012,
      duration_ms: 1200,
      duration_api_ms: 1100,
    });
    tracker.recordEvent(issue.uuid, "session_completed", "ok", { semantics: "success" });

    const metrics = tracker.recordIssueMetrics(issue.uuid, {
      getIssue: tracker.getIssue,
      getRun: tracker.getRun,
      getEventsByKind: tracker.getEventsByKind,
      getLlmCallSummary: tracker.getLlmCallSummary,
    });

    expect(metrics.final_state).toBe("done");
    expect(metrics.attempts).toBe(1);
    expect(metrics.sessions).toBe(1);
    expect(metrics.input_tokens).toBe(10);
    expect(metrics.output_tokens).toBe(5);
    expect(metrics.cost_usd).toBeCloseTo(0.0012);
    expect(metrics.duration_ms).toBe(1200);
    expect(metrics.blocked).toBe(0);

    const read = tracker.getIssueMetrics(issue.uuid);
    expect(read).not.toBeNull();
    expect(read!.issue_uuid).toBe(issue.uuid);
  });

  it("flags blocked issues in metrics", () => {
    const issue = tracker.insertIssue({
      uuid: nanoid(),
      title: "m2",
      state: "blocked",
      cost_budget_usd: null,
      token_budget: null,
    });
    tracker.claimIssue(issue.uuid, 2);
    tracker.markCurrentAttempt(issue.uuid, 2);
    tracker.recordEvent(issue.uuid, "session_completed", "retry", { semantics: "needs_retry" });
    tracker.recordEvent(issue.uuid, "session_completed", "retry", { semantics: "needs_retry" });

    const metrics = tracker.recordIssueMetrics(issue.uuid, {
      getIssue: tracker.getIssue,
      getRun: tracker.getRun,
      getEventsByKind: tracker.getEventsByKind,
      getLlmCallSummary: tracker.getLlmCallSummary,
    });

    expect(metrics.blocked).toBe(1);
    expect(metrics.sessions).toBe(2);
  });

  it("lists metrics and returns a summary", () => {
    const a = tracker.insertIssue({ uuid: nanoid(), title: "a", state: "done", cost_budget_usd: null, token_budget: null });
    const b = tracker.insertIssue({ uuid: nanoid(), title: "b", state: "cancelled", cost_budget_usd: null, token_budget: null });
    tracker.claimIssue(a.uuid, 1);
    tracker.markCurrentAttempt(a.uuid, 1);
    tracker.claimIssue(b.uuid, 1);
    tracker.markCurrentAttempt(b.uuid, 1);
    tracker.recordLlmCall({ issue_uuid: a.uuid, attempt: 1, provider: "p", model: "m", input_tokens: 1, output_tokens: 1, cost_usd: 0.1, duration_ms: 100, duration_api_ms: 90 });
    tracker.recordLlmCall({ issue_uuid: b.uuid, attempt: 1, provider: "p", model: "m", input_tokens: 2, output_tokens: 2, cost_usd: 0.2, duration_ms: 200, duration_api_ms: 180 });

    tracker.recordIssueMetrics(a.uuid, { getIssue: tracker.getIssue, getRun: tracker.getRun, getEventsByKind: tracker.getEventsByKind, getLlmCallSummary: tracker.getLlmCallSummary });
    tracker.recordIssueMetrics(b.uuid, { getIssue: tracker.getIssue, getRun: tracker.getRun, getEventsByKind: tracker.getEventsByKind, getLlmCallSummary: tracker.getLlmCallSummary });

    const list = tracker.listIssueMetrics();
    expect(list.length).toBe(2);

    const summary = tracker.getMetricsSummary();
    expect(summary.total_issues).toBe(2);
    expect(summary.total_cost_usd).toBeCloseTo(0.3);
    expect(summary.total_input_tokens).toBe(3);
    expect(summary.total_output_tokens).toBe(3);
    expect(summary.total_duration_ms).toBe(300);
    expect(summary.blocked_count).toBe(0);
  });
});
