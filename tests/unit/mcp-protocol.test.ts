import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { createMcpRouter } from "../../src/mcp/server.ts";
import { issueToken } from "../../src/mcp/auth.ts";
import {
  negotiateProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  PREFERRED_PROTOCOL_VERSION,
} from "../../src/mcp/protocol.ts";

describe("negotiateProtocolVersion", () => {
  test("echoes every supported client version", () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiateProtocolVersion(version)).toBe(version);
    }
  });

  test("falls back to the latest supported version for unknown versions", () => {
    expect(negotiateProtocolVersion("1999-01-01")).toBe(PREFERRED_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion("2026-07-28")).toBe(PREFERRED_PROTOCOL_VERSION);
  });

  test("falls back to the latest supported version when none was requested", () => {
    expect(negotiateProtocolVersion(undefined)).toBe(PREFERRED_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion("")).toBe(PREFERRED_PROTOCOL_VERSION);
  });

  test("preferred version is the newest entry in the supported list", () => {
    expect(PREFERRED_PROTOCOL_VERSION).toBe(
      SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1],
    );
    expect(PREFERRED_PROTOCOL_VERSION).toBe("2025-11-25");
  });
});

describe("MCP server protocol negotiation", () => {
  function makeApp() {
    const db = new Database(":memory:");
    runMigrations(db);
    const tracker = createTracker(db);
    return { app: createMcpRouter(tracker, () => undefined), token: issueToken("issue-1", 0) };
  }

  function postRpc(app: ReturnType<typeof createMcpRouter>, token: string, payload: unknown) {
    return app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Symphony-Token": token },
      body: JSON.stringify(payload),
    });
  }

  test("initialize echoes a supported client protocolVersion", async () => {
    const { app, token } = makeApp();
    const res = await postRpc(app, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  test("initialize falls back to the latest version for an unsupported client version", async () => {
    const { app, token } = makeApp();
    const res = await postRpc(app, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2026-07-28", capabilities: {} },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });

  test("initialize without params falls back to the latest version", async () => {
    const { app, token } = makeApp();
    const res = await postRpc(app, token, { jsonrpc: "2.0", id: 3, method: "initialize" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-11-25");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("nano-symphony");
  });

  test("notifications/initialized is acknowledged with 202 and no JSON-RPC error", async () => {
    const { app, token } = makeApp();
    const res = await postRpc(app, token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("other notifications are tolerated with 202", async () => {
    const { app, token } = makeApp();
    const res = await postRpc(app, token, { jsonrpc: "2.0", method: "notifications/cancelled", params: {} });
    expect(res.status).toBe(202);
  });

  test("unknown non-notification method still returns -32601", async () => {
    const { app, token } = makeApp();
    const res = await postRpc(app, token, { jsonrpc: "2.0", id: 4, method: "resources/list" });
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
  });

  test("initialize still requires a valid token", async () => {
    const { app } = makeApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });
});
