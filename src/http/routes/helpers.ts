import type { z } from "zod";
import type { Tracker } from "../../db/tracker.ts";
import { PlanRevisionFeedbackSchema } from "./schemas.ts";

export function createRouteHelpers(tracker: Tracker, triggerTick: () => void) {
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

  return { releaseForReschedule, approvePlan, revisePlan };
}
