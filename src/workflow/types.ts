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
  }),
  polling: z.object({
    interval_ms: z.number().default(30000),
    max_concurrent_agents: z.number().default(3),
  }).optional(),
  workspace: z.object({
    root: z.string().default("./workspaces"),
    hooks: z.object({
      after_create: z.string().default(""),
      before_run: z.string().default(""),
      after_run: z.string().default(""),
      before_remove: z.string().default(""),
    }).default({}),
  }).optional(),
  agent: z.object({
    binary: z.string().default("nano"),
    timeout_ms: z.number().default(300000),
    max_retries: z.number().default(3),
    sandbox: z.object({
      backend: z.enum(["native", "docker", "none"]).default("native"),
      network_access: z.boolean().default(true),
      extra_read_only_paths: z.array(z.string()).default([]),
      extra_writable_paths: z.array(z.string()).default([]),
      docker_image: z.string().default("ubuntu:24.04"),
      docker_runtime: z.string().optional(),
    }).default({}),
  }).optional(),
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
  }).optional().default({}),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
