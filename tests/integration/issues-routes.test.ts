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
