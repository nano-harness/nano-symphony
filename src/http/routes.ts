import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "fs/promises";
import path from "path";
import { nanoid } from "nanoid";
import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";
import { config } from "../config.ts";
import { z } from "zod";

const IssueCreateSchema = z.object({
  id: z.string().optional(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().optional(),
  priority: z.enum(["urgent", "high", "medium", "low"]).default("medium"),
  state: z.string(),
  branch: z.string().optional(),
  url: z.string().optional(),
  labels: z.array(z.string()).default([]),
});

export function createRoutes(
  tracker: Tracker,
  _getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  triggerTick: () => void
): Hono {
  const app = new Hono();

  app.get("/issues", (c) => {
    const state = c.req.query("state");
    const issues = tracker.listIssues(state ? { state } : undefined);
    return c.json(issues);
  });

  app.get("/issues/:id", (c) => {
    const issue = tracker.getIssue(c.req.param("id"));
    if (!issue) return c.json({ error: "Not found" }, 404);
    return c.json(issue);
  });

  app.post("/issues", async (c) => {
    const body = await c.req.json();
    const parsed = IssueCreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const issue = { ...parsed.data, id: parsed.data.id ?? nanoid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    tracker.insertIssue(issue);
    triggerTick(); // Kick orchestrator on new issue
    return c.json(tracker.getIssue(issue.id), 201);
  });

  app.put("/issues/:id", async (c) => {
    const existing = tracker.getIssue(c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json() as Record<string, unknown>;
    tracker.insertIssue({ ...existing, ...body, id: existing.id, updated_at: new Date().toISOString() } as Parameters<typeof tracker.insertIssue>[0]);
    triggerTick(); // Kick orchestrator on issue update
    return c.json(tracker.getIssue(existing.id));
  });

  app.get("/runs", (c) => c.json(tracker.getActiveRuns()));

  app.get("/runs/:issueId", (c) => {
    const run = tracker.getRun(c.req.param("issueId"));
    if (!run) return c.json({ error: "Not found" }, 404);
    return c.json(run);
  });

  app.get("/events", (c) => {
    const since = c.req.query("since");
    return c.json(tracker.getEvents(since ? Number(since) : undefined));
  });

  app.get("/events/stream", (c) => {
    return streamSSE(c, async (stream) => {
      let lastTs = Date.now();
      while (true) {
        const events = tracker.getEvents(lastTs);
        for (const ev of events) {
          await stream.writeSSE({ data: JSON.stringify(ev), event: ev.kind, id: ev.id });
          lastTs = Math.max(lastTs, ev.ts);
        }
        await stream.sleep(2000);
      }
    });
  });

  app.post("/runs/:issueId/cancel", (c) => { tracker.releaseIssue(c.req.param("issueId"), "cancelled"); return c.json({ ok: true }); });
  app.post("/runs/:issueId/pause", (c) => { tracker.releaseIssue(c.req.param("issueId"), "paused"); return c.json({ ok: true }); });
  app.post("/runs/:issueId/resume", (c) => { tracker.releaseIssue(c.req.param("issueId"), "released"); return c.json({ ok: true }); });

  app.get("/workflow", async (c) => {
    try { return c.json({ content: await fs.readFile(config.WORKFLOW_PATH, "utf-8") }); } catch { return c.json({ content: "" }); }
  });

  app.put("/workflow", async (c) => {
    const { content } = await c.req.json() as { content: string };
    await fs.writeFile(config.WORKFLOW_PATH, content, "utf-8");
    return c.json({ ok: true });
  });

  app.get("/logs/:issueId/:attempt", (c) => {
    const { issueId, attempt } = c.req.param();
    return streamSSE(c, async (stream) => {
      const issue = tracker.getIssue(issueId);
      if (!issue) { await stream.writeSSE({ data: "Issue not found", event: "error" }); return; }
      const run = tracker.getActiveRuns().find((r) => r.issue_id === issueId);
      const wsPath = run?.workspace_path;
      if (!wsPath) { await stream.writeSSE({ data: "No workspace found", event: "error" }); return; }
      const logPath = path.join(wsPath, "logs", `attempt-${attempt}.log`);
      let offset = 0;
      while (true) {
        try {
          const content = await fs.readFile(logPath, "utf-8");
          if (content.length > offset) { await stream.writeSSE({ data: content.slice(offset), event: "log" }); offset = content.length; }
        } catch { /* file not ready */ }
        await stream.sleep(1000);
      }
    });
  });

  return app;
}
