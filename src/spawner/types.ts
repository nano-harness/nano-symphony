export interface SpawnContext {
  issueId: string;
  attempt: number;
  workspace: string;
  prompt: string;
  token: string;
  mcpUrl: string;
  binary: string;
  timeoutMs: number;
  outputDir: string;
  /** Extra env vars to inject into the agent process (from workflow agent.extra_env). */
  extraEnv?: Record<string, string>;
  logger?: { warn: (obj: unknown, msg: string) => void };
}
