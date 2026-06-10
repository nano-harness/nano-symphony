/**
 * Plan sub-loops run on every orchestrator tick.
 * Four idempotent, restartable sub-loops:
 *
 * 1. tickPendingPlans    — pending → dry_running → awaiting_approval (or failed)
 * 2. tickApprovedPlans   — awaiting_approval + approved → running → spawn executor
 * 3. tickFinalizedPlans  — done/failed/cancelled with caller → resume caller issue
 * 4. tickExpiredPlans    — running + wall_time exceeded → cancelled + cascade
 */

import type { Tracker } from "../db/tracker.ts";
import type { Logger } from "pino";
import { executePlan, executePlanDryRun } from "./plan-executor.ts";

/** Set of run IDs currently being dry-run or executed (in-process guard) */
const inFlight = new Set<string>();

export async function tickPendingPlans(tracker: Tracker, logger: Logger): Promise<void> {
  const pending = tracker.listPendingPlanRuns();
  for (const run of pending) {
    if (inFlight.has(run.id)) continue;
    inFlight.add(run.id);
    // Fire and forget — dry-run updates state itself
    void executePlanDryRun(run.id, tracker, logger).finally(() => inFlight.delete(run.id));
  }
}

export async function tickApprovedPlans(tracker: Tracker, logger: Logger): Promise<void> {
  const approved = tracker.listApprovedPlanRuns();
  for (const run of approved) {
    if (inFlight.has(run.id)) continue;
    // Transition to running
    tracker.setPlanRunRunning(run.id);
    inFlight.add(run.id);
    // Execute plan asynchronously
    void executePlan(run.id, tracker, logger).finally(() => inFlight.delete(run.id));
  }
}

const RESUME_EVENT_KIND = "caller_resumed" as const;

export async function tickFinalizedPlans(tracker: Tracker, logger: Logger): Promise<void> {
  const finalized = tracker.listFinalizedPlanRunsWithCaller();
  for (const run of finalized) {
    if (!run.caller_issue_uuid) continue;

    const callerIssue = tracker.getIssue(run.caller_issue_uuid);
    if (!callerIssue) {
      logger.warn({ runId: run.id, callerId: run.caller_issue_uuid }, "Caller issue not found, skipping resume");
      continue;
    }

    // Only resume if the caller is still in a waiting state. If the operator
    // manually moved it (e.g. cancelled), respect that decision.
    if (callerIssue.state === "done" || callerIssue.state === "cancelled") {
      logger.info({ runId: run.id, callerId: run.caller_issue_uuid, callerState: callerIssue.state },
        "Caller already in terminal state, recording resume event without state change");
      tracker.recordEvent(run.caller_issue_uuid, RESUME_EVENT_KIND, `Plan run ${run.id} finalized (${run.state}), caller already ${callerIssue.state}`, {
        plan_run_id: run.id,
        run_state: run.state,
        result: run.result,
        skipped_resume: true,
      });
      continue;
    }

    logger.info({ runId: run.id, callerId: run.caller_issue_uuid }, "Resuming caller after plan finalized");

    // Record resume event and transition caller back to todo
    tracker.recordEvent(run.caller_issue_uuid, RESUME_EVENT_KIND, `Plan run ${run.id} finalized (${run.state})`, {
      plan_run_id: run.id,
      run_state: run.state,
      result: run.result,
    });

    // Clear the plan_run_id link and put caller back to schedulable state
    tracker.updateIssuePlanRunId(run.caller_issue_uuid, null);
    tracker.updateIssueState(run.caller_issue_uuid, "todo");
    tracker.updateLastIssueState(run.caller_issue_uuid, "todo");
  }
}

let lastExpiredCheck = 0;
const EXPIRED_CHECK_INTERVAL_MS = 60_000;

/**
 * Resume in-flight plan runs after a crash restart.
 * Called once at startup to re-attach running plans without waiting
 * for their wall_time_ms to expire.
 */
export async function resumeRunningPlans(tracker: Tracker, logger: Logger): Promise<void> {
  const running = tracker.listRunningPlanRuns();
  for (const run of running) {
    logger.info({ runId: run.id, state: run.state }, "Resuming running plan run after restart");
    // Re-attach to execution — executePlan handles idempotency via inFlight guard
    if (inFlight.has(run.id)) continue;
    tracker.setPlanRunRunning(run.id); // refresh started_at if needed
    inFlight.add(run.id);
    void executePlan(run.id, tracker, logger).finally(() => inFlight.delete(run.id));
  }
}

export async function tickExpiredPlans(tracker: Tracker, logger: Logger): Promise<void> {
  const now = Date.now();
  if (now - lastExpiredCheck < EXPIRED_CHECK_INTERVAL_MS) return;
  lastExpiredCheck = now;

  const expired = tracker.listExpiredRunningPlanRuns(now);
  for (const run of expired) {
    logger.warn({ runId: run.id }, "Plan run wall time exceeded, cancelling");

    tracker.finishPlanRun(run.id, "cancelled", "wall_time_exceeded");

    // Cascade: cancel all non-terminal sub-issues
    const subIssues = tracker.listIssuesByPlanRun(run.id);
    for (const issue of subIssues) {
      if (issue.state !== "done" && issue.state !== "cancelled") {
        tracker.updateIssueState(issue.uuid, "cancelled");
        tracker.recordEvent(issue.uuid, "issue_cancelled", `Cancelled: parent plan run ${run.id} wall-time exceeded`, {
          plan_run_id: run.id,
        });
      }
    }
  }
}
