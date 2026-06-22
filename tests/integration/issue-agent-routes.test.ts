import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { createRoutes } from "../../src/http/routes/index.ts";

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
        agent_kind: "claude-code",
        // S2: agent_binary is no longer accepted via the HTTP API (server-side only)
      }),
    });
    expect(r.status).toBe(201);
    const body: any = await r.json();
    expect(body.agent_kind).toBe("claude-code");
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
    const created = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "t", state: "todo", agent_kind: "claude-code" }),
    });
    const { uuid } = await created.json() as { uuid: string };
    const r = await app.request(`/issues/${uuid}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_kind: null }),
    });
    expect(r.status).toBe(200);
    const got = tracker.getIssue(uuid)!;
    expect(got.agent_kind).toBeNull();
  });

  test("PUT .strict() still rejects unknown fields", async () => {
    const { app } = mkApp();
    const created = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "t", state: "todo" }),
    });
    const { uuid } = await created.json() as { uuid: string };
    const r = await app.request(`/issues/${uuid}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_model: "opus" }),
    });
    expect(r.status).toBe(400);
  });

  test("POST rejects permission_mode_override (removed field)", async () => {
    const { app } = mkApp();
    const r = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "t", state: "todo", permission_mode_override: "auto" }),
    });
    expect(r.status).toBe(400);
  });

  test("POST rejects sandbox_extra_read_only_paths (removed field)", async () => {
    const { app } = mkApp();
    const r = await app.request("/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "t", state: "todo", sandbox_extra_read_only_paths: ["/tmp"] }),
    });
    expect(r.status).toBe(400);
  });
});
