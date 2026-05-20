import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "fs/promises";
import path from "path";
import { nanoid } from "nanoid";
import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";
import { config } from "../config.ts";
import { z } from "zod";
import { nullishString } from "./schemas.ts";

const IDENT_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const VALID_STATES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const;

const IssueCreateSchema = z.object({
  id: nullishString(),
  identifier: z.string().regex(IDENT_RE, "identifier must look like DEMO-1").optional(),
  title: z.string().min(1, "title is required").max(200),
  description: nullishString({ max: 20000 }),
  priority: z.enum(["urgent", "high", "medium", "low"]).default("medium"),
  state: z.enum(VALID_STATES),
  branch: nullishString(),
  url: nullishString(),
  workspace_path: nullishString({ max: 1024 }),
  labels: z.array(z.string()).default([]),
});

const IssueUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: nullishString({ max: 20000 }),
  priority: z.enum(["urgent", "high", "medium", "low"]).optional(),
  state: z.enum(VALID_STATES).optional(),
  branch: nullishString(),
  url: nullishString(),
  workspace_path: nullishString({ max: 1024 }),
  labels: z.array(z.string()).optional(),
}).strict(); // Reject unexpected fields like identifier or id

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
    const { identifier: providedIdent, id: providedId, ...rest } = parsed.data;
    const identifier = providedIdent ?? `TASK-${tracker.getNextTaskNumber()}`;
    const issue = { ...rest, identifier, id: providedId ?? nanoid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    tracker.insertIssue(issue);
    triggerTick(); // Kick orchestrator on new issue
    return c.json(tracker.getIssue(issue.id), 201);
  });

  app.put("/issues/:id", async (c) => {
    const existing = tracker.getIssue(c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);
    const parsed = IssueUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    tracker.insertIssue({
      ...existing,
      ...parsed.data,
      id: existing.id,
      updated_at: new Date().toISOString(),
    } as Parameters<typeof tracker.insertIssue>[0] & { updated_at: string });
    triggerTick(); // Kick orchestrator on issue update
    return c.json(tracker.getIssue(existing.id));
  });

  app.delete("/issues/:id", (c) => {
    const ok = tracker.deleteIssue(c.req.param("id"));
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
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
      let lastWriteTs = Date.now();
      while (true) {
        const events = tracker.getEvents(lastTs);
        for (const ev of events) {
          await stream.writeSSE({ data: JSON.stringify(ev), id: ev.id });
          lastTs = Math.max(lastTs, ev.ts);
          lastWriteTs = Date.now();
        }
        if (Date.now() - lastWriteTs > 15_000) {
          await stream.writeSSE({ data: "", event: "ping" });
          lastWriteTs = Date.now();
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
      if (!wsPath) {
        await stream.writeSSE({ data: "No workspace found", event: "error" });
        return; // Exit SSE callback to close connection
      }
      const logPath = path.join(wsPath, "logs", `attempt-${attempt}.log`);
      let offset = 0;
      let lastWriteTs = Date.now();
      const startTime = Date.now();
      const MAX_WAIT_MS = 30_000; // 30s timeout waiting for log file
      while (true) {
        try {
          const content = await fs.readFile(logPath, "utf-8");
          if (content.length > offset) {
            await stream.writeSSE({ data: content.slice(offset), event: "log" });
            offset = content.length;
            lastWriteTs = Date.now();
          }
        } catch {
          // file not ready - check timeout
          if (Date.now() - startTime > MAX_WAIT_MS && offset === 0) {
            await stream.writeSSE({ data: "Log file not found after 30s", event: "error" });
            return;
          }
        }
        if (Date.now() - lastWriteTs > 15_000) {
          await stream.writeSSE({ data: "", event: "ping" });
          lastWriteTs = Date.now();
        }
        await stream.sleep(1000);
      }
    });
  });

  // Handoff review endpoints
  app.get("/issues/:id/handoff", (c) => {
    const events = tracker.getEvents();
    const handoffEvent = events.filter((e) => e.issue_id === c.req.param("id") && e.kind === "handoff").sort((a, b) => b.ts - a.ts)[0];
    if (!handoffEvent) return c.json({ error: "No handoff yet" }, 404);
    return c.json({ ...handoffEvent, payload: JSON.parse(handoffEvent.payload_json ?? "{}") });
  });

  app.post("/issues/:id/approve", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    tracker.updateIssueState(id, "done");
    tracker.updateLastIssueState(id, "done");
    tracker.recordEvent(id, "approved", body.note ?? "Approved by reviewer", { note: body.note });
    return c.json({ ok: true });
  });

  app.post("/issues/:id/request-changes", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as { note: string };
    if (!body?.note?.trim()) return c.json({ error: "note is required" }, 400);
    tracker.updateIssueState(id, "todo");
    tracker.updateLastIssueState(id, "todo");
    tracker.recordEvent(id, "revision_requested", body.note, { note: body.note });
    triggerTick();
    return c.json({ ok: true });
  });

  app.post("/issues/:id/reveal-workspace", async (c) => {
    if (!config.ALLOW_REVEAL_WORKSPACE) return c.json({ error: "disabled" }, 403);
    const run = tracker.getRun(c.req.param("id"));
    if (!run?.workspace_path) return c.json({ error: "no workspace" }, 404);
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    Bun.spawn([cmd, run.workspace_path]);
    return c.json({ ok: true, path: run.workspace_path });
  });

  app.get("/workspaces/:id/file", async (c) => {
    const run = tracker.getRun(c.req.param("id"));
    if (!run?.workspace_path) return c.json({ error: "no workspace" }, 404);
    const rel = c.req.query("path") ?? "";
    const full = path.resolve(run.workspace_path, rel);
    if (!full.startsWith(path.resolve(run.workspace_path) + path.sep)) {
      return c.json({ error: "path escape denied" }, 403);
    }
    try {
      const data = await fs.readFile(full);
      return new Response(data);
    } catch {
      return c.json({ error: "file not found" }, 404);
    }
  });

  return app;
}
