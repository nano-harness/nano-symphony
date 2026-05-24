import { z } from "zod";

// .passthrough() allows agent diagnostic fields (termination_cause, cache_key,
// goal_state.condition, etc.) without rejecting the payload. Declared fields
// are still validated (status enum, token integers, blocked_commands_sample max 20).
export const AgentResultSummarySchema = z.object({
  status: z.enum(["success", "needs_retry", "abandoned", "timeout"]),
  reason: z.string().optional(),
  goal_state: z.object({
    last_reason: z.string().optional(),
    iterations: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
  tokens: z.object({
    input: z.number().int().nonnegative().optional(),
    output: z.number().int().nonnegative().optional(),
    cached: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
  blocked_commands_sample: z.array(z.string()).max(20).optional(),
  sandbox: z.object({
    backend: z.string().optional(),
    network: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export type AgentResultSummary = z.infer<typeof AgentResultSummarySchema>;

export const AgentArtifactsSchema = z.object({
  patch: z.string().optional(),
});
export type AgentArtifacts = z.infer<typeof AgentArtifactsSchema>;

