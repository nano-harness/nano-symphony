import type { AgentResultSummary, AgentArtifacts } from "./agent-result-payload.ts";
import type { SpawnContext } from "./types.ts";
import type { Workflow } from "../workflow/types.ts";

export type AgentKind = "nano" | "claude-code";

export interface WorkspaceFile {
  path: string;       // relative to workspace root
  contents: string;
  mode: number;       // 0o755 / 0o644
}

export interface SpawnInvocation {
  argv: string[];
  env: Record<string, string>;
}

export interface SandboxConfig {
  backend: "native" | "docker" | "none";
  network_access: boolean;
  extra_read_only_paths: string[];
  extra_writable_paths: string[];
  extra_denied_paths: string[];
  docker_image?: string;
  docker_runtime?: string;
}

export interface AgentAdapter {
  kind: AgentKind;
  renderWorkspaceFiles(ctx: SpawnContext): WorkspaceFile[];
  buildSpawnInvocation(ctx: SpawnContext): SpawnInvocation;
  /**
   * Parse the agent's captured stdout (after exit). Returns the
   * AgentResultSummary if parseable, or null otherwise. MUST NOT throw.
   */
  parseResult(stdout: string): AgentResultSummary | null;
  /**
   * Read artifacts produced by the agent (e.g. solution.patch in
   * --output-dir). Async because it touches the filesystem. MUST NOT
   * throw — return an empty `{}` on any I/O failure.
   */
  collectArtifacts(ctx: SpawnContext): Promise<AgentArtifacts>;

  /**
   * Optional: Parse a single streaming line from stdout during execution.
   * Returns a tracker event input if the line is meaningful, or null.
   * Used to emit real-time events (e.g. tool calls, progress) to the tracker.
   */
  parseStreamingLine?(line: string): { kind: string; message: string; payload?: Record<string, unknown> } | null;

  /**
   * Optional: Resolve the permission mode for this agent kind.
   * If not implemented, falls back to the workflow's configured permission_mode.
   * This hook allows agent-specific logic (e.g. nano's "auto" default) without
   * leaking agent knowledge into the generic worker.
   */
  resolvePermissionMode?(agentConfig: Workflow["agent"] | undefined): string | undefined;

  /**
   * Optional: Apply a permission-mode floor when sandbox is disabled.
   * Returns the adjusted mode and the original (for logging), or null if no floor applies.
   * This hook allows nano to enforce "don't run permissive without sandbox" without
   * the worker needing agent-specific branching.
   */
  applyPermissionFloor?(ctx: {
    resolvedPermissionMode: string | undefined;
    sandboxOff: boolean;
    agentConfig: Workflow["agent"] | undefined;
  }): { resolvedPermissionMode: string | undefined; floored: { from: string; to: string } | null };
}

const REGISTRY = new Map<AgentKind, AgentAdapter>();

export function registerAdapter(a: AgentAdapter): void {
  REGISTRY.set(a.kind, a);
}

export function getAdapter(kind: AgentKind): AgentAdapter {
  const a = REGISTRY.get(kind);
  if (!a) throw new Error(`no AgentAdapter registered for kind "${kind}"`);
  return a;
}
