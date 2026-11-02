import { Hono } from "hono";
import type { Tracker } from "../../db/tracker.ts";
import type { Workflow } from "../../workflow/types.ts";
import { createArtifactsRoutes } from "./artifacts.ts";
import { createCommentsRoutes } from "./comments.ts";
import { createEventsRoutes } from "./events.ts";
import { createHealthRoutes } from "./health.ts";
import { createIssuesRoutes } from "./issues.ts";
import { createMetricsRoutes } from "./metrics.ts";
import { createPlanRunsRoutes } from "./plan-runs.ts";
import { createRunsRoutes } from "./runs.ts";
import { createWorkflowRoutes } from "./workflow.ts";
import { createWorkspaceRoutes } from "./workspace.ts";

export function createRoutes(
  tracker: Tracker,
  getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  triggerTick: () => void,
  options?: {
    reloadWorkflow?: () => { workflow: Workflow; template: string } | null;
    getConcurrencyStatus?: () => { limit: number; available: number; active: number };
  },
): Hono {
  const app = new Hono();
  const startedAt = Date.now();

  app.route("/", createMetricsRoutes(tracker, getWorkflow, triggerTick, options));
  app.route("/", createHealthRoutes(tracker, getWorkflow, triggerTick, { ...options, startedAt }));
  app.route("/", createIssuesRoutes(tracker, getWorkflow, triggerTick));
  app.route("/", createRunsRoutes(tracker, getWorkflow, triggerTick));
  app.route("/", createEventsRoutes(tracker, getWorkflow, triggerTick));
  app.route("/", createWorkflowRoutes(tracker, getWorkflow, triggerTick, options));
  app.route("/", createWorkspaceRoutes(tracker, getWorkflow, triggerTick));
  app.route("/", createCommentsRoutes(tracker, getWorkflow, triggerTick));
  app.route("/", createArtifactsRoutes(tracker, getWorkflow, triggerTick));
  app.route("/", createPlanRunsRoutes(tracker, getWorkflow, triggerTick));

  return app;
}
