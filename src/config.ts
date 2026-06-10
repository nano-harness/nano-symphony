import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(4123),
  HOST: z.string().default("127.0.0.1"),
  API_TOKEN: z.string().optional(),
  DB_PATH: z.string().default("./symphony.db"),
  WORKFLOW_PATH: z.string().default("./WORKFLOW.md"),
  NANO_BIN: z.string().default("claude"),
  WORKSPACE_ROOT: z.string().default("./workspaces"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  MAX_CONCURRENT_AGENTS: z.coerce.number().int().min(1).default(3),
  MCP_TOKEN_TTL_MS: z.coerce.number().default(3_600_000),
  ORCHESTRATOR_TICK_MS: z.coerce.number().default(5_000),
  ALLOW_REVEAL_WORKSPACE: z.coerce.boolean().default(true),
  RUN_LOG_PATH: z.string().default("./run_log.jsonl"),
  RUN_LOG_ENABLED: z.coerce.boolean().default(true),
  // Heartbeat configuration
  AGENT_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  AGENT_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(120_000),
  AGENT_HEARTBEAT_STALE_ACTION: z.enum(["cancel_then_retry", "retry", "abandon"]).default("cancel_then_retry"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse(process.env);
}

export const config = loadConfig();
