import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { Tracker } from "../../db/tracker.ts";
import type { Workflow } from "../../workflow/types.ts";
import type { PlanRunState } from "../../db/tracker-plan-runs.ts";
import { PlanRunCreateSchema, PlanRunStateEnum } from "./schemas.ts";

const PLAN_RUN_LONG_POLL_TIMEOUT_MS = 30_000;

export function createPlanRunsRoutes(
  tracker: Tracker,
  _getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  triggerTick: () => void,
  _options?: Record<string, unknown>,
): Hono {
  const app = new Hono();

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

  app.get("/plan-runs/:id/result", async (c) => {
    const id = c.req.param("id");
    const run = tracker.getPlanRun(id);
    if (!run) return c.json({ error: "Not found" }, 404);

    // If already in terminal state, return immediately
    const TERMINAL = ["done", "failed", "cancelled"];
    if (TERMINAL.includes(run.state)) {
      return c.json({ id: run.id, state: run.state, result: run.result });
    }

    // Long-poll: wait up to 30s for terminal state, aborting early if the client disconnects.
    const signal = c.req.raw.signal;
    const deadline = Date.now() + PLAN_RUN_LONG_POLL_TIMEOUT_MS;
    while (Date.now() < deadline && !signal.aborted) {
      await new Promise((res, rej) => {
        const timer = setTimeout(res, 1_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          rej(new Error("aborted"));
        }, { once: true });
      });
      const updated = tracker.getPlanRun(id);
      if (!updated) return c.json({ error: "Not found" }, 404);
      if (TERMINAL.includes(updated.state)) {
        return c.json({ id: updated.id, state: updated.state, result: updated.result });
      }
    }
    if (signal.aborted) {
      return c.json({ error: "Client disconnected" }, 400);
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
