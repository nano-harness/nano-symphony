import { z } from "zod";

export const WorkflowSchema = z.object({
  tracker: z.object({
    type: z.string(),
    api_key: z.string().optional(),
    team_id: z.string().optional(),
    filter: z.object({
      states: z.array(z.string()).default([]),
      labels: z.array(z.string()).default([]),
    }).optional(),
  }).optional(),
  polling: z.object({
    interval_ms: z.number().default(30000),
    max_concurrent_agents: z.number().default(3),
  }).optional(),
  workspace: z.object({
    root: z.string().default("./workspaces"),
    git_baseline: z.boolean().default(true),
    hooks: z.object({
      after_create: z.string().default(""),
      before_run: z.string().default(""),
      after_run: z.string().default(""),
      before_remove: z.string().default(""),
    }).default({}),
  }).optional(),
	  agent: z.object({
    kind: z.enum(["nano", "claude-code"]).default("claude-code"),
    binary: z.string().optional(),
    timeout_ms: z.number().default(3600000),
    max_retries: z.number().default(3),
    extra_env: z.record(z.string()).optional().default({}),
    permission_mode: z.string().optional(),
    permissions: z.object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      denial_max_consecutive: z.number().int().nonnegative().optional(),
      denial_max_total: z.number().int().nonnegative().optional(),
    }).optional(),
    sandbox: z.object({
      extra_writable_paths: z.array(z.string()).optional(),
    }).passthrough().optional(),
    trusted_binaries: z.array(z.string()).optional(),
    hooks: z.record(z.unknown()).optional(),
    /**
     * @deprecated Planning mode has been replaced by plan-run (spawn_plan_run / spawn_plan_run_and_handoff).
     * This field is ignored and will be removed in a future version.
     */
    planning: z.object({
      enabled: z.boolean().default(false),
      skip_labels: z.array(z.string()).default([]),
      auto_approve_on_low: z.boolean().default(false),
      planning_timeout_ms: z.number().default(86400000),
      max_plan_revisions: z.number().default(3),
      template: z.string().optional(),
    }).optional(),
	  }).passthrough().optional(),
  goal: z.object({
    condition: z.string().min(1),
    max_turns: z.number().int().positive().default(50),
    inject_mode: z.enum(["prefix", "system", "none"]).default("prefix"),
    abort_on_max_turns: z.boolean().default(true),
  }).optional(),
  retry: z.object({
    base_delay_ms: z.number().default(5000),
    max_delay_ms: z.number().default(300000),
  }).optional(),
  state_transitions: z.object({
    success: z.string().nullable().default("done"),
    abandoned: z.string().nullable().default("cancelled"),
    handoff: z.string().nullable().default("in_review"),
    needs_retry: z.string().nullable().default(null),
    blocked: z.string().nullable().default("blocked"),
  }).optional().default({}),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
