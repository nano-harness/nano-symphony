import type { Tracker } from "../db/tracker.ts";
import type { Logger } from "pino";

interface PlanProgress {
  plan_run_id: string;
  total: number;
  done: number;
  cancelled: number;
  blocked: number;
  in_progress: number;
  percent: number;
  updated_at: number;
}

const TERMINAL_STATES = new Set(["done", "cancelled", "blocked"]);
const ACTIVE_STATES = new Set(["todo", "planning", "plan_review", "in_progress", "in_review", "backlog"]);

/**
 * Syncs a parent issue's `plan_progress_json` with the state of sub-issues
 * created by its plan run. When a plan run reaches a terminal state and all
 * sub-issues are terminal, the parent issue is automatically completed or
 * cancelled so multi-agent orchestrations don't leave parents dangling.
 */
export function syncParentPlanRunProgress(tracker: Tracker, logger: Logger): void {
  // Only sync runs that are still active or terminal runs whose parent hasn't
  // been finalized yet. This avoids O(total plan runs) work every tick.
  const runs = tracker.listPlanRunsNeedingProgressSync();
  for (const run of runs) {
    if (!run.caller_issue_uuid) continue;
    const parent = tracker.getIssue(run.caller_issue_uuid);
    if (!parent) continue;

    const subIssues = tracker.listIssuesByPlanRun(run.id);
    const total = subIssues.length;
    const done = subIssues.filter((i) => i.state === "done").length;
    const cancelled = subIssues.filter((i) => i.state === "cancelled").length;
    const blocked = subIssues.filter((i) => i.state === "blocked").length;
    const inProgress = subIssues.filter((i) => ACTIVE_STATES.has(i.state)).length;
    const percent = total > 0 ? Math.round(((done + cancelled + blocked) / total) * 100) : 0;

    const progress: PlanProgress = {
      plan_run_id: run.id,
      total,
      done,
      cancelled,
      blocked,
      in_progress: inProgress,
      percent,
      updated_at: Date.now(),
    };

    tracker.updateIssuePlanProgress(parent.uuid, progress);

    const runTerminal = ["done", "failed", "cancelled"].includes(run.state);
    const allSubTerminal = total > 0 && subIssues.every((i) => TERMINAL_STATES.has(i.state));
    if (runTerminal && allSubTerminal && !TERMINAL_STATES.has(parent.state)) {
      const nextState = run.state === "done" && done > 0 ? "done" : "cancelled";
      tracker.updateIssueState(parent.uuid, nextState);
      tracker.updateLastIssueState(parent.uuid, nextState);
      tracker.recordEvent(parent.uuid, "parent_plan_run_completed", `Plan run ${run.id} ${run.state}; parent moved to ${nextState}`, {
        plan_run_id: run.id,
        plan_run_state: run.state,
        next_state: nextState,
        progress,
      });
      logger.info({ runId: run.id, parentUuid: parent.uuid, nextState }, "Parent plan run completed");
    }
  }
}
