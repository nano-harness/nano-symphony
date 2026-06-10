import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { createRoutes } from "../../src/http/routes.ts";

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

describe("issues routes - null tolerance", () => {
  test("POST without identifier should auto-generate TASK-N", async () => {
    const { app } = makeApp();
    const res = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Auto-identified",
        state: "todo",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe("number");
    expect(typeof body.uuid).toBe("string");
    expect(body.identifier).toMatch(/^TASK-\d+$/);
  });

  test("POST with identifier field should be rejected with 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "NULL-1",
        title: "Test null fields",
        priority: "medium",
        state: "todo",
        description: null,
        workspace_path: null,
        labels: [],
      }),
    });

    expect(res.status).toBe(400);
  });

  test("POST with description and workspace_path as null should succeed when no identifier", async () => {
    const { app } = makeApp();
    const res = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test null fields",
        priority: "medium",
        state: "todo",
        description: null,
        workspace_path: null,
        labels: [],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("Test null fields");
  });

  test("POST with completely omitted optional fields should succeed", async () => {
    const { app } = makeApp();
    const res = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test omitted fields",
        priority: "medium",
        state: "todo",
        labels: [],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.identifier).toMatch(/^TASK-\d+$/);
  });

  test("POST with description as empty string should succeed", async () => {
    const { app } = makeApp();
    const res = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test empty string",
        priority: "medium",
        state: "todo",
        description: "",
        labels: [],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.identifier).toMatch(/^TASK-\d+$/);
  });

  test("POST with invalid state should fail with 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Invalid state",
        priority: "medium",
        state: "fictional",
        labels: [],
      }),
    });

    expect(res.status).toBe(400);
  });

  test("PUT with description as null should succeed", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({
      uuid: "test-uuid-1",
      title: "Original title",
      state: "todo",
      priority: "medium",
      labels: [],
    });

    const res = await app.request("/issues/" + issue.uuid, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: null,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uuid).toBe(issue.uuid);
  });

  test("PUT attempting to change identifier should fail with 400", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({
      uuid: "test-uuid-2",
      title: "Original title",
      state: "todo",
      priority: "medium",
      labels: [],
    });

    const res = await app.request("/issues/" + issue.uuid, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "OTHER-1", // This should be rejected by .strict()
      }),
    });

    expect(res.status).toBe(400);
  });

  test("PUT with invalid state should fail with 400", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({
      uuid: "test-uuid-3",
      title: "Original title",
      state: "todo",
      priority: "medium",
      labels: [],
    });

    const res = await app.request("/issues/" + issue.uuid, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: "fictional", // Invalid state
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe("plan workflow routes", () => {
  test("GET /issues/:uuid/plan returns 404 when no plan submitted", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({ uuid: "plan-1", title: "Plan issue", state: "plan_review", priority: "medium", labels: [] });
    const res = await app.request("/issues/" + issue.uuid + "/plan");
    expect(res.status).toBe(404);
  });

  test("POST /approve-plan transitions plan_review issue to in_progress", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({ uuid: "plan-1", title: "Plan issue", state: "plan_review", priority: "medium", labels: [] });
    const res = await app.request("/issues/" + issue.uuid + "/approve-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; state: string };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("in_progress");
    expect(tracker.getIssue(issue.uuid)!.state).toBe("in_progress");
    expect(tracker.getLatestEventByKind(issue.uuid, "plan_approved")).toBeDefined();
  });

  test("POST /approve-plan returns 400 when issue is not in plan_review state", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({ uuid: "plan-1", title: "Plan issue", state: "in_progress", priority: "medium", labels: [] });
    const res = await app.request("/issues/" + issue.uuid + "/approve-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("POST /revise-plan transitions plan_review issue back to planning", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({ uuid: "plan-1", title: "Plan issue", state: "plan_review", priority: "medium", labels: [] });
    const res = await app.request("/issues/" + issue.uuid + "/revise-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Step 3 needs rethinking" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; state: string };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("planning");
    expect(tracker.getIssue(issue.uuid)!.state).toBe("planning");
    expect(tracker.getLatestEventByKind(issue.uuid, "plan_revision_requested")).toBeDefined();
  });

  test("POST /revise-plan returns 400 when issue is not in plan_review state", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({ uuid: "plan-1", title: "Plan issue", state: "todo", priority: "medium", labels: [] });
    const res = await app.request("/issues/" + issue.uuid + "/revise-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Some feedback" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /revise-plan returns 400 when note is missing", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({ uuid: "plan-1", title: "Plan issue", state: "plan_review", priority: "medium", labels: [] });
    const res = await app.request("/issues/" + issue.uuid + "/revise-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("PUT /issues/:uuid accepts planning and plan_review as valid states", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({ uuid: "plan-1", title: "Plan issue", state: "todo", priority: "medium", labels: [] });

    const res1 = await app.request("/issues/" + issue.uuid, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "planning" }),
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/issues/" + issue.uuid, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "plan_review" }),
    });
    expect(res2.status).toBe(200);
  });
});

