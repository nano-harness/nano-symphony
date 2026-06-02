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
    expect(body.identifier).toMatch(/^TASK-\d+$/);
  });

  test("POST with description and workspace_path as null should succeed", async () => {
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

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.identifier).toBe("NULL-1");
    expect(body.title).toBe("Test null fields");
    // Description and workspace_path should be stored as null or undefined, both are acceptable
  });

  test("POST with completely omitted optional fields should succeed", async () => {
    const { app } = makeApp();
    const res = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "OMIT-1",
        title: "Test omitted fields",
        priority: "medium",
        state: "todo",
        labels: [],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.identifier).toBe("OMIT-1");
  });

  test("POST with description as empty string should succeed", async () => {
    const { app } = makeApp();
    const res = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "EMPTY-1",
        title: "Test empty string",
        priority: "medium",
        state: "todo",
        description: "",
        labels: [],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.identifier).toBe("EMPTY-1");
  });

  test("POST with invalid state should fail with 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "BAD-1",
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
    // Create an issue first
    tracker.insertIssue({
      id: "test-id-1",
      identifier: "PUT-1",
      title: "Original title",
      state: "todo",
      priority: "medium",
      labels: [],
    });

    const res = await app.request("/issues/test-id-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: null,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("test-id-1");
  });

  test("PUT attempting to change identifier should fail with 400", async () => {
    const { app, tracker } = makeApp();
    // Create an issue first
    tracker.insertIssue({
      id: "test-id-2",
      identifier: "PUT-2",
      title: "Original title",
      state: "todo",
      priority: "medium",
      labels: [],
    });

    const res = await app.request("/issues/test-id-2", {
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
    // Create an issue first
    tracker.insertIssue({
      id: "test-id-3",
      identifier: "PUT-3",
      title: "Original title",
      state: "todo",
      priority: "medium",
      labels: [],
    });

    const res = await app.request("/issues/test-id-3", {
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
  test("GET /issues/:id/plan returns 404 when no plan submitted", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "plan-1", identifier: "PLAN-1", title: "Plan issue", state: "plan_review", priority: "medium", labels: [] });
    const res = await app.request("/issues/plan-1/plan");
    expect(res.status).toBe(404);
  });

  test("POST /approve-plan transitions plan_review issue to in_progress", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "plan-1", identifier: "PLAN-1", title: "Plan issue", state: "plan_review", priority: "medium", labels: [] });
    const res = await app.request("/issues/plan-1/approve-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; state: string };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("in_progress");
    expect(tracker.getIssue("plan-1")!.state).toBe("in_progress");
    expect(tracker.getLatestEventByKind("plan-1", "plan_approved")).toBeDefined();
  });

  test("POST /approve-plan returns 400 when issue is not in plan_review state", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "plan-1", identifier: "PLAN-1", title: "Plan issue", state: "in_progress", priority: "medium", labels: [] });
    const res = await app.request("/issues/plan-1/approve-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("POST /revise-plan transitions plan_review issue back to planning", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "plan-1", identifier: "PLAN-1", title: "Plan issue", state: "plan_review", priority: "medium", labels: [] });
    const res = await app.request("/issues/plan-1/revise-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Step 3 needs rethinking" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; state: string };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("planning");
    expect(tracker.getIssue("plan-1")!.state).toBe("planning");
    expect(tracker.getLatestEventByKind("plan-1", "plan_revision_requested")).toBeDefined();
  });

  test("POST /revise-plan returns 400 when issue is not in plan_review state", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "plan-1", identifier: "PLAN-1", title: "Plan issue", state: "todo", priority: "medium", labels: [] });
    const res = await app.request("/issues/plan-1/revise-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Some feedback" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /revise-plan returns 400 when note is missing", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "plan-1", identifier: "PLAN-1", title: "Plan issue", state: "plan_review", priority: "medium", labels: [] });
    const res = await app.request("/issues/plan-1/revise-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("PUT /issues/:id accepts planning and plan_review as valid states", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "plan-1", identifier: "PLAN-1", title: "Plan issue", state: "todo", priority: "medium", labels: [] });

    const res1 = await app.request("/issues/plan-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "planning" }),
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/issues/plan-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "plan_review" }),
    });
    expect(res2.status).toBe(200);
  });
});

describe("handoff review routes", () => {
  test("POST /issues/:id/request-changes requires a non-empty note", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "review-1", identifier: "REVIEW-1", title: "Review issue", state: "in_review", priority: "medium", labels: [] });

    const res = await app.request("/issues/review-1/request-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("POST /issues/:id/request-changes rejects unexpected fields", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "review-2", identifier: "REVIEW-2", title: "Review issue", state: "in_review", priority: "medium", labels: [] });

    const res = await app.request("/issues/review-2/request-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Please address feedback", extra: true }),
    });

    expect(res.status).toBe(400);
  });

  test("POST /issues/:id/request-changes moves issue back to todo and records revision_requested", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "review-3", identifier: "REVIEW-3", title: "Review issue", state: "in_review", priority: "medium", labels: [] });

    const res = await app.request("/issues/review-3/request-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Please rework the handoff" }),
    });

    expect(res.status).toBe(200);
    expect(tracker.getIssue("review-3")!.state).toBe("todo");
    expect(tracker.getLatestEventByKind("review-3", "revision_requested")?.message).toBe("Please rework the handoff");
  });
});
