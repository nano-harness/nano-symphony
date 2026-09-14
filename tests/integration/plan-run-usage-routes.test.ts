import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { createRoutes } from "../../src/http/routes/index.ts";

function makeApp() {
  const db = new Database(":memory:");
  runMigrations(db);
  const tracker = createTracker(db);
  const getWorkflow = () => undefined;
  const triggerTick = () => {};
  const app = new Hono();
  app.route("/", createRoutes(tracker, getWorkflow, triggerTick));
  return { app, tracker };
}

describe("plan-run usage route", () => {
  test("returns 404 for unknown run", async () => {
    const { app } = makeApp();
    const res = await app.request("/plan-runs/RUN-missing/usage");
    expect(res.status).toBe(404);
  });

  test("returns token/cost totals and first-attempt consistency", async () => {
    const { app, tracker } = makeApp();
    tracker.insertPlanRun({ id: "RUN-1", script: "plan {}", meta: { name: "usage", max_issues: 5 } });
    const done = tracker.insertIssue({ uuid: "uuid-done", title: "Done", state: "done", plan_run_id: "RUN-1" });
    const retried = tracker.insertIssue({ uuid: "uuid-retried", title: "Retried", state: "done", plan_run_id: "RUN-1" });
    tracker.insertIssue({ uuid: "uuid-open", title: "Open", state: "in_progress", plan_run_id: "RUN-1" });
    tracker.recordLlmCall({ issue_uuid: done.uuid, attempt: 0, input_tokens: 100, output_tokens: 50, cost_usd: 0.01, provider: "test", model: "test", duration_ms: 1000, duration_api_ms: 800 });
    tracker.recordLlmCall({ issue_uuid: retried.uuid, attempt: 0, input_tokens: 100, output_tokens: 50, cost_usd: 0.01, provider: "test", model: "test", duration_ms: 1000, duration_api_ms: 800 });
    tracker.recordLlmCall({ issue_uuid: retried.uuid, attempt: 1, input_tokens: 100, output_tokens: 50, cost_usd: 0.01, provider: "test", model: "test", duration_ms: 1000, duration_api_ms: 800 });

    const res = await app.request("/plan-runs/RUN-1/usage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issue_count).toBe(3);
    expect(body.total.input_tokens).toBe(300);
    expect(body.total.output_tokens).toBe(150);
    expect(body.total.cost_usd).toBeCloseTo(0.03);
    expect(body.total.attempts).toBe(3);
    expect(body.consistency.terminal_issues).toBe(2);
    expect(body.consistency.done_issues).toBe(2);
    expect(body.consistency.first_attempt_successes).toBe(1);
    expect(body.consistency.first_attempt_success_rate).toBeCloseTo(0.5);
    expect(body.issues.length).toBe(3);
  });

  test("reports null success rate when no issue is terminal", async () => {
    const { app, tracker } = makeApp();
    tracker.insertPlanRun({ id: "RUN-2", script: "plan {}", meta: { name: "empty", max_issues: 5 } });

    const res = await app.request("/plan-runs/RUN-2/usage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issue_count).toBe(0);
    expect(body.consistency.first_attempt_success_rate).toBeNull();
  });
});
