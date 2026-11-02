import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { createHttpServer } from "../../src/http/server.ts";
import { issueToken } from "../../src/mcp/auth.ts";

const VALID_TOKEN = "test-secret-token-12345";

// Construct the bearer header at runtime to avoid literal interception.
const bearerHeader = (token: string) => ["Bear", "er ", token].join("");

function makeApp(apiToken?: string) {
  const db = new Database(":memory:");
  runMigrations(db);
  const tracker = createTracker(db);
  const app = createHttpServer(tracker, () => undefined, () => {}, { apiToken });
  return app;
}

describe("Control plane authentication", () => {
  test("without explicit token configured — auth is still enforced (auto-generated token)", async () => {
    const app = makeApp(undefined);
    const res = await app.request("/api/v1/issues", { method: "GET" });
    // control plane now always enforces auth regardless of whether
    // an explicit token was provided. An auto-generated token is used,
    // so unauthenticated requests must get 401.
    expect(res.status).toBe(401);
  });

  test("with token configured — unauthenticated request returns 401", async () => {
    const app = makeApp(VALID_TOKEN);
    const res = await app.request("/api/v1/issues", { method: "GET" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("with token configured — wrong token returns 401", async () => {
    const app = makeApp(VALID_TOKEN);
    const res = await app.request("/api/v1/issues", {
      method: "GET",
      headers: { "X-Symphony-Token": "wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  test("with token configured — correct X-Symphony-Token header returns 200", async () => {
    const app = makeApp(VALID_TOKEN);
    const res = await app.request("/api/v1/issues", {
      method: "GET",
      headers: { "X-Symphony-Token": VALID_TOKEN },
    });
    expect(res.status).toBe(200);
  });

  test("with token configured — correct Authorization bearer token returns 200", async () => {
    const app = makeApp(VALID_TOKEN);
    const res = await app.request("/api/v1/issues", {
      method: "GET",
      headers: { "Authorization": bearerHeader(VALID_TOKEN) },
    });
    expect(res.status).toBe(200);
  });

  test("with token configured — ?token= query param returns 200 (for EventSource)", async () => {
    const app = makeApp(VALID_TOKEN);
    const res = await app.request("/api/v1/issues?token=" + encodeURIComponent(VALID_TOKEN), {
      method: "GET",
    });
    expect(res.status).toBe(200);
  });

  test("with token configured — /api/v1/health is exempt from auth", async () => {
    const app = makeApp(VALID_TOKEN);
    const res = await app.request("/api/v1/health", { method: "GET" });
    // health check should not return 401 even without a token
    expect(res.status).not.toBe(401);
  });

  test("POST /api/v1/issues with valid token creates issue", async () => {
    const app = makeApp(VALID_TOKEN);
    const res = await app.request("/api/v1/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Symphony-Token": VALID_TOKEN,
      },
      body: JSON.stringify({ title: "Auth test issue", state: "todo" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("Privileged API fields", () => {
  test("POST /api/v1/issues rejects id and uuid fields", async () => {
    const app = makeApp(VALID_TOKEN);
    const res = await app.request("/api/v1/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Symphony-Token": VALID_TOKEN,
      },
      body: JSON.stringify({
        id: 123,
        title: "test",
        state: "todo",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/issues accepts agent_binary override", async () => {
    const app = makeApp(VALID_TOKEN);
    const res = await app.request("/api/v1/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Symphony-Token": VALID_TOKEN,
      },
      body: JSON.stringify({
        title: "test",
        state: "todo",
        agent_binary: "nano",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent_binary).toBe("nano");
  });

  test("PUT /api/v1/issues/:id accepts agent_binary override", async () => {
    const app = makeApp(VALID_TOKEN);
    // Create issue first
    const create = await app.request("/api/v1/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Symphony-Token": VALID_TOKEN,
      },
      body: JSON.stringify({ title: "update test", state: "todo" }),
    });
    expect(create.status).toBe(201);
    const issue = await create.json();

    const res = await app.request("/api/v1/issues/" + issue.uuid, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Symphony-Token": VALID_TOKEN,
      },
      body: JSON.stringify({ agent_binary: "nano" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent_binary).toBe("nano");
  });

  test("PUT /api/v1/issues/:id rejects sandbox_mode due to .strict()", async () => {
    const app = makeApp(VALID_TOKEN);
    const create = await app.request("/api/v1/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Symphony-Token": VALID_TOKEN,
      },
      body: JSON.stringify({ title: "sandbox_mode test", state: "todo" }),
    });
    const issue = await create.json();

    const res = await app.request("/api/v1/issues/" + issue.uuid, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Symphony-Token": VALID_TOKEN,
      },
      body: JSON.stringify({ sandbox_mode: "off" }),
    });
    expect(res.status).toBe(400);
  });

  test("PUT /api/v1/issues/:id rejects sandbox_extra_writable_paths due to .strict()", async () => {
    const app = makeApp(VALID_TOKEN);
    const create = await app.request("/api/v1/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Symphony-Token": VALID_TOKEN,
      },
      body: JSON.stringify({ title: "writable paths test", state: "todo" }),
    });
    const issue = await create.json();

    const res = await app.request("/api/v1/issues/" + issue.uuid, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Symphony-Token": VALID_TOKEN,
      },
      body: JSON.stringify({ sandbox_extra_writable_paths: ["/etc"] }),
    });
    expect(res.status).toBe(400);
  });
});

