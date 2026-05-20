import { nanoid } from "nanoid";
import { z } from "zod";
import type { Tracker } from "../db/tracker.ts";
import { nullishString } from "../http/schemas.ts";

export const TOOL_DEFINITIONS = [
  {
    name: "symphony.fetch_issue",
    description: "Fetches the current issue details assigned to this agent session.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "symphony.report_event",
    description: "Reports a progress event to the orchestrator.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Event kind (started, progress, tool_call, error, completed)" },
        message: { type: "string", description: "Human-readable description" },
        payload: { type: "object", description: "Additional structured data" },
      },
      required: ["kind", "message"],
    },
  },
  {
    name: "symphony.report_goal_state",
    description: "Reports nano-agent /goal evaluator state for this session.",
    inputSchema: {
      type: "object",
      properties: {
        condition: { type: "string", description: "Goal condition being evaluated" },
        turns_evaluated: { type: "number", description: "Number of goal evaluation turns completed" },
        max_turns: { type: "number", description: "Maximum allowed goal evaluation turns" },
        achieved_at: { description: "Timestamp or turn marker when the goal was achieved" },
        last_reason: { type: "string", description: "Most recent judge reason" },
        tokens: { type: "object", description: "Optional token usage details" },
      },
      required: [],
    },
  },
  {
    name: "symphony.request_workflow_section",
    description: "Gets the workflow template or a specific section.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", description: "Section name to extract (optional)" },
      },
      required: [],
    },
  },
  {
    name: "symphony.suggest_state_transition",
    description: "Suggests a state change for the issue.",
    inputSchema: {
      type: "object",
      properties: {
        suggested_state: { type: "string", description: "Target state" },
        reason: { type: "string", description: "Reason for transition" },
      },
      required: ["suggested_state", "reason"],
    },
  },
  {
    name: "symphony.create_issue",
    description: "Creates a new issue. Identifier is auto-generated as TASK-{n}. Default state is 'backlog' (not auto-dispatched). Optionally links the current issue as a blocker for sub-task scenarios.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title (required)" },
        description: { type: "string", description: "Issue description (markdown)" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low"], description: "Priority, default 'medium'" },
        state: { type: "string", description: "Initial state, default 'backlog'. Use a non-backlog state (e.g. 'todo') to make it immediately schedulable." },
        labels: { type: "array", items: { type: "string" }, description: "Labels" },
        link_current_as_blocker: { type: "boolean", description: "If true, the current issue is set as a blocker on the new issue (sub-task pattern). Default false." },
      },
      required: ["title"],
    },
  },
  {
    name: "symphony.activate_issue",
    description: "Moves a backlog issue to a schedulable state so orchestrator picks it up. Use only when the new issue is ready to be worked on; call only when you intentionally want orchestrator to pick it up immediately.",
    inputSchema: {
      type: "object",
      properties: {
        issue_id: { type: "string", description: "Target issue id (the one created by symphony.create_issue)" },
        target_state: { type: "string", description: "Target state, default 'todo'. Must NOT be 'backlog'/'done'/'cancelled'." },
      },
      required: ["issue_id"],
    },
  },
  {
    name: "symphony.session_completed",
    description: "REQUIRED - Must be called before session exits. Optionally attach typed artifacts, follow-up notes, and self-reported metrics so reviewers can act on the handoff without scrubbing logs.",
    inputSchema: {
      type: "object",
      properties: {
        semantics: {
          type: "string",
          enum: ["success", "needs_retry", "handoff", "abandoned"],
          description: "Completion semantics",
        },
        summary: { type: "string", description: "What happened in this session (markdown OK)" },
        handoff_state: { type: "string", description: "Target state if semantics=handoff (e.g. 'in_review')" },
        blocker_fingerprint: {
          type: "string",
          description: "Short stable identifier of the blocker, e.g. 'sandbox_denied:/abs/path' or 'dyld_missing:libpcre2'. Used by symphony to short-circuit same-cause retries."
        },
        termination_cause: {
          type: "string",
          description: "Closed-enum reason describing why the session ended. Typical values: task_done | natural_completion | error_threshold | diminishing_returns | similar_content_loop | context_done | goal_max_turns | llm_failure | crash."
        },
        artifacts: {
          type: "array",
          description:
            "Typed artifacts for the reviewer. Each item is one of: " +
            "{kind:'file_diff', path, diff?, additions?, deletions?} | " +
            "{kind:'file_added', path, bytes?, preview?} | " +
            "{kind:'file_removed', path} | " +
            "{kind:'file_renamed', from, to} | " +
            "{kind:'screenshot', path, caption?} | " +
            "{kind:'log_excerpt', label, content} | " +
            "{kind:'url', label, href} | " +
            "{kind:'command_output', label, cmd, exit_code?, output} | " +
            "{kind:'note', label, markdown}",
          items: { type: "object" },
          maxItems: 50,
        },
        follow_ups: {
          type: "array",
          description: "Plain-text follow-up items the reviewer should consider; surfaced as a list in the handoff panel.",
          items: { type: "string", maxLength: 500 },
          maxItems: 20,
        },
        metrics: {
          type: "object",
          description: "Optional self-reported metrics for the reviewer.",
          properties: {
            turns_used: { type: "number" },
            files_touched: { type: "number" },
            tests_passed: { type: "number" },
            tests_failed: { type: "number" },
          },
        },
      },
      required: ["semantics", "summary"],
    },
  },
];

