import { Hono } from "hono";
import type { Tracker } from "../../db/tracker.ts";
import type { Workflow } from "../../workflow/types.ts";
import { getActiveProcessCount } from "../../spawner/index.ts";
import { AGENT_BINARIES } from "./schemas.ts";

export function createHealthRoutes(
  tracker: Tracker,
  getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  _triggerTick: () => void,
  options?: {
    startedAt?: number;
    getConcurrencyStatus?: () => { limit: number; available: number; active: number };
  },
): Hono {
  const app = new Hono();
  const startedAt = options?.startedAt ?? Date.now();

  app.get("/health", (c) => {
    const workflowLoaded = getWorkflow() !== undefined;
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

  return app;
}
