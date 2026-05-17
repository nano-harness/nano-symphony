import { Hono } from "hono";
import { verifyToken } from "./auth.ts";
import { handleTool, TOOL_DEFINITIONS } from "./tools.ts";
import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";

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
          serverInfo: { name: "nano-symphony", version: "0.1.0" },
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
      try {
        const wf = getWorkflow();
        const result = await handleTool(
          name,
          args,
          auth.issueId,
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

  app.get("/sse", (c) => {
    const token = c.req.header("X-Symphony-Token") ?? c.req.query("token");
    if (!token) return c.text("Unauthorized", 401);
    const auth = verifyToken(token);
    if (!auth) return c.text("Forbidden", 403);

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(": ping\n\n"));
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      }
    );
  });

  return app;
}
