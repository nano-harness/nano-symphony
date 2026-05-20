import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "fs";
import { resolve, join } from "path";
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

  const staticRoot = process.env.SYMPHONY_STATIC_ROOT ?? "./frontend/dist";
  const indexPath = resolve(join(staticRoot, "index.html"));
  const distExists = existsSync(indexPath);

  if (distExists) {
    app.use("/*", serveStatic({ root: staticRoot }));
    app.get("*", serveStatic({ path: join(staticRoot, "index.html") })); // SPA fallback
  } else {
    app.get("/", (c) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>nano-symphony</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;max-width:680px;margin:8vh auto;padding:0 24px;color:#222}code{background:#f4f4f5;padding:2px 6px;border-radius:4px}</style>
<h1>Dashboard not built</h1>
<p>The backend is running, but <code>frontend/dist/index.html</code> was not found at <code>${indexPath}</code>.</p>
<p>Run <code>symphony build</code> (or <code>cd frontend && bun run build</code>) and restart, then reload this page.</p>
<p>API is reachable at <a href="/api/v1/issues">/api/v1/issues</a>.</p>`,
        503
      )
    );
  }

  return app;
}