describe("handoff review routes", () => {
  test("POST /issues/:uuid/request-changes requires a non-empty note", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({ uuid: "review-1", title: "Review issue", state: "in_review", priority: "medium", labels: [] });

    const res = await app.request("/issues/" + issue.uuid + "/request-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("POST /issues/:uuid/request-changes rejects unexpected fields", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({ uuid: "review-2", title: "Review issue", state: "in_review", priority: "medium", labels: [] });

    const res = await app.request("/issues/" + issue.uuid + "/request-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Please address feedback", extra: true }),
    });

    expect(res.status).toBe(400);
  });

  test("POST /issues/:uuid/request-changes moves issue back to todo and records revision_requested", async () => {
    const { app, tracker } = makeApp();
    const issue = tracker.insertIssue({ uuid: "review-3", title: "Review issue", state: "in_review", priority: "medium", labels: [] });

    const res = await app.request("/issues/" + issue.uuid + "/request-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Please rework the handoff" }),
    });

    expect(res.status).toBe(200);
    expect(tracker.getIssue(issue.uuid)!.state).toBe("todo");
    expect(tracker.getLatestEventByKind(issue.uuid, "revision_requested")?.message).toBe("Please rework the handoff");
  });
});

describe("plan run routes", () => {
  test("POST /plan-runs/:id/reject cancels the run and records rejection details", async () => {
    const { app, tracker } = makeApp();
    tracker.insertPlanRun({
      id: "plan-run-reject-1",
      script: "return 'ok';",
      meta: { name: "Rejectable plan", max_issues: 1 },
    });
    tracker.updatePlanRunState("plan-run-reject-1", "awaiting_approval");

    const res = await app.request("/plan-runs/plan-run-reject-1/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Needs changes" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "cancelled" });

    const run = tracker.getPlanRun("plan-run-reject-1");
    expect(run?.state).toBe("cancelled");
    expect(run?.approval_status).toBe("rejected");
    expect(run?.approval_reason).toBe("Needs changes");
    expect(run?.finished_at).not.toBeNull();
  });

  test("POST /plan-runs/:id/request-changes cancels the run with a reviewer note", async () => {
    const { app, tracker } = makeApp();
    tracker.insertPlanRun({
      id: "plan-run-request-1",
      script: "return 'ok';",
      meta: { name: "Change-requested plan", max_issues: 1 },
    });
    tracker.updatePlanRunState("plan-run-request-1", "awaiting_approval");

    const res = await app.request("/plan-runs/plan-run-request-1/request-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestion: "Split this into smaller tasks" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "cancelled" });

    const run = tracker.getPlanRun("plan-run-request-1");
    expect(run?.state).toBe("cancelled");
    expect(run?.approval_status).toBe("rejected");
    expect(run?.approval_reason).toBe("Changes requested: Split this into smaller tasks");
    expect(run?.finished_at).not.toBeNull();
  });
});
