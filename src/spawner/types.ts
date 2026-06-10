/** Adapter-specific config derived from the workflow agent section. */
export interface AgentAdapterConfig {
  permission_mode?: string;
  permissions?: {
    allow?: string[];
    deny?: string[];
    denial_max_consecutive?: number;
    denial_max_total?: number;
  };
  sandbox?: {
    extra_writable_paths?: string[];
    [key: string]: unknown;
  };
  trusted_binaries?: string[];
  hooks?: Record<string, unknown>;
}

export interface SpawnContext {
  issueUuid: string;
  attempt: number;
  workspace: string;
  prompt: string;
  token: string;
  mcpUrl: string;
  outputDir: string;
  /** Extra env vars to inject into the agent process (from workflow agent.extra_env). */
  extraEnv?: Record<string, string>;
  logger?: { warn: (obj: unknown, msg: string) => void };
  /** Adapter-specific config derived from the workflow agent section. */
  config: AgentAdapterConfig;
}
