import { z } from "zod";
import { nullishString } from "../schemas.ts";

export const VALID_STATES = [
  "backlog",
  "todo",
  "awaiting_plan",
  "planning",
  "plan_review",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

export const AgentKindEnum = z.enum(["nano", "claude-code"]).nullable().optional();

export const AGENT_BINARIES: Record<string, string> = {
  nano: "nano",
  "claude-code": "claude",
};

export const PLAN_RUN_STATES = [
  "pending",
  "dry_running",
  "awaiting_approval",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;

export const PlanRunStateEnum = z.enum(PLAN_RUN_STATES);

// Slash command pattern for comment-based approve directive
export const CMD_APPROVE_RE = /^\/(?:approve|lgtm|execute)\b/i;
export const CMD_REVISE_RE = /^\/revise(?:\s+(.*\S))?\s*$/i;
export const CMD_SKIP_PLAN_RE = /^\/skip-plan\b/i;

// SSE connection limit to prevent listener accumulation
export const MAX_SSE_CONNECTIONS = 50;

export const IssueBaseSchema = z.object({
  identifier: nullishString({ max: 64 }),
  title: z.string().min(1, "title is required").max(200),
  description: nullishString({ max: 20000 }),
  priority: z.enum(["urgent", "high", "medium", "low"]).default("medium"),
  state: z.enum(VALID_STATES),
  branch: nullishString(),
  url: nullishString(),
  workspace_path: nullishString({ max: 1024 }),
  agent_kind: AgentKindEnum,
  agent_binary: nullishString({ max: 256 }),
  agent_role: nullishString({ max: 64 }),
  require_plan: z.boolean().nullable().optional(),
  cost_budget_usd: z.number().min(0).nullable().optional(),
  token_budget: z.number().int().min(0).nullable().optional(),
  labels: z.array(z.string()).default([]),
});

export const IssueCreateSchema = IssueBaseSchema.strict();

export const IssueUpdateSchema = IssueBaseSchema.partial().strict();

export const RequestChangesSchema = z.object({
  note: z.string().trim().min(1, "note is required").max(8000),
  feedback: z.object({
    category: z.enum(["scope", "approach", "estimate", "missing_tests", "other"]),
    severity: z.enum(["minor", "major", "blocking"]),
    must_fix: z.array(z.string().trim().min(1)).max(20).optional(),
  }).optional(),
}).strict();

export const PlanRevisionFeedbackSchema = z.object({
  category: z.enum(["scope", "approach", "estimate", "missing_tests", "other"]),
  severity: z.enum(["minor", "major", "blocking"]),
  must_fix: z.array(z.string().trim().min(1)).max(20).optional(),
});

export const PlanRunCreateSchema = z.object({
  script: z.string().min(1).max(65_536),
  meta: z.object({
    name: z.string().min(1),
    max_issues: z.number().int().positive().max(100),
    max_budget_tokens: z.number().int().positive().optional(),
    phases: z.array(z.string()).optional(),
  }),
  args: z.unknown().optional(),
  caller_issue_uuid: z.string().optional(),
  wall_time_ms: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).optional(),
});

export const CommentCreateSchema = z.object({
  body: z.string().min(1).max(8000),
  author: z.string().max(64).optional(),
}).strict();

export const BlockerCreateSchema = z.object({
  blocker_uuid: z.string().uuid(),
}).strict();

export const RetriggerSchema = z.object({
  target_state: z.enum(["todo", "in_progress", "in_review"]).default("todo"),
  reset_blocker_fingerprint: z.boolean().default(true),
  note: z.string().max(8000).optional(),
}).strict();
