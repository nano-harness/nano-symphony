import { nanoid } from "nanoid";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tracker } from "../db/tracker.ts";
import { nullishString } from "../http/schemas.ts";
import { guessMimeType } from "../orchestrator/artifact-collector.ts";

// ─── Zod Schemas (single source of truth) ───────────────────────────────────
// All MCP tool input schemas are defined here as Zod schemas.
// JSON-Schema for TOOL_DEFINITIONS is generated from these via zod-to-json-schema.

const FetchIssueInputSchema = z.object({});

// Maximum serialized payload size for MCP report_event (prevents agent from
// blowing up the SQLite events table with arbitrarily large payloads).
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024; // 64 KB

/**
 * Schema for report_event MCP tool.
 * payload is freeform but the frontend recognizes these fields for markdown rendering:
 *   - `markdown` (preferred), `text`, `summary`, `message`, `content`, `reason`
 * If any of these fields contain a string, it will be rendered as GitHub Flavored Markdown.
 */
const ReportEventSchema = z.object({
  kind: z.string().describe("Event kind (started, progress, tool_call, error, completed)"),
  message: z.string().describe("Human-readable description"),
  payload: z.unknown().optional().describe("Additional structured data").superRefine((val, ctx) => {
    // S7: Reject payloads that would exceed the per-event storage budget.
    if (val === undefined || val === null) return;
    const serialized = JSON.stringify(val);
    if (serialized.length > MAX_EVENT_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `payload too large (${serialized.length} bytes > ${MAX_EVENT_PAYLOAD_BYTES} limit)`,
      });
    }
  }),
});

const GoalStateSchema = z.object({
  condition: z.string().optional().describe("Goal condition being evaluated"),
  turns_evaluated: z.number().optional().describe("Number of goal evaluation turns completed"),
  turnsEvaluated: z.number().optional(),
  max_turns: z.number().optional().describe("Maximum allowed goal evaluation turns"),
  maxTurns: z.number().optional(),
  achieved_at: z.union([z.string(), z.number(), z.null()]).optional().describe("Timestamp or turn marker when the goal was achieved"),
  achievedAt: z.union([z.string(), z.number(), z.null()]).optional(),
  last_reason: z.string().optional().describe("Most recent judge reason"),
  lastReason: z.string().optional(),
  tokens: z.unknown().optional().describe("Optional token usage details"),
}).passthrough();

const RequestWorkflowSectionSchema = z.object({
  section: z.string().optional().describe("Section name to extract (optional)"),
});

const SuggestStateTransitionSchema = z.object({
  suggested_state: z.string().describe("Target state"),
  reason: z.string().describe("Reason for transition"),
});

const CreateIssueSchema = z.object({
  title: z.string().min(1).describe("Issue title (required)"),
  description: nullishString().describe("Issue description (markdown)"),
  priority: z.enum(["urgent", "high", "medium", "low"]).optional().describe("Priority, default 'medium'"),
  state: nullishString().describe("Initial state, default 'backlog'. Use a non-backlog state (e.g. 'todo') to make it immediately schedulable."),
  labels: z.array(z.string()).optional().describe("Labels"),
  link_current_as_blocker: z.boolean().optional().describe("If true, the current issue is set as a blocker on the new issue (sub-task pattern). Default false."),
  agent_kind: z.enum(["nano", "claude-code"]).optional()
    .describe("Agent kind for this issue, default 'claude-code'."),
});

const ActivateIssueSchema = z.object({
  issue_id: z.string().min(1).describe("Target issue id (the one created by symphony.create_issue)"),
  target_state: nullishString().describe("Target state, default 'todo'. Must NOT be 'backlog'/'done'/'cancelled'."),
});

const MAX_PLAN_MARKDOWN_LENGTH = 32_000; // ~8x typical implementation plan size; keeps event payload manageable