const ReportEventSchema = z.object({
  kind: z.string(),
  message: z.string(),
  payload: z.unknown().optional(),
});

const GoalStateSchema = z.object({
  condition: z.string().optional(),
  turns_evaluated: z.number().optional(),
  turnsEvaluated: z.number().optional(),
  max_turns: z.number().optional(),
  maxTurns: z.number().optional(),
  achieved_at: z.union([z.string(), z.number(), z.null()]).optional(),
  achievedAt: z.union([z.string(), z.number(), z.null()]).optional(),
  last_reason: z.string().optional(),
  lastReason: z.string().optional(),
  tokens: z.unknown().optional(),
}).passthrough();

const RequestWorkflowSectionSchema = z.object({
  section: z.string().optional(),
});

const SuggestStateTransitionSchema = z.object({
  suggested_state: z.string(),
  reason: z.string(),
});

const CreateIssueSchema = z.object({
  title: z.string().min(1),
  description: nullishString(),
  priority: z.enum(["urgent", "high", "medium", "low"]).optional(),
  state: nullishString(),
  labels: z.array(z.string()).optional(),
  link_current_as_blocker: z.boolean().optional(),
});

const ActivateIssueSchema = z.object({
  issue_id: z.string().min(1),
  target_state: nullishString(),
});

const ArtifactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file_diff"), path: z.string(), diff: z.string().max(64_000).optional(), additions: z.number().optional(), deletions: z.number().optional() }),
  z.object({ kind: z.literal("file_added"), path: z.string(), bytes: z.number().optional(), preview: z.string().max(8000).optional() }),
  z.object({ kind: z.literal("file_removed"), path: z.string() }),
  z.object({ kind: z.literal("file_renamed"), from: z.string(), to: z.string() }),
  z.object({ kind: z.literal("screenshot"), path: z.string(), caption: z.string().optional() }),
  z.object({ kind: z.literal("log_excerpt"), label: z.string(), content: z.string().max(32_000) }),
  z.object({ kind: z.literal("url"), label: z.string(), href: z.string().url() }),
  z.object({ kind: z.literal("command_output"), label: z.string(), cmd: z.string(), exit_code: z.number().optional(), output: z.string().max(32_000) }),
  z.object({ kind: z.literal("note"), label: z.string(), markdown: z.string().max(8000) }),
]);

const SessionCompletedSchema = z.object({
  semantics: z.enum(["success", "needs_retry", "handoff", "abandoned"]),
  summary: z.string(),
  handoff_state: nullishString(),
  blocker_fingerprint: z.string().optional(),
  termination_cause: z.string().optional(),
  artifacts: z.array(ArtifactSchema).max(50).optional(),
  follow_ups: z.array(z.string().max(500)).max(20).optional(),
  metrics: z.object({
    turns_used: z.number().optional(),
    files_touched: z.number().optional(),
    tests_passed: z.number().optional(),
    tests_failed: z.number().optional(),
  }).partial().optional(),
});

