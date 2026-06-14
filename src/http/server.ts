import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "fs";
import fs from "fs/promises";
import { resolve, join } from "path";
import { timingSafeEqual } from "crypto";
import { createRoutes } from "./routes.ts";
import { createMcpRouter } from "../mcp/server.ts";
import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";
import { FRONTEND_DIST } from "../paths.ts";

/** Constant-time string comparison to prevent timing attacks. */
function isTokenValid(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createHttpServer(
  tracker: Tracker,
  getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  triggerTick: () => void,
  options?: {
    reloadWorkflow?: () => { workflow: Workflow; template: string } | null;
    apiToken?: string;
    getConcurrencyStatus?: () => { limit: number; available: number; active: number };
  },
): Hono {
  // S1: Always enforce control-plane auth. If no token is provided, auto-generate
  // a random one so the control plane is never open by default.
  const apiToken = options?.apiToken ?? crypto.randomUUID();
  const app = new Hono();
  app.route("/mcp", createMcpRouter(tracker, getWorkflow));

  // S1: Auth middleware for /api/v1/* — always enforced regardless of binding address.
  // /api/v1/health is exempt (read-only, no sensitive data).
  app.use("/api/v1/*", async (c, next) => {
    if (c.req.path === "/api/v1/health") return next();

    // Accept: Authorization: ****** or X-Symphony-Token: <token> header,
    // or ?token= query param (needed for EventSource which cannot set headers).
    const authHeader = c.req.header("Authorization");
    const symphonyHeader = c.req.header("X-Symphony-Token");
    const queryToken = c.req.query("token");
    const provided =
      authHeader?.startsWith("Bearer ") ? authHeader.slice(7)
      : symphonyHeader ?? queryToken ?? "";

    if (!isTokenValid(provided, apiToken)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  app.route("/api/v1", createRoutes(tracker, getWorkflow, triggerTick, options));

  const staticRoot = FRONTEND_DIST;
  const indexPath = resolve(join(staticRoot, "index.html"));
  const distExists = existsSync(indexPath);

  if (distExists) {
    // Serve hashed build assets and favicon directly (no token needed).
    app.use("/assets/*", serveStatic({ root: staticRoot }));
    app.use("/favicon.svg", serveStatic({ root: staticRoot }));

    // All other paths (including /): serve index.html with injected API token.
    app.get("*", async (c) => {
      if (c.req.path.includes("/.well-known/")) return c.notFound();
      try {
        const html = await fs.readFile(indexPath, "utf-8");
        const injected = apiToken
          ? html.replace(
              "</head>",
              `<script>window.__SYMPHONY_API_TOKEN__=${JSON.stringify(apiToken)}</script></head>`,
            )
          : html;
        return c.html(injected);
      } catch {
        return c.notFound();
      }
    });
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
