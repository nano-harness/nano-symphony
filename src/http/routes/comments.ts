import { Hono } from "hono";
import type { Tracker } from "../../db/tracker.ts";
import type { Workflow } from "../../workflow/types.ts";
import { createRouteHelpers } from "./helpers.ts";
import { CommentCreateSchema, CMD_APPROVE_RE, CMD_REVISE_RE, CMD_SKIP_PLAN_RE } from "./schemas.ts";

export function createCommentsRoutes(
  tracker: Tracker,
  _getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  triggerTick: () => void,
  _options?: Record<string, unknown>,
): Hono {
  const app = new Hono();
  const { releaseForReschedule, approvePlan, revisePlan } = createRouteHelpers(tracker, triggerTick);

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

  return app;
}
