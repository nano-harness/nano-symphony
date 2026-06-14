import { z } from "zod";
import { AgentResultSummarySchema } from "../spawner/agent-result-payload.ts";

const ValidStatus = z.enum(["success", "needs_retry", "abandoned", "timeout"]);

/**
 * Strict contract validator for agent result summaries.
 *
 * The adapter-level schema is intentionally permissive (.passthrough()) so agents
 * can add diagnostic fields without breaking compatibility. This function applies
 * the stricter cross-project contract rules:
 * - status must be one of the four canonical values
 * - non-success statuses must include a reason
 */
export function validateAgentResultSummary(value: unknown): { ok: true; summary: Record<string, unknown> } | { ok: false; errors: string[] } {
  const schema = AgentResultSummarySchema.superRefine((data, ctx) => {
    const statusCheck = ValidStatus.safeParse(data.status);
    if (!statusCheck.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `status must be one of success, needs_retry, abandoned, timeout`,
        path: ["status"],
      });
      return;
    }
    if (statusCheck.data !== "success" && (!data.reason || typeof data.reason !== "string" || data.reason.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `reason is required for non-success status`,
        path: ["reason"],
      });
    }
  });

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  return { ok: true, summary: parsed.data as Record<string, unknown> };
}