const SubmitPlanSchema = z.object({
  markdown: z.string().min(1).max(MAX_PLAN_MARKDOWN_LENGTH)
    .describe("Implementation plan in markdown format"),
  steps: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    files: z.array(z.string()).optional(),
    depends_on: z.array(z.string()).optional(),
  })).max(30).optional()
    .describe("Structured steps for progress tracking"),
  estimates: z.object({
    files_touched: z.number().optional(),
    complexity: z.enum(["low", "medium", "high"]).optional(),
    estimated_turns: z.number().optional(),
  }).optional()
    .describe("Effort estimates for the plan"),
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
  semantics: z.enum(["success", "needs_retry", "handoff", "abandoned"]).describe("Completion semantics"),
  summary: z.string().describe("What happened in this session (markdown OK)"),
  handoff_state: nullishString().describe("Target state if semantics=handoff (e.g. 'in_review')"),
  blocker_fingerprint: z.string().optional().describe("Short stable identifier of the blocker, e.g. 'sandbox_denied:/abs/path' or 'dyld_missing:libpcre2'. Used by symphony to short-circuit same-cause retries."),
  termination_cause: z.string().optional().describe("Closed-enum reason describing why the session ended. Typical values: task_done | natural_completion | error_threshold | diminishing_returns | similar_content_loop | context_done | goal_max_turns | llm_failure | crash."),
  artifacts: z.array(ArtifactSchema).max(50).optional().describe(
    "Typed artifacts for the reviewer. Each item is one of: " +
    "{kind:'file_diff', path, diff?, additions?, deletions?} | " +
    "{kind:'file_added', path, bytes?, preview?} | " +
    "{kind:'file_removed', path} | " +
    "{kind:'file_renamed', from, to} | " +
    "{kind:'screenshot', path, caption?} | " +
    "{kind:'log_excerpt', label, content} | " +
    "{kind:'url', label, href} | " +
    "{kind:'command_output', label, cmd, exit_code?, output} | " +
    "{kind:'note', label, markdown}"
  ),
  follow_ups: z.array(z.string().max(500)).max(20).optional().describe("Plain-text follow-up items the reviewer should consider; surfaced as a list in the handoff panel."),
  metrics: z.object({
    turns_used: z.number().optional(),
    files_touched: z.number().optional(),
    tests_passed: z.number().optional(),
    tests_failed: z.number().optional(),
  }).partial().optional().describe("Optional self-reported metrics for the reviewer."),
});

// States that agents must not transition to via suggest_state_transition;
// they must go through session_completed which handles retry/fingerprint logic.
const SUGGEST_TRANSITION_FORBIDDEN = new Set(["done", "cancelled"]);

// A6: Restrict agent-driven state transitions to the non-terminal working states.
// "backlog" is excluded because issues there are never picked up by getCandidates;
// "done"/"cancelled" are terminal and must flow through session_completed.
const SUGGEST_TRANSITION_ALLOWED = new Set(["todo", "in_progress", "in_review", "planning"]);

// ─── Helper: convert Zod → MCP-compatible JSON-Schema ────────────────────────
function zodToInputSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(schema, { target: "openApi3" });
  // Remove $schema and top-level metadata that MCP doesn't need
  const { $schema, ...rest } = jsonSchema as Record<string, unknown>;
  return rest;
}

