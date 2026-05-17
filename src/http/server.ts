import { Hono } from "hono";
import { createRoutes } from "./routes.ts";
import { createMcpRouter } from "../mcp/server.ts";
import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";

export function createHttpServer(
  tracker: Tracker,
  getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  triggerTick: () => void
): Hono {
  const app = new Hono();
  app.route("/mcp", createMcpRouter(tracker, getWorkflow));
  app.route("/api/v1", createRoutes(tracker, getWorkflow, triggerTick));
  return app;
}
