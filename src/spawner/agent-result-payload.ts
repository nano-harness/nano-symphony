import { z } from "zod";
import type { ZodSchema } from "zod";

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

// S8: Sanitize a parsed JSON value to remove prototype-pollution keys before
// passing to schema validation. Handles nested objects recursively.
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function sanitizeProto(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeProto);
  const clean = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!PROTO_KEYS.has(k)) clean[k] = sanitizeProto(v);
  }
  return clean;
}

/**
 * Parses a JSON line from a text blob (scanning from end), validating against the given Zod schema.
 * Used by adapters to extract structured result from agent stdout.
 *
 * Strategy: try parsing the entire trimmed text as JSON first (handles single-line output),
 * then scans lines from end to find the first valid match. This handles trailing empty lines,
 * stderr prefixes, or other noise after the actual result line.
 *
 * @returns The parsed value on success, or null if parsing/validation fails.
 */
export function parseLastJsonLine<T>(text: string, schema: ZodSchema<T>): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Try parsing the entire text first (covers single JSON blob output)
  try {
    const json = sanitizeProto(JSON.parse(trimmed));
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
  } catch {
    // Not valid JSON as a whole — fall through to line scan
  }

  // 2. Scan lines from end, try each (skips trailing blanks and stderr markers)
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const json = sanitizeProto(JSON.parse(line));
      const parsed = schema.safeParse(json);
      if (parsed.success) return parsed.data;
    } catch { continue; }
  }

  return null;
}
