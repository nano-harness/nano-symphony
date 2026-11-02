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
  let tickCount = 0;
  const triggerTick = () => { tickCount++; };
  const app = new Hono();
  app.route("/", createRoutes(tracker, getWorkflow, triggerTick));
  return { app, tracker, getTickCount: () => tickCount };
}

describe("retrigger routes", () => {
  test("POST /issues/:id/retrigger from done state → todo", async () => {
    const { app, tracker, getTickCount } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "done" });
    // Create a run row to simulate a previously-completed run
    tracker.claimIssue("i1", 1);
    tracker.releaseIssue("i1", "released");
    tracker.updateLastIssueState("i1", "done");

    const res = await app.request("/issues/i1/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // State should be changed to todo
    const issue = tracker.getIssue("i1")!;
    expect(issue.state).toBe("todo");

    // last_issue_state should be cleared
    const run = tracker.getRun("i1");
    expect(run?.last_issue_state).toBe("");

    // triggerTick should have been called
    expect(getTickCount()).toBeGreaterThan(0);
  });

  test("POST /issues/:id/retrigger from cancelled state → todo", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "cancelled" });

    const res = await app.request("/issues/i1/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const issue = tracker.getIssue("i1")!;
    expect(issue.state).toBe("todo");
  });

  test("POST /issues/:id/retrigger from in_review state → todo", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "in_review" });

    const res = await app.request("/issues/i1/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const issue = tracker.getIssue("i1")!;
    expect(issue.state).toBe("todo");
  });

  test("POST /issues/:id/retrigger clears blocker fingerprint by default", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "done" });
    tracker.updateLastBlockerFingerprint("i1", "some_fingerprint");

    await app.request("/issues/i1/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(tracker.getLastBlockerFingerprint("i1")).toBeNull();
  });

  test("POST /issues/:id/retrigger with reset_blocker_fingerprint=false preserves fingerprint", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "done" });
    tracker.updateLastBlockerFingerprint("i1", "keep_me");

    await app.request("/issues/i1/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reset_blocker_fingerprint: false }),
    });

    expect(tracker.getLastBlockerFingerprint("i1")).toBe("keep_me");
  });

  test("POST /issues/:id/retrigger with note creates a comment", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "done" });

    await app.request("/issues/i1/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Try again with different approach" }),
    });

    const comments = tracker.listComments("i1");
    expect(comments.length).toBe(1);
    expect(comments[0].body).toBe("Try again with different approach");
    expect(comments[0].author).toBe("operator");
  });

  test("POST /issues/:id/retrigger releases non-released run", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "done" });
    // Simulate a claimed run
    tracker.claimIssue("i1", 1);
    tracker.releaseIssue("i1", "cancelled");

    await app.request("/issues/i1/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const run = tracker.getRun("i1")!;
    expect(run.last_state).toBe("released");
    expect(run.last_issue_state).toBe("");
  });

  test("POST /issues/:id/retrigger with invalid target_state returns 400", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "done" });

    const res = await app.request("/issues/i1/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_state: "backlog" }),
    });

    expect(res.status).toBe(400);
  });

  test("POST /issues/:id/retrigger with target_state=done returns 400", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "in_review" });

    const res = await app.request("/issues/i1/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_state: "done" }),
    });

    expect(res.status).toBe(400);
  });

  test("POST /issues/:id/retrigger on non-existent issue returns 404", async () => {
    const { app } = makeApp();

    const res = await app.request("/issues/nonexistent/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
  });

  test("POST /issues/:id/retrigger records retrigger_requested event", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "in_review" });

    await app.request("/issues/i1/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const events = tracker.getEvents().filter((e) => e.issue_uuid === "i1" && e.kind === "retrigger_requested");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payload_json!);
    expect(payload.from_state).toBe("in_review");
    expect(payload.to_state).toBe("todo");
    expect(payload.reset_blocker_fingerprint).toBe(true);
  });

  test("POST /issues/:id/retrigger is idempotent (repeated calls don't 5xx)", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "done" });

    // Call retrigger 3 times
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/issues/i1/retrigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    }

    // All retrigger_requested events should be recorded
    const events = tracker.getEvents().filter((e) => e.kind === "retrigger_requested");
    expect(events.length).toBe(3);
  });

  test("POST /issues/:id/retrigger makes issue pickable by candidates query", async () => {
    const { app, tracker } = makeApp();
    tracker.insertIssue({ uuid: "i1", title: "t", state: "done" });
    // Simulate a completed run with synced last_issue_state
    tracker.claimIssue("i1", 1);
    tracker.releaseIssue("i1", "released");
    tracker.updateLastIssueState("i1", "done");

    // Issue should NOT be a candidate (it's in done state with synced last_issue_state)
    expect(tracker.getCandidates(10).find((c) => c.uuid === "i1")).toBeUndefined();

    // Now retrigger
    await app.request("/issues/i1/retrigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // Issue should now be a candidate
    const candidates = tracker.getCandidates(10);
    expect(candidates.find((c) => c.uuid === "i1")).toBeDefined();
  });
});
