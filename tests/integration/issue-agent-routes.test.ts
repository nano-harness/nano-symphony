import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { createRoutes } from "../../src/http/routes.ts";

function mkApp() {
  const db = new Database(":memory:");
  runMigrations(db);
  const tracker = createTracker(db);
  const app = createRoutes(tracker, () => undefined, () => {});
  return { app, tracker };
}

describe("POST /issues — agent overrides", () => {
  test("accepts agent_kind=claude-code", async () => {
    const { app } = mkApp();
    const r = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "t", state: "todo",
        agent_kind: "claude-code", agent_binary: "/opt/claude",
      }),
    });
    expect(r.status).toBe(201);
    const body: any = await r.json();
    expect(body.agent_kind).toBe("claude-code");
    expect(body.agent_binary).toBe("/opt/claude");
  });

  test("rejects bad agent_kind", async () => {
    const { app } = mkApp();
    const r = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "t", state: "todo", agent_kind: "gpt-5" }),
    });
    expect(r.status).toBe(400);
  });

  test("null agent_kind clears override", async () => {
    const { app, tracker } = mkApp();
    await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "ix", title: "t", state: "todo", agent_kind: "claude-code",
      }),
    });
    const r = await app.request("/issues/ix", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_kind: null }),
    });
    expect(r.status).toBe(200);
    const got = tracker.getIssue("ix")!;
    expect(got.agent_kind).toBeNull();
  });

  test("PUT .strict() still rejects unknown fields", async () => {
    const { app } = mkApp();
    await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "iy", title: "t", state: "todo" }),
    });
    const r = await app.request("/issues/iy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_model: "opus" }),
    });
    expect(r.status).toBe(400);
  });
});
