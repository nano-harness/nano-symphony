import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { enforceBudgetIfNeeded } from "../../src/orchestrator/worker.ts";

function makeDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

describe("budget enforcement", () => {
  let db: Database;
  let tracker: ReturnType<typeof createTracker>;

  beforeEach(() => {
    db = makeDb();
    tracker = createTracker(db);
  });

  test("cancels issue when cost budget exceeded", () => {
    const issue = tracker.insertIssue({
      uuid: "issue-budget",
      title: "Budget test",
      state: "in_progress",
      cost_budget_usd: 0.5,
    });
    tracker.recordLlmCall({ issue_uuid: issue.uuid, attempt: 0, input_tokens: 1000, output_tokens: 500, cost_usd: 0.3, provider: "test", model: "test", duration_ms: 1000, duration_api_ms: 800 });
    tracker.recordLlmCall({ issue_uuid: issue.uuid, attempt: 1, input_tokens: 1000, output_tokens: 500, cost_usd: 0.3, provider: "test", model: "test", duration_ms: 1000, duration_api_ms: 800 });

    enforceBudgetIfNeeded(tracker, issue.uuid);

    const updated = tracker.getIssue(issue.uuid)!;
    expect(updated.state).toBe("cancelled");
    const event = tracker.getLatestEventByKind(issue.uuid, "budget_exceeded");
    expect(event).not.toBeNull();
    expect(event!.message).toContain("exceeds budget");
  });

  test("cancels issue when token budget exceeded", () => {
    const issue = tracker.insertIssue({
      uuid: "issue-tokens",
      title: "Token budget test",
      state: "in_progress",
      token_budget: 1000,
    });
    tracker.recordLlmCall({ issue_uuid: issue.uuid, attempt: 0, input_tokens: 600, output_tokens: 500, cost_usd: 0.1, provider: "test", model: "test", duration_ms: 1000, duration_api_ms: 800 });

    enforceBudgetIfNeeded(tracker, issue.uuid);

    const updated = tracker.getIssue(issue.uuid)!;
    expect(updated.state).toBe("cancelled");
  });

  test("does nothing when within budget", () => {
    const issue = tracker.insertIssue({
      uuid: "issue-ok",
      title: "Within budget",
      state: "in_progress",
      cost_budget_usd: 1.0,
      token_budget: 10000,
    });
    tracker.recordLlmCall({ issue_uuid: issue.uuid, attempt: 0, input_tokens: 100, output_tokens: 50, cost_usd: 0.01, provider: "test", model: "test", duration_ms: 1000, duration_api_ms: 800 });

    enforceBudgetIfNeeded(tracker, issue.uuid);

    const updated = tracker.getIssue(issue.uuid)!;
    expect(updated.state).toBe("in_progress");
    expect(tracker.getLatestEventByKind(issue.uuid, "budget_exceeded")).toBeNull();
  });

  test("does nothing when no budget set", () => {
    const issue = tracker.insertIssue({
      uuid: "issue-no-budget",
      title: "No budget",
      state: "in_progress",
    });
    tracker.recordLlmCall({ issue_uuid: issue.uuid, attempt: 0, input_tokens: 100000, output_tokens: 50000, cost_usd: 10, provider: "test", model: "test", duration_ms: 1000, duration_api_ms: 800 });

    enforceBudgetIfNeeded(tracker, issue.uuid);

    const updated = tracker.getIssue(issue.uuid)!;
    expect(updated.state).toBe("in_progress");
  });
});
