import { describe, test, expect } from "bun:test";
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

describe("comments routes", () => {
  test("POST /issues/:id/comments creates a comment", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });

    const res = await app.request("/issues/i1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hello world" }),
    });

    expect(res.status).toBe(201);
    const comment = await res.json();
    expect(comment.id).toBeTruthy();
    expect(comment.body).toBe("Hello world");
    expect(comment.author).toBe("operator");
    expect(comment.issue_id).toBe("i1");
  });

  test("POST /issues/:id/comments with custom author", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });

    const res = await app.request("/issues/i1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hi", author: "alice" }),
    });

    expect(res.status).toBe(201);
    const comment = await res.json();
    expect(comment.author).toBe("alice");
  });

  test("POST /issues/:id/comments with empty body returns 400", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });

    const res = await app.request("/issues/i1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "" }),
    });

    expect(res.status).toBe(400);
  });

  test("POST /issues/:id/comments with body > 8000 chars returns 400", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });

    const res = await app.request("/issues/i1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "x".repeat(8001) }),
    });

    expect(res.status).toBe(400);
  });

  test("POST /issues/:id/comments on non-existent issue returns 404", async () => {
    const { app } = makeApp();

    const res = await app.request("/issues/nonexistent/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hello" }),
    });

    expect(res.status).toBe(404);
  });

  test("GET /issues/:id/comments returns comments in ts order", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });
    tracker.addComment("i1", { body: "first" });
    tracker.addComment("i1", { body: "second" });

    const res = await app.request("/issues/i1/comments");
    expect(res.status).toBe(200);
    const comments = await res.json();
    expect(comments.length).toBe(2);
    expect(comments[0].body).toBe("first");
    expect(comments[1].body).toBe("second");
  });

  test("GET /issues/:id/comments on non-existent issue returns 404", async () => {
    const { app } = makeApp();
    const res = await app.request("/issues/nonexistent/comments");
    expect(res.status).toBe(404);
  });

  test("DELETE /issues/:id/comments/:commentId removes comment", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });
    const comment = tracker.addComment("i1", { body: "to delete" });

    const res = await app.request(`/issues/i1/comments/${comment.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(true);

    // Verify it's gone
    expect(tracker.getComment(comment.id)).toBeNull();
  });

  test("DELETE /issues/:id/comments/:commentId is idempotent (non-existent returns 200 deleted=false)", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });

    const res = await app.request("/issues/i1/comments/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(false);
  });

  test("POST /issues/:id/comments rejects unexpected fields (.strict())", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });

    const res = await app.request("/issues/i1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hello", extra_field: "bad" }),
    });

    expect(res.status).toBe(400);
  });
});
