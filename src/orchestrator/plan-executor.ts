/**
 * Plan executor: coordinates running an approved plan_run.
 * Called by tickApprovedPlans; runs asynchronously in the background.
 */

import type { Tracker } from "../db/tracker.ts";
import type { Logger } from "pino";
import { runPlan } from "../plan-runtime/runner.ts";
import { dryRun } from "../plan-runtime/dry-run.ts";

function parseJsonOrNull(json: string | null): unknown {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function deriveTerminationReason(error?: string): string {
  if (!error) return "unknown";
  if (error.startsWith("cancelled_by_user")) return "cancelled_by_user";
  if (error.startsWith("cancelled_transient")) return "cancelled_transient";
  if (error.includes("wall_time_exceeded")) return "timeout";
  if (error.includes("max_issues_exceeded")) return "budget_exhausted";
  if (error.includes("Sub-issue") && error.includes("cancelled")) return "sub_issue_abandoned";
  return "vm_error";
}

export async function executePlan(
  runId: string,
  tracker: Tracker,
  logger: Logger,
): Promise<void> {
  const run = tracker.getPlanRun(runId);
  if (!run) {
    logger.warn({ runId }, "executePlan: run not found");
    return;
  }

  let meta: { max_issues: number; max_budget_tokens?: number };
  try {
    meta = JSON.parse(run.meta) as typeof meta;
  } catch {
    tracker.finishPlanRun(runId, "failed", "Invalid meta JSON");
    return;
  }

  const args = parseJsonOrNull(run.args ?? null);

  logger.info({ runId, name: (meta as unknown as Record<string, unknown>).name }, "Plan executor starting");

  // Token budget is enforced across all sub-issues spawned by this plan run.
  // Recompute on each call so the sandbox sees up-to-date spend as issues finish.
  const tokenSpent = () => {
    const issues = tracker.listIssuesByPlanRun(runId);
    return issues.reduce((sum, issue) => {
      const s = tracker.getLlmCallSummary(issue.uuid);
      return sum + s.input_tokens + s.output_tokens;
    }, 0);
  };

  const result = await runPlan({
    runId,
    script: run.script,
    args,
    maxIssues: meta.max_issues,
    wallTimeMs: run.wall_time_ms,
    tracker,
    tokenSpent,
    tokenTotal: meta.max_budget_tokens ?? 0,
    maxRetries: (meta as unknown as Record<string, unknown>).max_retries as number | undefined,
  });

  if (result.ok) {
    const resultStr = result.result !== null && result.result !== undefined
      ? (typeof result.result === "string" ? result.result : JSON.stringify(result.result))
      : null;
    tracker.finishPlanRun(runId, "done", resultStr ?? undefined);
    logger.info({ runId }, "Plan executor finished successfully");
  } else {
    tracker.finishPlanRun(runId, "failed", result.error);
    logger.warn({ runId, error: result.error }, "Plan executor failed");

    // Emit structured failure event for observability
    const callerIssueId = run.caller_issue_uuid;
    if (callerIssueId) {
      const lastLogTruncated = result.lastLog && result.lastLog.length > 1024
        ? { text: result.lastLog.slice(0, 1024), truncated: true }
        : { text: result.lastLog ?? null, truncated: false };

      tracker.recordEvent(callerIssueId, "plan_run_failed", `Plan run ${runId} failed: ${result.error ?? "unknown"}`, {
        reason: result.terminationReason ?? deriveTerminationReason(result.error),
        phase: result.lastPhase,
        last_log: lastLogTruncated.text,
        last_log_truncated: lastLogTruncated.truncated,
        last_log_at: result.lastLogAt,
        error_message: result.error,
        sub_issues_started: result.subIssuesStarted,
        sub_issues_done: result.subIssuesDone,
        sub_issues_failed: result.subIssuesFailed,
      });
    }
  }
}

export async function executePlanDryRun(
  runId: string,
  tracker: Tracker,
  logger: Logger,
): Promise<void> {
  const run = tracker.getPlanRun(runId);
  if (!run) {
    logger.warn({ runId }, "executePlanDryRun: run not found");
    return;
  }

  let meta: { max_issues: number; name?: string };
  try {
    meta = JSON.parse(run.meta) as typeof meta;
  } catch {
    tracker.finishPlanRun(runId, "failed", "Invalid meta JSON");
    return;
  }

  const args = parseJsonOrNull(run.args ?? null);

  logger.info({ runId, name: meta.name }, "Plan dry-run starting");
  tracker.updatePlanRunState(runId, "dry_running");

  const summary = await dryRun({
    script: run.script,
    args,
    maxIssues: meta.max_issues,
  });

  tracker.setPlanRunDryRunSummary(runId, summary);

  if (summary.ok) {
    tracker.updatePlanRunState(runId, "awaiting_approval");
    logger.info({ runId, estimated_issues: summary.estimated_issues }, "Plan dry-run complete, awaiting approval");
  } else {
    tracker.finishPlanRun(runId, "failed", `Dry-run failed: ${summary.error}`);
    logger.warn({ runId, error: summary.error }, "Plan dry-run failed");
  }
}