// ─── TOOL_DEFINITIONS (generated from Zod schemas) ───────────────────────────
export const TOOL_DEFINITIONS = [
  {
    name: "symphony.fetch_issue",
    description: "Fetches the current issue details assigned to this agent session.",
    inputSchema: zodToInputSchema(FetchIssueInputSchema),
  },
  {
    name: "symphony.report_event",
    description: "Reports a progress event to the orchestrator.",
    inputSchema: zodToInputSchema(ReportEventSchema),
  },
  {
    name: "symphony.report_goal_state",
    description: "Reports nano-agent /goal evaluator state for this session.",
    inputSchema: zodToInputSchema(GoalStateSchema),
  },
  {
    name: "symphony.request_workflow_section",
    description: "Gets the workflow template or a specific section.",
    inputSchema: zodToInputSchema(RequestWorkflowSectionSchema),
  },
  {
    name: "symphony.suggest_state_transition",
    description: "Suggests a state change for the issue.",
    inputSchema: zodToInputSchema(SuggestStateTransitionSchema),
  },
  {
    name: "symphony.create_issue",
    description: "Creates a new issue. Identifier is auto-generated as TASK-{n}. Default state is 'backlog' (not auto-dispatched). Optionally links the current issue as a blocker for sub-task scenarios.",
    inputSchema: zodToInputSchema(CreateIssueSchema),
  },
  {
    name: "symphony.activate_issue",
    description: "Moves a backlog issue to a schedulable state so orchestrator picks it up. Use only when the new issue is ready to be worked on; call only when you intentionally want orchestrator to pick it up immediately.",
    inputSchema: zodToInputSchema(ActivateIssueSchema),
  },
  {
    name: "symphony.submit_plan",
    description: "Submits an implementation plan during the PLANNING phase. Transitions the issue from 'planning' to 'plan_review' and releases the agent slot. Must be called instead of session_completed when in planning mode.",
    inputSchema: zodToInputSchema(SubmitPlanSchema),
  },
  {
    name: "symphony.session_completed",
    description: "REQUIRED - Must be called before session exits. Optionally attach typed artifacts, follow-up notes, and self-reported metrics so reviewers can act on the handoff without scrubbing logs.",
    inputSchema: zodToInputSchema(SessionCompletedSchema),
  },
];

// ─── Artifact helpers for session_completed persistence ─────────────────────
type ArtifactItem = z.infer<typeof ArtifactSchema>;

function buildArtifactLabel(art: ArtifactItem): string {
  if ("label" in art && art.label) return art.label;
  if ("path" in art && art.path) return art.path as string;
  if ("to" in art) return `${art.from} → ${art.to}`;
  if ("cmd" in art) return art.cmd;
  if ("href" in art) return art.href;
  return art.kind;
}

function extractArtifactContent(art: ArtifactItem): string | undefined {
  if ("output" in art) return art.output;
  if ("content" in art) return art.content;
  if ("markdown" in art) return art.markdown;
  if ("diff" in art && art.diff) return art.diff;
  if ("preview" in art && art.preview) return art.preview;
  return undefined;
}

