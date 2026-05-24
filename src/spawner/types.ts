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
  sandboxConfig?: {
    backend: "native" | "docker" | "none";
    network_access: boolean;
    extra_read_only_paths: string[];
    extra_writable_paths: string[];
    extra_denied_paths: string[];
    docker_image?: string;
    docker_runtime?: string;
  };
  permissionMode?: string;
  permissionAuto?: {
    backend: "llm" | "fail_closed";
    model?: string;
    confidence_threshold: number;
    timeout_seconds: number;
    cache_ttl_minutes: number;
    allow_rules: string[];
    denial_max_consecutive: number;
    denial_max_total: number;
  };
  logger?: { warn: (obj: unknown, msg: string) => void };
}
