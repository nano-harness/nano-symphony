import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "fs/promises";
import { watch } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";
import { loadWorkflow } from "../workflow/loader.ts";
import { config } from "../config.ts";
import { z } from "zod";
import { nullishString } from "./schemas.ts";
import { bus } from "../db/event_bus.ts";
import type { SymphonyEvent, SymphonyRun, IssueMetrics } from "../db/tracker.ts";
import type { RunPatch } from "../db/event_bus.ts";
import { cancelAgent, getActiveProcessCount } from "../spawner/index.ts";
import { removeWorkspace } from "../workspace/manager.ts";
import type { PlanRunState } from "../db/tracker-plan-runs.ts";
import { renderMetrics, incCounter } from "../metrics.ts";
import { computePlanDiff, type PlanPayload } from "./plan-diff.ts";
import { computePlanGraph } from "./plan-graph.ts";

const VALID_STATES = ["backlog", "todo", "awaiting_plan", "planning", "plan_review", "in_progress", "in_review", "done", "cancelled"] as const;
const AgentKindEnum = z.enum(["nano", "claude-code"]).nullable().optional();
const AGENT_BINARIES: Record<string, string> = { nano: "nano", "claude-code": "claude" };
const PLAN_RUN_STATES = ["pending", "dry_running", "awaiting_approval", "running", "done", "failed", "cancelled"] as const;
const PlanRunStateEnum = z.enum(PLAN_RUN_STATES);

// Slash command pattern for comment-based approve directive
const CMD_APPROVE_RE = /^\/(?:approve|lgtm|execute)\b/i;
const CMD_REVISE_RE = /^\/revise(?:\s+(.*\S))?\s*$/i;
const CMD_SKIP_PLAN_RE = /^\/skip-plan\b/i;

// SSE connection limit to prevent listener accumulation
const MAX_SSE_CONNECTIONS = 50;
let activeSSECount = 0;

const IssueCreateSchema = z.object({
  title: z.string().min(1, "title is required").max(200),
  identifier: z.string().min(1).max(64).nullable().optional(),
  description: nullishString({ max: 20000 }),
  priority: z.enum(["urgent", "high", "medium", "low"]).default("medium"),
  state: z.enum(VALID_STATES),
  branch: nullishString(),
  url: nullishString(),
  workspace_path: nullishString({ max: 1024 }),
  agent_kind: AgentKindEnum,
  agent_binary: nullishString({ max: 256 }),
  agent_role: nullishString({ max: 64 }),
  require_plan: z.boolean().nullable().optional(),
  cost_budget_usd: z.number().min(0).nullable().optional(),
  token_budget: z.number().int().min(0).nullable().optional(),
  labels: z.array(z.string()).default([]),
}).strict();

const IssueUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  identifier: z.string().min(1).max(64).nullable().optional(),
  description: nullishString({ max: 20000 }),
  priority: z.enum(["urgent", "high", "medium", "low"]).optional(),
  state: z.enum(VALID_STATES).optional(),
  branch: nullishString(),
  url: nullishString(),
  workspace_path: nullishString({ max: 1024 }),
  agent_kind: AgentKindEnum,
  agent_binary: nullishString({ max: 256 }),
  agent_role: nullishString({ max: 64 }),
  require_plan: z.boolean().nullable().optional(),
  cost_budget_usd: z.number().min(0).nullable().optional(),
  token_budget: z.number().int().min(0).nullable().optional(),
  labels: z.array(z.string()).optional(),
}).strict();

const RequestChangesSchema = z.object({
  note: z.string().trim().min(1, "note is required").max(8000),
  feedback: z.object({
    category: z.enum(["scope", "approach", "estimate", "missing_tests", "other"]),
    severity: z.enum(["minor", "major", "blocking"]),
    must_fix: z.array(z.string().trim().min(1)).max(20).optional(),
  }).optional(),
}).strict();

const PlanRevisionFeedbackSchema = z.object({
  category: z.enum(["scope", "approach", "estimate", "missing_tests", "other"]),
  severity: z.enum(["minor", "major", "blocking"]),
  must_fix: z.array(z.string().trim().min(1)).max(20).optional(),
});

