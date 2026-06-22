import { Hono } from "hono";
import fs from "fs/promises";
import path from "path";
import type { Tracker } from "../../db/tracker.ts";
import type { Workflow } from "../../workflow/types.ts";

export function createWorkspaceRoutes(
  tracker: Tracker,
  _getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  _triggerTick: () => void,
  _options?: Record<string, unknown>,
): Hono {
  const app = new Hono();

  app.get("/workspaces/:uuid/file", async (c) => {
    const run = tracker.getRun(c.req.param("uuid")!);
    if (!run?.workspace_path) return c.json({ error: "no workspace" }, 404);
    const rel = c.req.query("path") ?? "";
    const full = path.resolve(run.workspace_path, rel);
    // Resolve all symlinks before checking containment to prevent symlink escape.
    try {
      const [realFull, realWorkspace] = await Promise.all([
        fs.realpath(full),
        fs.realpath(run.workspace_path),
      ]);
      if (!realFull.startsWith(realWorkspace + path.sep) && realFull !== realWorkspace) {
        return c.json({ error: "path escape denied" }, 403);
      }
      const data = await fs.readFile(realFull);
      return new Response(data);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return c.json({ error: "file not found" }, 404);
      if (code === "EACCES") return c.json({ error: "access denied" }, 403);
      return c.json({ error: "file not found" }, 404);
    }
  });

  return app;
}