export async function handleTool(
  name: string,
  params: unknown,
  issueId: string,
  attempt: number,
  tracker: Tracker,
  workflow?: { template: string }
): Promise<unknown> {
  switch (name) {
    case "symphony.fetch_issue": {
      const issue = tracker.getIssue(issueId);
      if (!issue) throw new Error(`Issue ${issueId} not found`);
      return { issue, attempt };
    }

    case "symphony.report_event": {
      const parsed = ReportEventSchema.parse(params);
      tracker.recordEvent(issueId, parsed.kind, parsed.message, parsed.payload);
      return { ok: true };
    }

    case "symphony.report_goal_state": {
      const parsed = GoalStateSchema.parse(params);
      const turns = parsed.turns_evaluated ?? parsed.turnsEvaluated;
      const maxTurns = parsed.max_turns ?? parsed.maxTurns;
      const achievedAt = parsed.achieved_at ?? parsed.achievedAt;
      const achieved = achievedAt !== undefined && achievedAt !== null;
      const maxReached = !achieved && turns !== undefined && maxTurns !== undefined && turns >= maxTurns;
      const kind = achieved ? "goal_achieved" : maxReached ? "goal_max_turns" : "goal_evaluated";
      const reason = parsed.last_reason ?? parsed.lastReason;
      tracker.recordEvent(issueId, kind, reason ?? "Goal state reported", parsed);
      return { ok: true };
    }

    case "symphony.request_workflow_section": {
      const parsed = RequestWorkflowSectionSchema.parse(params);
      const template = workflow?.template ?? "";
      if (parsed.section) {
        const regex = new RegExp(`##\\s+${parsed.section}([\\s\\S]*?)(?=##|$)`, "i");
        const match = regex.exec(template);
        return { content: match ? match[1].trim() : "" };
      }
      return { content: template };
    }

    case "symphony.suggest_state_transition": {
      const parsed = SuggestStateTransitionSchema.parse(params);
      tracker.recordEvent(issueId, "state_transition_suggested", `Suggesting transition to ${parsed.suggested_state}`, {
        suggested_state: parsed.suggested_state,
        reason: parsed.reason,
      });
      return { ok: true };
    }

    case "symphony.create_issue": {
      const parsed = CreateIssueSchema.parse(params);
      const newId = nanoid();
      const taskNum = tracker.getNextTaskNumber();
      const identifier = `TASK-${taskNum}`;
      const state = parsed.state ?? "backlog";
      tracker.insertIssue({
        id: newId,
        identifier,
        title: parsed.title,
        description: parsed.description ?? null,
        priority: parsed.priority ?? "medium",
        state,
        labels: parsed.labels ?? [],
      });
      if (parsed.link_current_as_blocker) {
        const current = tracker.getIssue(issueId);
        tracker.insertBlocker(newId, issueId, current?.state ?? "unknown");
      }
      tracker.recordEvent(issueId, "issue_created", `Created child issue ${identifier}`, {
        new_issue_id: newId,
        new_identifier: identifier,
        linked_as_blocker: !!parsed.link_current_as_blocker,
      });
      return { id: newId, identifier, state };
    }

    case "symphony.activate_issue": {
      const parsed = ActivateIssueSchema.parse(params);
      const target = parsed.target_state ?? "todo";
      if (["backlog", "done", "cancelled"].includes(target)) {
        throw new Error(`activate_issue target_state must not be one of: backlog/done/cancelled (got '${target}')`);
      }
      const targetIssue = tracker.getIssue(parsed.issue_id);
      if (!targetIssue) throw new Error(`Issue ${parsed.issue_id} not found`);
      tracker.updateIssueState(parsed.issue_id, target);
      tracker.recordEvent(issueId, "issue_activated", `Activated issue ${targetIssue.identifier} -> ${target}`, {
        activated_issue_id: parsed.issue_id,
        from_state: targetIssue.state,
        to_state: target,
      });
      return { ok: true, id: parsed.issue_id, state: target };
    }

    case "symphony.session_completed": {
      const parsed = SessionCompletedSchema.parse(params);
      tracker.recordEvent(issueId, "session_completed", parsed.summary, {
        semantics: parsed.semantics,
        summary: parsed.summary,
        handoff_state: parsed.handoff_state,
        blocker_fingerprint: parsed.blocker_fingerprint,
        termination_cause: parsed.termination_cause,
        artifacts: parsed.artifacts,
        follow_ups: parsed.follow_ups,
        metrics: parsed.metrics,
      });

      // Persist blocker_fingerprint to issues table for short-circuit logic
      if (parsed.blocker_fingerprint) {
        tracker.updateLastBlockerFingerprint(issueId, parsed.blocker_fingerprint);
      }

      // Clear fingerprint on success or handoff
      if (parsed.semantics === "success" || parsed.semantics === "handoff") {
        tracker.updateLastBlockerFingerprint(issueId, null);
      }

      return { ok: true };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