function getArtifactPath(art: ArtifactItem): string | undefined {
  // ArtifactSchema variants with a 'path' field: file_diff, file_added, file_removed, screenshot
  // file_renamed has 'from'/'to' instead; use 'to' (the destination) as the canonical path
  if ("path" in art && art.path) return art.path as string;
  if ("to" in art) return art.to; // file_renamed
  return undefined;
}

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
        // S2: Escape regex metacharacters in agent-supplied section name to prevent ReDoS.
        const safeSection = parsed.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`##\\s+${safeSection}([\\s\\S]*?)(?=##|$)`, "i");
        const match = regex.exec(template);
        return { content: match ? match[1].trim() : "" };
      }
      return { content: template };
    }

    case "symphony.suggest_state_transition": {
      const parsed = SuggestStateTransitionSchema.parse(params);
      const target = parsed.suggested_state;
      if (SUGGEST_TRANSITION_FORBIDDEN.has(target)) {
        tracker.recordEvent(issueId, "state_transition_suggested", `Rejected transition to ${target} (use session_completed instead)`, {
          suggested_state: target,
          reason: parsed.reason,
          rejected: true,
        });
        return { ok: false, error: `Cannot transition to '${target}' via suggest_state_transition; use session_completed instead.` };
      }
      // A6: Only allow transitions to the known safe working states.
      if (!SUGGEST_TRANSITION_ALLOWED.has(target)) {
        tracker.recordEvent(issueId, "state_transition_suggested", `Rejected transition to unknown/disallowed state '${target}'`, {
          suggested_state: target,
          reason: parsed.reason,
          rejected: true,
        });
        return { ok: false, error: `Cannot transition to '${target}' via suggest_state_transition; allowed states are: ${[...SUGGEST_TRANSITION_ALLOWED].join(", ")}.` };
      }
      tracker.updateIssueState(issueId, target);
      tracker.recordEvent(issueId, "state_transition_suggested", `Transitioned to ${target}`, {
        suggested_state: target,
        reason: parsed.reason,
        applied: true,
      });
      return { ok: true, state: target };
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
        agent_kind: parsed.agent_kind ?? "claude-code",
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

    case "symphony.submit_plan": {
      const parsed = SubmitPlanSchema.parse(params);
      const issue = tracker.getIssue(issueId);
      if (!issue) throw new Error(`Issue ${issueId} not found`);
      if (issue.state !== "planning") {
        return { ok: false, error: `submit_plan requires issue to be in 'planning' state (current: '${issue.state}')` };
      }

      // Determine revision number from prior plan_submitted events
      const priorPlans = tracker.getEventsByKind(issueId, "plan_submitted");
      const revision = priorPlans.length;

      const planPayload = {
        markdown: parsed.markdown,
        steps: parsed.steps,
        estimates: parsed.estimates,
        revision,
      };

      tracker.recordEvent(issueId, "plan_submitted", `Implementation plan submitted (revision ${revision})`, planPayload);
      tracker.updateIssueState(issueId, "plan_review");
      tracker.releaseIssue(issueId, "released");
      tracker.updateLastIssueState(issueId, "plan_review");
      return { ok: true, message: "Plan submitted. Awaiting operator approval." };
    }

    case "symphony.session_completed": {
      const parsed = SessionCompletedSchema.parse(params);

      // If the issue is in 'planning' state and agent calls handoff, treat as plan submission.
      // The agent is expected to call submit_plan instead, but this is a fallback.
      const currentIssue = tracker.getIssue(issueId);
      if (currentIssue?.state === "planning" && parsed.semantics === "handoff") {
        // Auto-submit an empty plan from the session summary
        const priorPlans = tracker.getEventsByKind(issueId, "plan_submitted");
        const revision = priorPlans.length;
        tracker.recordEvent(issueId, "plan_submitted", `Plan submitted via session_completed handoff (revision ${revision})`, {
          markdown: parsed.summary,
          revision,
        });
        tracker.updateIssueState(issueId, "plan_review");
        tracker.releaseIssue(issueId, "released");
        tracker.updateLastIssueState(issueId, "plan_review");
        // Also record session_completed for log completeness
        tracker.recordEvent(issueId, "session_completed", parsed.summary, {
          semantics: parsed.semantics,
          planning_phase: true,
        });
        return { ok: true };
      }

      tracker.recordEvent(issueId, "session_completed", parsed.summary, {
        semantics: parsed.semantics,
        handoff_state: parsed.handoff_state,
        blocker_fingerprint: parsed.blocker_fingerprint,
        termination_cause: parsed.termination_cause,
        artifacts: parsed.artifacts,
        follow_ups: parsed.follow_ups,
        metrics: parsed.metrics,
      });

      // Persist MCP-reported artifacts to DB (MCP data takes priority over git diff)
      if (parsed.artifacts?.length) {
        const seenPaths = new Set<string>();
        for (const art of parsed.artifacts) {
          const artPath = getArtifactPath(art);
          // MCP-internal dedup: skip duplicate paths within this artifacts array
          if (artPath) {
            if (seenPaths.has(artPath)) continue;
            seenPaths.add(artPath);
          }
          tracker.insertArtifact({
            issue_id: issueId,
            attempt,
            source: "mcp",
            kind: art.kind,
            label: buildArtifactLabel(art),
            path: artPath,
            content: extractArtifactContent(art),
            metadata: art,
            mime_type: guessMimeType(art.kind, artPath),
          });
        }
      }

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
