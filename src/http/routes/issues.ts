import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { Tracker } from "../../db/tracker.ts";
import type { Workflow } from "../../workflow/types.ts";
import { config } from "../../config.ts";
import { removeWorkspace } from "../../workspace/manager.ts";
import { computePlanDiff, type PlanPayload } from "../plan-diff.ts";
import { computePlanGraph } from "../plan-graph.ts";
import { createRouteHelpers } from "./helpers.ts";
import {
  IssueCreateSchema,
  IssueUpdateSchema,
  RequestChangesSchema,
  BlockerCreateSchema,
  RetriggerSchema,
} from "./schemas.ts";
import { z } from "zod";

const PlanActualsSchema = z.object({
  actual_turns: z.number().int().min(0).optional(),
  actual_files_touched: z.number().int().min(0).optional(),
  actual_complexity: z.enum(["low", "medium", "high"]).optional(),
}).strict();

export function createIssuesRoutes(
  tracker: Tracker,
  getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  triggerTick: () => void,
  _options?: Record<string, unknown>,
): Hono {
  const app = new Hono();
  const { approvePlan, revisePlan } = createRouteHelpers(tracker, triggerTick);

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
      const workflow = getWorkflow();
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

  // --- Blockers ---
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

  // --- Artifacts tied to issues ---
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
    // Use the indexed caller query instead of scanning every plan run.
    for (const run of tracker.listPlanRunsByCaller(uuid)) {
      for (const i of tracker.listIssuesByPlanRun(run.id)) related.add(i.uuid);
    }

    const artifacts = tracker.listArtifactsByIssues([...related]);
    const items = artifacts.map(({ content, storage_path, ...rest }) => rest);
    return c.json({ related_issue_uuids: [...related], artifacts: items });
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

  return app;
}
