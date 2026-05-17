import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(4123),
  DB_PATH: z.string().default("./symphony.db"),
  WORKFLOW_PATH: z.string().default("./WORKFLOW.md"),
  NANO_BIN: z.string().default("nano"),
  WORKSPACE_ROOT: z.string().default("./workspaces"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  MAX_CONCURRENT_AGENTS: z.coerce.number().int().min(1).default(3),
  MCP_TOKEN_TTL_MS: z.coerce.number().default(3_600_000),
  ORCHESTRATOR_TICK_MS: z.coerce.number().default(5_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse(process.env);
}

export const config = loadConfig();