export function createRoutes(
  tracker: Tracker,
  _getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  triggerTick: () => void,
  options?: {
    reloadWorkflow?: () => { workflow: Workflow; template: string } | null;
    getConcurrencyStatus?: () => { limit: number; available: number; active: number };
  },
): Hono {
  const app = new Hono();
  const startedAt = Date.now();

  function releaseForReschedule(uuid: string): void {
    const run = tracker.getRun(uuid);
    if (run && run.last_state !== "released") tracker.releaseIssue(uuid, "released");
  }

  function approvePlan(uuid: string, note?: string): { ok: boolean; state?: string; error?: string } {
    const issue = tracker.getIssue(uuid);
    if (!issue) return { ok: false, error: "Not found" };
    if (issue.state !== "plan_review") return { ok: false, error: "Issue is not in plan_review state" };
    tracker.updateIssueState(uuid, "in_progress");
    const planEvent = tracker.getLatestEventByKind(uuid, "plan_submitted");
    if (planEvent) {
      const payload = JSON.parse(planEvent.payload_json ?? "{}") as { estimates?: Record<string, unknown> };
      if (payload.estimates) tracker.updateIssuePlanEstimates(uuid, payload.estimates);
    }
    tracker.recordEvent(uuid, "plan_approved", note ?? "Plan approved", { note });
    releaseForReschedule(uuid);
    triggerTick();
    return { ok: true, state: "in_progress" };
  }

  function revisePlan(
    uuid: string,
    note: string,
    feedback?: z.infer<typeof PlanRevisionFeedbackSchema>,
  ): { ok: boolean; state?: string; error?: string } {
    const issue = tracker.getIssue(uuid);
    if (!issue) return { ok: false, error: "Not found" };
    if (issue.state !== "plan_review") return { ok: false, error: "Issue is not in plan_review state" };
    tracker.updateIssueState(uuid, "planning");
    tracker.recordEvent(uuid, "plan_revision_requested", note, { note, feedback });
    releaseForReschedule(uuid);
    triggerTick();
    return { ok: true, state: "planning" };
  }

  app.get("/metrics", (c) => {
    // Snapshot current entity counts so /metrics always reflects the DB state.
    const issues = tracker.listIssues();
    const planRuns = tracker.listPlanRuns();
    incCounter("symphony_issues_total", {}, issues.length);
    incCounter("symphony_plan_runs_total", {}, planRuns.length);
    for (const state of ["todo", "in_progress", "in_review", "done", "cancelled"]) {
      const count = issues.filter((i) => i.state === state).length;
      incCounter("symphony_issues_total", { state }, count);
    }
    for (const state of ["pending", "dry_running", "awaiting_approval", "running", "done", "failed", "cancelled"]) {
      const count = planRuns.filter((r) => r.state === state).length;
      incCounter("symphony_plan_runs_total", { state }, count);
    }
    const concurrency = options?.getConcurrencyStatus?.() ?? { limit: 0, available: 0, active: 0 };
    incCounter("symphony_concurrency_limit", {}, concurrency.limit);
    incCounter("symphony_concurrency_available", {}, concurrency.available);
    incCounter("symphony_concurrency_active", {}, concurrency.active);
    return c.text(renderMetrics(), 200, { "Content-Type": "text/plain; version=0.0.4" });
  });

  app.get("/metrics/summary", (c) => c.json(tracker.getMetricsSummary()));

  app.get("/metrics/export", (c) => {
    const format = c.req.query("format") ?? "json";
    const metrics = tracker.listIssueMetrics();
    if (format === "csv") {
      const headers: (keyof IssueMetrics)[] = [
        "issue_uuid", "final_state", "attempts", "sessions", "cost_usd",
        "input_tokens", "output_tokens", "duration_ms", "blocked", "recorded_at",
      ];
      const escapeCsv = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, "\"\"")}"` : v;
      const rows = metrics.map((m) => headers.map((h) => escapeCsv(String(m[h]))).join(","));
      const csv = [headers.join(","), ...rows].join("\n") + "\n";
      return c.text(csv, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"symphony-metrics.csv\"",
      });
    }
    if (format === "json") {
      return c.json({ exported_at: Date.now(), count: metrics.length, metrics });
    }
    return c.json({ error: "Invalid format; use json or csv" }, 400);
  });

  app.get("/issues/:uuid/metrics", (c) => {
    const uuid = c.req.param("uuid");
    const issue = tracker.getIssue(uuid);
    if (!issue) return c.json({ error: "Not found" }, 404);
    const metrics = tracker.getIssueMetrics(uuid);
    if (!metrics) return c.json({ error: "No metrics recorded yet" }, 404);
    return c.json(metrics);
  });

  app.get("/health", (c) => {
    const workflowLoaded = _getWorkflow() !== undefined;
    const inflightAgents = getActiveProcessCount();
    const issues = tracker.listIssues();
    const queueDepth = issues.filter((i) =>
      !["done", "cancelled", "backlog"].includes(i.state)
    ).length;

    const status = workflowLoaded ? "ok" : "degraded";

    const available_agents: string[] = [];
    for (const [kind, bin] of Object.entries(AGENT_BINARIES)) {
      if (Bun.which(bin)) available_agents.push(kind);
    }

    const concurrency = options?.getConcurrencyStatus?.() ?? { limit: 0, available: 0, active: 0 };

    return c.json({
      status,
      orchestrator_running: true,
      db_reachable: true,
      workflow_loaded: workflowLoaded,
      inflight_agents: inflightAgents,
      queue_depth: queueDepth,
      concurrency_limit: concurrency.limit,
      concurrency_available: concurrency.available,
      concurrency_active: concurrency.active,
      uptime_ms: Date.now() - startedAt,
      available_agents,
    });
  });

  app.get("/issues", (c) => {
    const state = c.req.query("state");
    const issues = tracker.listIssues(state ? { state } : undefined);
    return c.json(issues);
  });

  app.get("/issues/:uuid", (c) => {
    const issue = tracker.resolveIssue(c.req.param("uuid"));
    if (!issue) return c.json({ error: "Not found" }, 404);
    return c.json(issue);
  });

  app.post("/issues", async (c) => {
    const body = await c.req.json();
    if (typeof body === "object" && body !== null && ("id" in body || "uuid" in body)) {
      return c.json({ error: "fields 'id' and 'uuid' are not accepted; server auto-generates uuid and defaults identifier to TASK-N" }, 400);
    }
    const parsed = IssueCreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const uuid = nanoid();
    const inserted = tracker.insertIssue({ ...parsed.data, uuid });
    triggerTick(); // Kick orchestrator on new issue
    return c.json(inserted, 201);
  });

  app.put("/issues/:uuid", async (c) => {
    const existing = tracker.getIssue(c.req.param("uuid"));
    if (!existing) return c.json({ error: "Not found" }, 404);
    const parsed = IssueUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const updated = tracker.updateIssue(existing.uuid, {
      ...parsed.data,
      title: parsed.data.title ?? existing.title,
      state: parsed.data.state ?? existing.state,
      updated_at: new Date().toISOString(),
    });
    triggerTick(); // Kick orchestrator on issue update
    return c.json(updated);
  });

  app.delete("/issues/:uuid", async (c) => {
    const result = tracker.deleteIssue(c.req.param("uuid"));
    if (!result.deleted) return c.json({ error: "Not found" }, 404);

    if (result.workspace?.path) {
      const workflow = _getWorkflow();
      const hooks = workflow?.workflow.workspace?.hooks;
      const hookEnv: Record<string, string> = {
        SYMPHONY_ISSUE_UUID: c.req.param("uuid"),
        SYMPHONY_WORKSPACE: result.workspace.path,
        SYMPHONY_WORKSPACE_MANAGED: result.workspace.managed ? "1" : "0",
      };
      const cleanup = await removeWorkspace(
        result.workspace.path,
        result.workspace.managed,
        hooks ? { before_remove: hooks.before_remove } : undefined,
        hookEnv,
      );
      if (!cleanup.removed) {
        console.warn(`[delete-issue] workspace not removed: ${cleanup.reason}`);
      }
    }

    return c.json({ ok: true });
  });

  app.get("/runs", (c) => c.json(tracker.getActiveRuns()));

  app.get("/runs/:issueUuid", (c) => {
    const run = tracker.getRun(c.req.param("issueUuid"));
    if (!run) return c.json({ error: "Not found" }, 404);
    return c.json(run);
  });

  app.get("/events", (c) => {
    const since = c.req.query("since");
    return c.json(tracker.getEvents(since ? Number(since) : undefined));
  });

  app.get("/events/stream", (c) => {
    if (activeSSECount >= MAX_SSE_CONNECTIONS) {
      return c.json({ error: "Too many SSE connections" }, 503);
    }
    // Increment before entering streamSSE so the check above is consistent.
    activeSSECount++;
    return streamSSE(c, async (stream) => {
      // Support Last-Event-ID for reconnection catch-up
      const lastEventId = c.req.header("Last-Event-ID");
      const querySince = c.req.query("since");
      const since = lastEventId ? Number(lastEventId) : (querySince ? Number(querySince) : undefined);

      // Catch up with historical events if since is provided
      if (since !== undefined) {
        const events = tracker.getEvents(since);
        for (const ev of events) {
          await stream.writeSSE({ data: JSON.stringify(ev), id: String(ev.ts), event: "message" });
        }
      }

      let lastWriteTs = Date.now();

      // Listen to bus events
      const onEvent = async (event: SymphonyEvent) => {
        try {
          await stream.writeSSE({ data: JSON.stringify(event), id: String(event.ts), event: "message" });
          lastWriteTs = Date.now();
        } catch (e) {
          // Stream closed, cleanup will happen in abort handler
        }
      };

      const onRun = async (patch: RunPatch) => {
        try {
          await stream.writeSSE({ data: JSON.stringify(patch), event: "run" });
          lastWriteTs = Date.now();
        } catch (e) {
          // Stream closed
        }
      };

      bus.on("event", onEvent);
      bus.on("run", onRun);

      // Heartbeat interval
      const heartbeatInterval = setInterval(async () => {
        if (Date.now() - lastWriteTs > 10_000) {
          try {
            await stream.writeSSE({ data: "", event: "ping" });
            lastWriteTs = Date.now();
          } catch (e) {
            // Stream closed
          }
        }
      }, 10_000);

      // Cleanup on abort
      c.req.raw.signal.addEventListener("abort", () => {
        activeSSECount--;
        bus.off("event", onEvent);
        bus.off("run", onRun);
        clearInterval(heartbeatInterval);
      });

      // Keep stream alive indefinitely
      await new Promise(() => {});
    });
  });

  app.post("/runs/:issueUuid/cancel", (c) => {
    const issueUuid = c.req.param("issueUuid");
    cancelAgent(issueUuid); // Kill the process first (no-op if not running)
    tracker.releaseIssue(issueUuid, "cancelled");
    return c.json({ ok: true });
  });
  app.post("/runs/:issueUuid/pause", (c) => { tracker.releaseIssue(c.req.param("issueUuid"), "paused"); return c.json({ ok: true }); });
  app.post("/runs/:issueUuid/resume", (c) => { tracker.releaseIssue(c.req.param("issueUuid"), "released"); return c.json({ ok: true }); });

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

  app.get("/logs/:issueUuid/:attempt", (c) => {
    const { issueUuid, attempt: attemptParam } = c.req.param();
    return streamSSE(c, async (stream) => {
      const issue = tracker.getIssue(issueUuid);
      if (!issue) {
        await stream.writeSSE({ data: "Issue not found", event: "error" });
        return;
      }

      const run = tracker.getRun(issueUuid);
      const wsPath = run?.workspace_path;
      if (!wsPath) {
        await stream.writeSSE({ data: "No workspace found", event: "error" });
        return;
      }

      // Support "current" as attempt parameter
      let attempt = attemptParam;
      if (attempt === "current" && run?.current_attempt !== null && run?.current_attempt !== undefined) {
        attempt = String(run.current_attempt);
      }

      const logPath = path.join(wsPath, "logs", `attempt-${attempt}.log`);
      let offset = 0;
      let lastWriteTs = Date.now();
      let watcher: ReturnType<typeof watch> | null = null;

      const TERMINAL_STATES = new Set(["released", "cancelled", "done", "abandoned"]);

      // Helper to check if run is in terminal state
      const isTerminal = () => {
        const currentRun = tracker.getRun(issueUuid);
        return currentRun && TERMINAL_STATES.has(currentRun.last_state);
      };

      // Helper to read and send incremental log content
      const readAndSend = async () => {
        try {
          const content = await fs.readFile(logPath, "utf-8");
          if (content.length > offset) {
            await stream.writeSSE({ data: content.slice(offset), event: "log" });
            offset = content.length;
            lastWriteTs = Date.now();
            return true;
          }
        } catch {
          // File not ready yet
        }
        return false;
      };

      // Setup fs.watch on the logs directory
      try {
        const logsDir = path.dirname(logPath);
        watcher = watch(logsDir, async (eventType, filename) => {
          if (filename === path.basename(logPath)) {
            await readAndSend();
          }
        });
      } catch {
        // fs.watch not available, will use polling
      }

      // Polling loop
      const pollInterval = setInterval(async () => {
        await readAndSend();

        // Send heartbeat if no activity
        if (Date.now() - lastWriteTs > 5_000) {
          try {
            await stream.writeSSE({ data: "", event: "ping" });
            lastWriteTs = Date.now();
          } catch (e) {
            // Stream closed
          }
        }

        // Check for terminal state
        if (isTerminal()) {
          // Wait 1 second for final writes, then send end event
          setTimeout(async () => {
            const hadNewContent = await readAndSend();
            try {
              await stream.writeSSE({ data: "", event: "end" });
            } catch {
              // Stream already closed
            }
            clearInterval(pollInterval);
            if (watcher) watcher.close();
          }, 1000);
        }
      }, 200);

      // Cleanup on abort
      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(pollInterval);
        if (watcher) watcher.close();
      });

      // Initial read
      await readAndSend();

      // Keep stream alive until terminal state or client disconnect
      await new Promise(() => {});
    });
  });

  // Handoff review endpoints
  app.get("/issues/:uuid/handoff", (c) => {
    const handoffEvent = tracker.getLatestEventByKind(c.req.param("uuid"), "handoff");
    if (!handoffEvent) return c.json({ error: "No handoff yet" }, 404);
    return c.json({ ...handoffEvent, payload: JSON.parse(handoffEvent.payload_json ?? "{}") });
  });

  app.get("/issues/:uuid/plan", (c) => {
    const planEvent = tracker.getLatestEventByKind(c.req.param("uuid"), "plan_submitted");
    if (!planEvent) return c.json({ error: "No plan submitted yet" }, 404);
    return c.json({ ...planEvent, payload: JSON.parse(planEvent.payload_json ?? "{}") });
  });

  app.get("/issues/:uuid/plan-history", (c) => {
    const events = tracker.getEventsByKind(c.req.param("uuid"), "plan_submitted");
    const history = events.map((e) => {
      const payload = JSON.parse(e.payload_json ?? "{}") as PlanPayload;
      return {
        revision: payload.revision,
        ts: e.ts,
        markdown: payload.markdown,
        steps: payload.steps,
        estimates: payload.estimates,
      };
    });
    return c.json({ history });
  });

  app.get("/issues/:uuid/plan-diff", (c) => {
    const fromRevision = Number(c.req.query("from"));
    const toRevision = Number(c.req.query("to"));
    if (!Number.isFinite(fromRevision) || !Number.isFinite(toRevision)) {
      return c.json({ error: "from and to revisions are required" }, 400);
    }
    const events = tracker.getEventsByKind(c.req.param("uuid"), "plan_submitted");
    const fromEvent = events.find((e) => {
      const payload = JSON.parse(e.payload_json ?? "{}") as PlanPayload;
      return payload.revision === fromRevision;
    });
    const toEvent = events.find((e) => {
      const payload = JSON.parse(e.payload_json ?? "{}") as PlanPayload;
      return payload.revision === toRevision;
    });
    if (!fromEvent || !toEvent) {
      return c.json({ error: "One or both revisions not found" }, 404);
    }
    const fromPayload = JSON.parse(fromEvent.payload_json ?? "{}") as PlanPayload;
    const toPayload = JSON.parse(toEvent.payload_json ?? "{}") as PlanPayload;
    return c.json(computePlanDiff(fromPayload, toPayload));
  });

  app.get("/issues/:uuid/plan-graph", (c) => {
    const planEvent = tracker.getLatestEventByKind(c.req.param("uuid"), "plan_submitted");
    if (!planEvent) return c.json({ error: "No plan submitted yet" }, 404);
    const payload = JSON.parse(planEvent.payload_json ?? "{}") as PlanPayload;
    const graph = computePlanGraph(payload.steps);
    return c.json(graph);
  });

  app.post("/issues/:uuid/approve", async (c) => {
    const uuid = c.req.param("uuid");
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    tracker.updateIssueState(uuid, "done");
    tracker.updateLastIssueState(uuid, "done");
    tracker.recordEvent(uuid, "approved", body.note ?? "Approved by reviewer", { note: body.note });
    return c.json({ ok: true });
  });

  app.post("/issues/:uuid/request-changes", async (c) => {
    const uuid = c.req.param("uuid");
    const body = await c.req.json().catch(() => ({}));
    const parsed = RequestChangesSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, 400);
    const { note } = parsed.data;
    tracker.updateIssueState(uuid, "todo");
    tracker.updateLastIssueState(uuid, "todo");
    tracker.recordEvent(uuid, "revision_requested", note, { note });
    triggerTick();
    return c.json({ ok: true });
  });

  app.post("/issues/:uuid/approve-plan", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const result = approvePlan(c.req.param("uuid"), body.note);
    if (!result.ok) {
      return c.json({ error: result.error }, result.error === "Not found" ? 404 : 400);
    }
    return c.json({ ok: true, state: result.state });
  });

  const PlanActualsSchema = z.object({
    actual_turns: z.number().int().min(0).optional(),
    actual_files_touched: z.number().int().min(0).optional(),
    actual_complexity: z.enum(["low", "medium", "high"]).optional(),
  }).strict();

  app.post("/issues/:uuid/actuals", async (c) => {
    const uuid = c.req.param("uuid");
    const issue = tracker.getIssue(uuid);
    if (!issue) return c.json({ error: "Not found" }, 404);
    const parsed = PlanActualsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, 400);
    tracker.updateIssuePlanActuals(uuid, parsed.data);
    return c.json({ ok: true });
  });

  app.post("/issues/:uuid/revise-plan", async (c) => {
    const parsed = RequestChangesSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, 400);
    const result = revisePlan(c.req.param("uuid"), parsed.data.note, parsed.data.feedback);
    if (!result.ok) {
      return c.json({ error: result.error }, result.error === "Not found" ? 404 : 400);
    }
    return c.json({ ok: true, state: result.state });
  });

  app.post("/issues/:uuid/reveal-workspace", async (c) => {
    if (!config.ALLOW_REVEAL_WORKSPACE) return c.json({ error: "disabled" }, 403);
    const run = tracker.getRun(c.req.param("uuid"));
    if (!run?.workspace_path) return c.json({ error: "no workspace" }, 404);
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    Bun.spawn([cmd, run.workspace_path]);
    return c.json({ ok: true, path: run.workspace_path });
  });

  app.get("/workspaces/:uuid/file", async (c) => {
    const run = tracker.getRun(c.req.param("uuid")!);
    if (!run?.workspace_path) return c.json({ error: "no workspace" }, 404);
    const rel = c.req.query("path") ?? "";
    const full = path.resolve(run.workspace_path, rel);
    // S4: Resolve all symlinks before checking containment to prevent symlink escape.
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

  // --- Comments CRUD ---

  const CommentCreateSchema = z.object({
    body: z.string().min(1).max(8000),
    author: z.string().max(64).optional(),
  }).strict();

  app.post("/issues/:uuid/comments", async (c) => {
    const uuid = c.req.param("uuid");
    const issue = tracker.getIssue(uuid);
    if (!issue) return c.json({ error: "Not found" }, 404);
    const parsed = CommentCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const comment = tracker.addComment(uuid, { body: parsed.data.body, author: parsed.data.author });
    tracker.recordEvent(uuid, "comment_added", parsed.data.body.slice(0, 120), { comment_id: comment.id, author: comment.author });

    // Post-insert: parse slash commands from comment body
    const bodyText = parsed.data.body.trim();
    const reviseMatch = CMD_REVISE_RE.exec(bodyText);
    if (CMD_APPROVE_RE.test(bodyText)) {
      if (issue.state === "plan_review") {
        approvePlan(uuid);
      } else {
        releaseForReschedule(uuid);
        triggerTick();
      }
    } else if (reviseMatch) {
      const note = reviseMatch[1]?.trim();
      if (issue.state === "plan_review" && note) {
        revisePlan(uuid, note);
      }
    } else if (CMD_SKIP_PLAN_RE.test(bodyText) && issue.state === "todo") {
      tracker.updateIssueState(uuid, "in_progress");
      // /skip-plan moves a queued issue straight into execution and re-dispatches it.
      releaseForReschedule(uuid);
      triggerTick();
    }
    // Other comment bodies are silently treated as regular comments.

    return c.json(comment, 201);
  });

  app.get("/issues/:uuid/comments", (c) => {
    const uuid = c.req.param("uuid");
    const issue = tracker.getIssue(uuid);
    if (!issue) return c.json({ error: "Not found" }, 404);
    const since = c.req.query("since");
    const comments = tracker.listComments(uuid, since ? { since: Number(since) } : undefined);
    return c.json(comments);
  });

  app.delete("/issues/:uuid/comments/:commentId", (c) => {
    const uuid = c.req.param("uuid");
    const commentId = c.req.param("commentId");
    const deleted = tracker.deleteComment(commentId);
    if (deleted) {
      tracker.recordEvent(uuid, "comment_deleted", `Comment ${commentId} deleted`, { comment_id: commentId });
    }
    return c.json({ ok: true, deleted });
  });

  // --- Blockers ---

  const BlockerCreateSchema = z.object({
    blocker_uuid: z.string().uuid(),
  }).strict();

  app.post("/issues/:uuid/blockers", async (c) => {
    const uuid = c.req.param("uuid");
    const issue = tracker.getIssue(uuid);
    if (!issue) return c.json({ error: "Not found" }, 404);
    const parsed = BlockerCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const blocker = tracker.getIssue(parsed.data.blocker_uuid);
    if (!blocker) return c.json({ error: "Blocker issue not found" }, 404);
    if (blocker.uuid === uuid) return c.json({ error: "An issue cannot block itself" }, 400);
    tracker.insertBlocker(uuid, blocker.uuid, blocker.state);
    tracker.recordEvent(uuid, "blocker_added", `Blocked by ${blocker.identifier} (${blocker.uuid})`, { blocker_uuid: blocker.uuid, blocker_state: blocker.state });
    return c.json({ ok: true });
  });

  app.delete("/issues/:uuid/blockers/:blockerUuid", (c) => {
    const uuid = c.req.param("uuid");
    const blockerUuid = c.req.param("blockerUuid");
    const issue = tracker.getIssue(uuid);
    if (!issue) return c.json({ error: "Not found" }, 404);
    tracker.removeBlocker(uuid, blockerUuid);
    tracker.recordEvent(uuid, "blocker_removed", `Blocker ${blockerUuid} removed`, { blocker_uuid: blockerUuid });
    triggerTick();
    return c.json({ ok: true });
  });

  // --- Retrigger ---

  const RetriggerSchema = z.object({
    target_state: z.enum(["todo", "in_progress", "in_review"]).default("todo"),
    reset_blocker_fingerprint: z.boolean().default(true),
    note: z.string().max(8000).optional(),
  }).strict();

  app.post("/issues/:uuid/retrigger", async (c) => {
    const uuid = c.req.param("uuid");
    const issue = tracker.getIssue(uuid);
    if (!issue) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = RetriggerSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { target_state, reset_blocker_fingerprint, note } = parsed.data;

    // Optional note → addComment
    if (note?.trim()) {
      const noteComment = tracker.addComment(uuid, { body: note, author: "operator" });
      tracker.recordEvent(uuid, "comment_added", note.slice(0, 120), { comment_id: noteComment.id, author: "operator" });
    }

    const fromState = issue.state;

    // Reset state
    if (issue.state !== target_state) {
      tracker.updateIssueState(uuid, target_state);
    }
    // Critical: clear last_issue_state so candidate SQL picks it up
    tracker.updateLastIssueState(uuid, "");

    // Release run if in non-released state
    const run = tracker.getRun(uuid);
    if (run && run.last_state !== "released") {
      tracker.releaseIssue(uuid, "released");
    }

    // Reset blocker fingerprint
    if (reset_blocker_fingerprint) {
      tracker.updateLastBlockerFingerprint(uuid, null);
    }

    const commentsTotal = tracker.countComments(uuid);
    tracker.recordEvent(uuid, "retrigger_requested", `Retrigger: ${fromState} → ${target_state}`, {
      from_state: fromState,
      to_state: target_state,
      reset_blocker_fingerprint,
      note_attached: !!note?.trim(),
      comments_total: commentsTotal,
    });

    triggerTick();
    return c.json({ ok: true });
  });

  // TODO: Long-term, request-changes could be implemented as addComment + retrigger
  // to unify the two flows. For now they coexist with different semantics.

  // ─── Artifacts ───────────────────────────────────────────────

  app.get("/artifacts", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
    const artifacts = tracker.listRecentArtifacts(limit);
    const items = artifacts.map(({ content, storage_path, ...rest }) => rest);
    return c.json(items);
  });

  app.get("/issues/:uuid/artifacts", (c) => {
    const uuid = c.req.param("uuid");
    const issue = tracker.getIssue(uuid);
    if (!issue) return c.json({ error: "Not found" }, 404);
    const attemptStr = c.req.query("attempt");
    const attempt = attemptStr !== undefined ? Number.parseInt(attemptStr, 10) : undefined;
    const artifacts = tracker.listArtifacts(uuid, attempt);
    // Omit content from list response to keep payload small
    const items = artifacts.map(({ content, storage_path, ...rest }) => rest);
    return c.json(items);
  });

  app.get("/issues/:uuid/related-artifacts", (c) => {
    const uuid = c.req.param("uuid");
    const issue = tracker.getIssue(uuid);
    if (!issue) return c.json({ error: "Not found" }, 404);

    const related = new Set<string>();
    if (issue.plan_run_id) {
      for (const i of tracker.listIssuesByPlanRun(issue.plan_run_id)) {
        if (i.uuid !== uuid) related.add(i.uuid);
      }
      const run = tracker.getPlanRun(issue.plan_run_id);
      if (run?.caller_issue_uuid && run.caller_issue_uuid !== uuid) related.add(run.caller_issue_uuid);
    }
    for (const b of issue.blockers) related.add(b.blocker_uuid);
    for (const run of tracker.listPlanRuns()) {
      if (run.caller_issue_uuid === uuid) {
        for (const i of tracker.listIssuesByPlanRun(run.id)) related.add(i.uuid);
      }
    }

    const artifacts = tracker.listArtifactsByIssues([...related]);
    const items = artifacts.map(({ content, storage_path, ...rest }) => rest);
    return c.json({ related_issue_uuids: [...related], artifacts: items });
  });

  app.get("/artifacts/:id", (c) => {
    const artifact = tracker.getArtifact(c.req.param("id"));
    if (!artifact) return c.json({ error: "Not found" }, 404);
    // Omit storage_path from response (internal implementation detail)
    const { storage_path, ...rest } = artifact;
    return c.json(rest);
  });

  app.get("/artifacts/:id/raw", async (c) => {
    const artifact = tracker.getArtifact(c.req.param("id"));
    if (!artifact) return c.json({ error: "Not found" }, 404);

    // S3: Sanitize label before embedding in Content-Disposition to prevent header injection.
    // Strip CR/LF, double-quotes, and backslashes: in RFC 2616 quoted-strings a backslash
    // is an escape prefix (quoted-pair), so an unstripped '\' followed by '"' would break
    // out of the quoted-string boundary and allow header value injection.
    const rawLabel = (artifact.label ?? artifact.id).replace(/[\r\n"\\]/g, "_");
    const disposition = `attachment; filename="${rawLabel}"`;

    if (artifact.storage_path) {
      try {
        const data = await fs.readFile(artifact.storage_path);
        return new Response(data, {
          headers: {
            "Content-Type": artifact.mime_type,
            "Content-Disposition": disposition,
          },
        });
      } catch {
        return c.json({ error: "File not found on disk" }, 404);
      }
    }

    if (artifact.content) {
      return new Response(artifact.content, {
        headers: {
          "Content-Type": artifact.mime_type,
          "Content-Disposition": disposition,
        },
      });
    }

    // Workspace fallback: resolve file from workspace if artifact has a path.
    // S2: Use fs.realpath to resolve all symlinks before containment check to
    // prevent symlink-escape attacks (agent creates link -> /etc/passwd and
    // reports it as an artifact path).
    if (artifact.path) {
      const run = tracker.getRun(artifact.issue_uuid);
      if (run?.workspace_path) {
        const full = path.resolve(run.workspace_path, artifact.path);
        try {
          const [realFull, realWorkspace] = await Promise.all([
            fs.realpath(full),
            fs.realpath(run.workspace_path),
          ]);
          if (realFull !== realWorkspace && !realFull.startsWith(realWorkspace + path.sep)) {
            return c.json({ error: "path escape denied" }, 403);
          }
          const data = await fs.readFile(realFull);
          return new Response(data, {
            headers: {
              "Content-Type": artifact.mime_type,
              "Content-Disposition": disposition,
            },
          });
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") return c.json({ error: "file not found" }, 404);
          if (code === "EACCES") return c.json({ error: "access denied" }, 403);
          /* fall through to 404 */
        }
      }
    }

    return c.json({ error: "No content available" }, 404);
  });

  // ─── Plan Runs ────────────────────────────────────────────────────────────────

  const PlanRunCreateSchema = z.object({
    script: z.string().min(1).max(65_536),
    meta: z.object({
      name: z.string().min(1),
      max_issues: z.number().int().positive().max(100),
      max_budget_tokens: z.number().int().positive().optional(),
      phases: z.array(z.string()).optional(),
    }),
    args: z.unknown().optional(),
    caller_issue_uuid: z.string().optional(),
    wall_time_ms: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).optional(),
  });

  const PLAN_RUN_LONG_POLL_TIMEOUT_MS = 30_000;

  app.post("/plan-runs", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PlanRunCreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const d = parsed.data;
    const runId = `RUN-${Date.now()}-${nanoid(6)}`;
    tracker.insertPlanRun({
      id: runId,
      caller_issue_uuid: d.caller_issue_uuid ?? null,
      script: d.script,
      meta: d.meta,
      args: d.args,
      wall_time_ms: d.wall_time_ms ?? 7 * 24 * 60 * 60 * 1000,
    });
    triggerTick();
    return c.json({ id: runId, state: "pending" }, 201);
  });

  app.get("/plan-runs", (c) => {
    const parsedState = PlanRunStateEnum.safeParse(c.req.query("state"));
    const caller = c.req.query("caller_issue_uuid");
    const state: PlanRunState | undefined = parsedState.success ? parsedState.data : undefined;
    let runs = tracker.listPlanRuns({ state });
    if (caller) {
      runs = runs.filter(r => r.caller_issue_uuid === caller);
    }
    return c.json(runs);
  });

  app.get("/plan-runs/:id", (c) => {
    const run = tracker.getPlanRun(c.req.param("id"));
    if (!run) return c.json({ error: "Not found" }, 404);
    return c.json(run);
  });

  app.get("/plan-runs/:id/journal", (c) => {
    const id = c.req.param("id");
    const run = tracker.getPlanRun(id);
    if (!run) return c.json({ error: "Not found" }, 404);
    const entries = tracker.getPlanRunJournal(id);
    return c.json({ id, entries });
  });

  app.get("/plan-runs/:id/nodes", (c) => {
    const id = c.req.param("id");
    const run = tracker.getPlanRun(id);
    if (!run) return c.json({ error: "Not found" }, 404);
    const nodes = tracker.listPlanRunNodes(id);
    return c.json({ id, nodes });
  });

  app.get("/issues/:uuid/llm-calls", (c) => {
    const uuid = c.req.param("uuid");
    const issue = tracker.getIssue(uuid);
    if (!issue) return c.json({ error: "Not found" }, 404);
    const calls = tracker.listLlmCalls(uuid);
    return c.json({ issue_uuid: uuid, calls });
  });

  app.get("/issues/:uuid/llm-calls/summary", (c) => {
    const uuid = c.req.param("uuid");
    const issue = tracker.getIssue(uuid);
    if (!issue) return c.json({ error: "Not found" }, 404);
    const summary = tracker.getLlmCallSummary(uuid);
    return c.json({ issue_uuid: uuid, ...summary });
  });

  app.get("/issues/summary", (c) => {
    const issues = tracker.listIssues();
    const totalCost = issues.reduce((sum, issue) => {
      if (!issue.plan_estimates_json) return sum;
      return sum;
    }, 0);
    // Aggregate LLM calls across all issues via a single query would be faster,
    // but for correctness and small scale we sum per-issue summaries.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCallCost = 0;
    let totalCalls = 0;
    for (const issue of issues) {
      const s = tracker.getLlmCallSummary(issue.uuid);
      totalInputTokens += s.input_tokens;
      totalOutputTokens += s.output_tokens;
      totalCallCost += s.cost_usd;
      totalCalls += s.call_count;
    }
    const stateCounts = Object.fromEntries(
      ["backlog", "todo", "planning", "plan_review", "in_progress", "in_review", "done", "cancelled", "blocked"].map((state) => [
        state,
        issues.filter((i) => i.state === state).length,
      ])
    );
    return c.json({
      total_issues: issues.length,
      total_cost_usd: totalCallCost,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
      total_llm_calls: totalCalls,
      state_counts: stateCounts,
    });
  });

  app.get("/plan-runs/:id/result", async (c) => {
    const id = c.req.param("id");
    const run = tracker.getPlanRun(id);
    if (!run) return c.json({ error: "Not found" }, 404);

    // If already in terminal state, return immediately
    const TERMINAL = ["done", "failed", "cancelled"];
    if (TERMINAL.includes(run.state)) {
      return c.json({ id: run.id, state: run.state, result: run.result });
    }

    // Long-poll: wait up to 30s for terminal state
    const deadline = Date.now() + PLAN_RUN_LONG_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 1_000));
      const updated = tracker.getPlanRun(id);
      if (!updated) return c.json({ error: "Not found" }, 404);
      if (TERMINAL.includes(updated.state)) {
        return c.json({ id: updated.id, state: updated.state, result: updated.result });
      }
    }
    // Still pending — return current state
    const current = tracker.getPlanRun(id);
    return c.json({ id: current!.id, state: current!.state, result: null }, 202);
  });

  app.post("/plan-runs/:id/approve", async (c) => {
    const id = c.req.param("id");
    const run = tracker.getPlanRun(id);
    if (!run) return c.json({ error: "Not found" }, 404);
    if (run.state !== "awaiting_approval") {
      return c.json({ error: `Plan run must be in 'awaiting_approval' state (current: '${run.state}')` }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { approved_by?: string };
    tracker.approvePlanRun(id, body.approved_by ?? "operator");
    triggerTick();
    return c.json({ ok: true, state: "awaiting_approval", approval_status: "approved" });
  });

  app.post("/plan-runs/:id/reject", async (c) => {
    const id = c.req.param("id");
    const run = tracker.getPlanRun(id);
    if (!run) return c.json({ error: "Not found" }, 404);
    if (run.state !== "awaiting_approval") {
      return c.json({ error: `Plan run must be in 'awaiting_approval' state (current: '${run.state}')` }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    tracker.rejectPlanRun(id, body.reason ?? "Rejected");
    triggerTick();
    return c.json({ ok: true, state: "cancelled" });
  });

  app.post("/plan-runs/:id/request-changes", async (c) => {
    const id = c.req.param("id");
    const run = tracker.getPlanRun(id);
    if (!run) return c.json({ error: "Not found" }, 404);
    if (run.state !== "awaiting_approval") {
      return c.json({ error: `Plan run must be in 'awaiting_approval' state (current: '${run.state}')` }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { suggestion?: string };
    // request-changes → reject with suggestion; caller can re-spawn with adjustments
    tracker.rejectPlanRun(id, `Changes requested: ${body.suggestion ?? "(no suggestion provided)"}`);
    triggerTick();
    return c.json({ ok: true, state: "cancelled" });
  });

  app.delete("/plan-runs/:id", (c) => {
    const id = c.req.param("id");
    const run = tracker.getPlanRun(id);
    if (!run) return c.json({ error: "Not found" }, 404);
    const TERMINAL = ["done", "failed", "cancelled"];
    if (TERMINAL.includes(run.state)) {
      return c.json({ error: `Plan run is already in terminal state '${run.state}'` }, 400);
    }
    tracker.finishPlanRun(id, "cancelled", "cancelled by operator");

    // Cascade: cancel non-terminal sub-issues
    const subIssues = tracker.listIssuesByPlanRun(id);
    for (const issue of subIssues) {
      if (!["done", "cancelled"].includes(issue.state)) {
        tracker.updateIssueState(issue.uuid, "cancelled");
        tracker.recordEvent(issue.uuid, "issue_cancelled", `Cancelled: parent plan run ${id} cancelled by operator`, { run_id: id });
      }
    }
    triggerTick();
    return c.json({ ok: true, state: "cancelled" });
  });

  return app;
}
