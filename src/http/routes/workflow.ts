import { Hono } from "hono";
import fs from "fs/promises";
import path from "path";
import type { Tracker } from "../../db/tracker.ts";
import type { Workflow } from "../../workflow/types.ts";
import { loadWorkflow } from "../../workflow/loader.ts";
import { config } from "../../config.ts";
import { bus } from "../../db/event_bus.ts";

export function createWorkflowRoutes(
  _tracker: Tracker,
  _getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  _triggerTick: () => void,
  options?: {
    reloadWorkflow?: () => { workflow: Workflow; template: string } | null;
  },
): Hono {
  const app = new Hono();

  app.get("/workflow", async (c) => {
    try { return c.json({ content: await fs.readFile(config.WORKFLOW_PATH, "utf-8") }); } catch { return c.json({ content: "" }); }
  });

  app.post("/workflow/validate", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { content?: string };
    if (typeof body.content !== "string") {
      return c.json({ ok: false, error: "content must be a string" }, 400);
    }
    try {
      // Write to a temp file so loadWorkflow can parse the front matter + template.
      const tmpPath = path.join(process.cwd(), ".symphony", `workflow-validate-${Date.now()}.md`);
      await fs.mkdir(path.dirname(tmpPath), { recursive: true });
      await fs.writeFile(tmpPath, body.content, "utf-8");
      try {
        loadWorkflow(tmpPath);
        return c.json({ ok: true });
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 400);
    }
  });

  app.put("/workflow", async (c) => {
    const { content } = await c.req.json() as { content: string };
    await fs.writeFile(config.WORKFLOW_PATH, content, "utf-8");
    // Sync reload after write — watcher is only a fallback.
    if (options?.reloadWorkflow) {
      const result = options.reloadWorkflow();
      if (result) {
        bus.emit("event", { kind: "workflow_reloaded", ts: Date.now(), issue_uuid: null, message: "workflow reloaded via PUT /workflow", payload_json: null });
      } else {
        bus.emit("event", { kind: "workflow_reload_failed", ts: Date.now(), issue_uuid: null, message: "workflow reload failed after PUT /workflow", payload_json: null });
      }
    }
    return c.json({ ok: true });
  });

  return app;
}
