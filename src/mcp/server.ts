import { Hono } from "hono";
import { readFileSync } from "fs";
import { verifyToken } from "./auth.ts";
import { handleTool, TOOL_DEFINITIONS } from "./tools.ts";
import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";

// Read version from package.json so the MCP serverInfo stays in sync with releases.
const PACKAGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(`${import.meta.dir}/../../package.json`, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export function createMcpRouter(
  tracker: Tracker,
  getWorkflow: () => { workflow: Workflow; template: string } | undefined
): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const token = c.req.header("X-Symphony-Token");
    if (!token) return c.json({ error: "Missing token" }, 401);

    const auth = verifyToken(token);
    if (!auth) return c.json({ error: "Invalid token" }, 403);

    const body = await c.req.json() as { method: string; id: unknown; params?: { name?: string; arguments?: unknown } };

    if (body.method === "initialize") {
      return c.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "nano-symphony", version: PACKAGE_VERSION },
        },
      });
    }

    if (body.method === "tools/list") {
      return c.json({ jsonrpc: "2.0", id: body.id, result: { tools: TOOL_DEFINITIONS } });
    }

    if (body.method === "tools/call") {
      const { name, arguments: args } = body.params ?? {};
      if (!name) {
        return c.json({ jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "Missing tool name" } });
      }
      // S6: Enforce scope — only allow tools the token is authorized to call.
      if (!auth.scope.has(name)) {
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32603, message: `Tool '${name}' is not authorized for this token` },
        });
      }
      try {
        const wf = getWorkflow();
        const result = await handleTool(
          name,
          args,
          auth.issueUuid,
          auth.attempt,
          tracker,
          wf ? { template: wf.template } : undefined
        );
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message } });
      }
    }

    return c.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  });

  return app;
}
