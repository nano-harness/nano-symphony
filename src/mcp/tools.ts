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

const PlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
}).passthrough();

const PlanEstimatesSchema = z.object({
  files_touched: z.number().int().min(0).optional(),
  complexity: z.enum(["low", "medium", "high"]).optional(),
  estimated_turns: z.number().int().min(1).optional(),
}).passthrough();

const SubmitPlanSchema = z.object({
  markdown: z.string().min(1).max(64_000),
  steps: z.array(PlanStepSchema).optional(),
  estimates: PlanEstimatesSchema.optional(),
}).strict();

const MAX_PLAN_SCRIPT_SIZE = 65_536; // 64 KB

// ─── Plan-run tools ───────────────────────────────────────────────────────────

const EmitResultSchema = z.object({
  data: z.unknown().describe(
    "The structured result of this issue. Must match the <output_schema> from the prompt if present. " +
    "If no schema, provide a string summary (≤32KB). Must be called before session_completed."
  ),
});

const SpawnPlanRunSchema = z.object({
  script: z.string().max(MAX_PLAN_SCRIPT_SIZE).describe(
    "Inline JavaScript that drives the plan. Uses the plan SDK globals: " +
    "issue(), parallel(), pipeline(), phase(), log(), args, budget. " +
    "Must NOT use Date/Math.random/require/import/globalThis/process."
  ),
  args: z.unknown().optional().describe("Arguments passed to the script as the `args` global."),
  meta: z.object({
    name: z.string().describe("Human-readable plan name"),
    max_issues: z.number().int().min(1).max(100).describe("Maximum sub-issues to spawn"),
    max_budget_tokens: z.number().int().min(1).optional().describe("Soft token budget hint"),
    phases: z.array(z.string()).optional().describe("Phase names for progress tracking"),
  }).describe("Plan metadata (must be a literal object, not computed at runtime)"),
});

const GetArtifactSchema = z.object({
  artifact_id: z.string().min(1).describe("Artifact ID to read"),
  mode: z.enum(["full", "head", "tail", "search"]).optional().describe("Read mode (default: full)"),
  lines: z.number().int().min(1).optional().describe("Number of lines for head/tail mode"),
  bytes: z.number().int().min(1).optional().describe("Max bytes for full mode"),
  pattern: z.string().optional().describe("Pattern for search mode"),
});

