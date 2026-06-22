import { Hono } from "hono";
import type { Tracker, IssueMetrics } from "../../db/tracker.ts";
import type { Workflow } from "../../workflow/types.ts";
import { renderMetrics, setGauge } from "../../metrics.ts";
import { PLAN_RUN_STATES } from "./schemas.ts";

export function createMetricsRoutes(
  tracker: Tracker,
  _getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  _triggerTick: () => void,
  options?: {
    getConcurrencyStatus?: () => { limit: number; available: number; active: number };
  },
): Hono {
  const app = new Hono();

  app.get("/metrics", (c) => {
    // Snapshot current entity counts so /metrics always reflects the DB state.
    // These are gauges, not counters: each scrape reports the absolute value.
    const issues = tracker.listIssues();
    const planRuns = tracker.listPlanRuns();
    setGauge("symphony_issues_total", {}, issues.length);
    setGauge("symphony_plan_runs_total", {}, planRuns.length);
    for (const state of ["todo", "in_progress", "in_review", "done", "cancelled"]) {
      const count = issues.filter((i) => i.state === state).length;
      setGauge("symphony_issues_total", { state }, count);
    }
    for (const state of PLAN_RUN_STATES) {
      const count = planRuns.filter((r) => r.state === state).length;
      setGauge("symphony_plan_runs_total", { state }, count);
    }
    const concurrency = options?.getConcurrencyStatus?.() ?? { limit: 0, available: 0, active: 0 };
    setGauge("symphony_concurrency_limit", {}, concurrency.limit);
    setGauge("symphony_concurrency_available", {}, concurrency.available);
    setGauge("symphony_concurrency_active", {}, concurrency.active);
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

  return app;
}