const UpdateIssueScratchpadSchema = z.object({
  text: z.string().max(4096).describe("Scratchpad text to persist for the next invocation (≤4KB)"),
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
  summary: z.string().optional().describe("What happened in this session (markdown OK). Deprecated: use emit_result for structured output."),
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
  }).partial().optional().describe("@deprecated Self-reported metrics (no longer consumed by orchestrator)."),
}).passthrough();

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
    name: "symphony.submit_plan",
    description: "Submit a plan for review while keeping plan-run features available.",
    inputSchema: zodToInputSchema(SubmitPlanSchema),
  },
  {
    name: "symphony.emit_result",
    description:
      "Submit the structured result for this issue. REQUIRED - call before session_completed. " +
      "If the prompt contains an <output_schema>, your data must match it. " +
      "Without a schema, provide a string summary (≤32KB).",
    inputSchema: zodToInputSchema(EmitResultSchema),
  },
  {
    name: "symphony.spawn_plan_run",
    description:
      "Spawn a plan run (fire-and-forget). The plan executes asynchronously; use spawn_plan_run_and_handoff " +
      "if you want this issue to pause and receive the plan result.",
    inputSchema: zodToInputSchema(SpawnPlanRunSchema),
  },
  {
    name: "symphony.spawn_plan_run_and_handoff",
    description:
      "Spawn a plan run and pause this issue. When the plan finishes, this issue is re-scheduled " +
      "and the plan result is injected into the next prompt via previous_invocations.",
    inputSchema: zodToInputSchema(SpawnPlanRunSchema),
  },
  {
    name: "symphony.get_artifact",
    description: "Read an artifact by ID. Supports full, head, tail, and search modes.",
    inputSchema: zodToInputSchema(GetArtifactSchema),
  },
  {
    name: "symphony.update_issue_scratchpad",
    description: "Persist a short note (≤4KB) that will be injected into the next invocation of this issue.",
    inputSchema: zodToInputSchema(UpdateIssueScratchpadSchema),
  },
  {
    name: "symphony.session_completed",
    description: "REQUIRED - Must be called before session exits. Call emit_result first to submit structured output. Optionally attach typed artifacts, follow-up notes, and metrics so reviewers can act on the handoff without scrubbing logs.",
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

function submitPlanCompat(
  tracker: Tracker,
  issueUuid: string,
  markdown: string,
  steps?: z.infer<typeof PlanStepSchema>[],
  estimates?: z.infer<typeof PlanEstimatesSchema>
): { ok: boolean; message?: string; error?: string; revision?: number } {
  const issue = tracker.getIssue(issueUuid);
  if (!issue) throw new Error(`Issue ${issueUuid} not found`);
  if (issue.state !== "planning") {
    return { ok: false, error: "Issue must be in planning state to submit a plan." };
  }
  const revision = tracker.getEventsByKind(issueUuid, "plan_submitted").length;
  tracker.recordEvent(issueUuid, "plan_submitted", "Plan submitted", {
    markdown,
    steps,
    estimates,
    revision,
  });
  tracker.updateIssueState(issueUuid, "plan_review");
  return { ok: true, message: "Plan submitted for review", revision };
}

// Plan-internal tools that plan sub-issues are forbidden from calling (no nesting).
const PLAN_INTERNAL_FORBIDDEN = new Set(["symphony.spawn_plan_run", "symphony.spawn_plan_run_and_handoff"]);

// Tools allowed when an issue is in planning state (read-only + plan submission).
const PLANNING_ALLOWED_TOOLS = new Set([
  "symphony.fetch_issue",
  "symphony.report_event",
  "symphony.submit_plan",
  "symphony.session_completed",
]);

export async function handleTool(
  name: string,
  params: unknown,
  issueUuid: string,
  attempt: number,
  tracker: Tracker,
  workflow?: { template: string }
): Promise<unknown> {
  // Guard: issues that belong to a plan run cannot spawn further plans (no nesting).
  if (PLAN_INTERNAL_FORBIDDEN.has(name)) {
    const issue = tracker.getIssue(issueUuid);
    if (issue?.plan_run_id) {
      throw new Error(
        `Tool '${name}' is not available inside a plan run. ` +
        `Use emit_result to return your result; the caller plan can spawn further runs.`
      );
    }
  }

  // Guard: planning mode — only allow read-only and plan-submission tools.
  const issue = tracker.getIssue(issueUuid);
  if (issue && issue.state === "planning" && !PLANNING_ALLOWED_TOOLS.has(name)) {
    throw new Error(
      `Tool '${name}' is disabled while the issue is in planning mode. ` +
      `Only fetch_issue, report_event, submit_plan, and session_completed are available.`
    );
  }

  switch (name) {
    case "symphony.fetch_issue": {
      const issue = tracker.getIssue(issueUuid);
      if (!issue) throw new Error(`Issue ${issueUuid} not found`);

      // Augment with previous invocations (plan run history) if any
      const previousInvocations = buildPreviousInvocations(issueUuid, tracker);
      return { issue, attempt, previous_invocations: previousInvocations };
    }

    case "symphony.report_event": {
      const parsed = ReportEventSchema.parse(params);
      tracker.recordEvent(issueUuid, parsed.kind, parsed.message, parsed.payload);
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
      tracker.recordEvent(issueUuid, kind, reason ?? "Goal state reported", parsed);
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
        tracker.recordEvent(issueUuid, "state_transition_suggested", `Rejected transition to ${target} (use session_completed instead)`, {
          suggested_state: target,
          reason: parsed.reason,
          rejected: true,
        });
        return { ok: false, error: `Cannot transition to '${target}' via suggest_state_transition; use session_completed instead.` };
      }
      // A6: Only allow transitions to the known safe working states.
      if (!SUGGEST_TRANSITION_ALLOWED.has(target)) {
        tracker.recordEvent(issueUuid, "state_transition_suggested", `Rejected transition to unknown/disallowed state '${target}'`, {
          suggested_state: target,
          reason: parsed.reason,
          rejected: true,
        });
        return { ok: false, error: `Cannot transition to '${target}' via suggest_state_transition; allowed states are: ${[...SUGGEST_TRANSITION_ALLOWED].join(", ")}.` };
      }
      tracker.updateIssueState(issueUuid, target);
      tracker.recordEvent(issueUuid, "state_transition_suggested", `Transitioned to ${target}`, {
        suggested_state: target,
        reason: parsed.reason,
        applied: true,
      });
      return { ok: true, state: target };
    }

    case "symphony.submit_plan": {
      const parsed = SubmitPlanSchema.parse(params);
      return submitPlanCompat(tracker, issueUuid, parsed.markdown, parsed.steps, parsed.estimates);
    }

    case "symphony.emit_result": {
      const parsed = EmitResultSchema.parse(params);
      const issue = tracker.getIssue(issueUuid);
      if (!issue) throw new Error(`Issue ${issueUuid} not found`);

      // Validate against expected_schema if present
      let validated = 1;
      let validationError: string | undefined;
      if (issue.expected_schema) {
        try {
          const { validateSchema } = await import("../plan-runtime/schema-validate.ts");
          const result = validateSchema(JSON.parse(issue.expected_schema), parsed.data);
          if (!result.valid) {
            validated = 0;
            validationError = result.errors?.join("; ");
          }
        } catch (e) {
          // schema-validate module unavailable in this context — skip validation
          console.warn("[emit_result] schema validation unavailable:", e instanceof Error ? e.message : String(e));
        }
      }

      tracker.upsertIssueResult(issueUuid, attempt, parsed.data, validated === 1);

      tracker.recordEvent(issueUuid, "result_emitted", `Result emitted (validated=${validated})`, {
        validated,
        validation_error: validationError,
      });

      if (validated === 0 && validationError) {
        return { ok: false, error: `Result does not match output schema: ${validationError}. Fix and call emit_result again.` };
      }
      return { ok: true, validated: true };
    }

    case "symphony.spawn_plan_run":
    case "symphony.spawn_plan_run_and_handoff": {
      const parsed = SpawnPlanRunSchema.parse(params);

      // Build sequential run ID (plan-executor will own canonical format for production)
      const runId = `RUN-${Date.now()}-${nanoid(6)}`;
      const isHandoff = name === "symphony.spawn_plan_run_and_handoff";

      tracker.insertPlanRun({
        id: runId,
        caller_issue_uuid: isHandoff ? issueUuid : null,
        script: parsed.script,
        meta: parsed.meta,
        args: parsed.args,
        wall_time_ms: 7 * 24 * 60 * 60 * 1000,
      });

      tracker.recordEvent(issueUuid, "plan_run_spawned", `Plan run spawned: ${runId}`, {
        run_id: runId,
        handoff: isHandoff,
        plan_name: parsed.meta.name,
      });

      if (isHandoff) {
        // Pause this issue until the plan run completes
        tracker.updateIssuePlanRunId(issueUuid, runId);
        tracker.updateIssueState(issueUuid, "awaiting_plan");
        tracker.releaseIssue(issueUuid, "released");
        tracker.updateLastIssueState(issueUuid, "awaiting_plan");
      }

      return { ok: true, run_id: runId, handoff: isHandoff };
    }

    case "symphony.get_artifact": {
      const parsed = GetArtifactSchema.parse(params);
      const artifact = tracker.getArtifact(parsed.artifact_id);
      if (!artifact) throw new Error(`Artifact ${parsed.artifact_id} not found`);

      const mode = parsed.mode ?? "full";
      let content = artifact.content ?? "";

      if (mode === "head" && parsed.lines) {
        content = content.split("\n").slice(0, parsed.lines).join("\n");
      } else if (mode === "tail" && parsed.lines) {
        content = content.split("\n").slice(-parsed.lines).join("\n");
      } else if (mode === "search" && parsed.pattern) {
        const lines = content.split("\n").filter(l => l.includes(parsed.pattern!));
        content = lines.join("\n");
      } else if (mode === "full" && parsed.bytes) {
        content = content.slice(0, parsed.bytes);
      }

      return {
        artifact_id: artifact.id,
        kind: artifact.kind,
        label: artifact.label,
        mime_type: artifact.mime_type,
        content,
      };
    }

    case "symphony.update_issue_scratchpad": {
      const parsed = UpdateIssueScratchpadSchema.parse(params);
      tracker.updateIssueScratchpad(issueUuid, parsed.text);
      tracker.recordEvent(issueUuid, "scratchpad_updated", "Scratchpad updated", {
        length: parsed.text.length,
      });
      return { ok: true };
    }

    case "symphony.session_completed": {
      const parsed = SessionCompletedSchema.parse(params);

      tracker.recordEvent(issueUuid, "session_completed", parsed.summary ?? "Session completed", {
        semantics: parsed.semantics,
        handoff_state: parsed.handoff_state,
        blocker_fingerprint: parsed.blocker_fingerprint,
        termination_cause: parsed.termination_cause,
        artifacts: parsed.artifacts,
        follow_ups: parsed.follow_ups,
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
            issue_uuid: issueUuid,
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
        tracker.updateLastBlockerFingerprint(issueUuid, parsed.blocker_fingerprint);
      }

      // Clear fingerprint on success or handoff
      if (parsed.semantics === "success" || parsed.semantics === "handoff") {
        tracker.updateLastBlockerFingerprint(issueUuid, null);
      }

      const issue = tracker.getIssue(issueUuid);
      if (parsed.semantics === "handoff" && issue?.state === "planning") {
        return submitPlanCompat(tracker, issueUuid, parsed.summary ?? "Plan submitted");
      }

      return { ok: true };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPreviousInvocations(issueUuid: string, tracker: Tracker): unknown[] {
  try {
    const planRuns = tracker.listPlanRunsByCaller(issueUuid);
    if (!planRuns.length) return [];
    return planRuns.map((run, idx) => ({
      index: idx,
      plan_run: {
        id: run.id,
        state: run.state,
        script_excerpt: run.script.slice(0, 200 * 80), // ~200 lines
        result: run.result ?? null,
      },
    }));
  } catch {
    return [];
  }
}
