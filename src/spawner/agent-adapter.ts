import type { AgentResultSummary, AgentArtifacts } from "./agent-result-payload.ts";
import type { SpawnContext } from "./types.ts";

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
   * Read artifacts produced by the agent (e.g. files in --output-dir).
   * Async because it touches the filesystem. MUST NOT throw — return an
   * empty `{}` on any I/O failure.
   */
  collectArtifacts(ctx: SpawnContext): Promise<AgentArtifacts>;

  /**
   * Optional: one-time async preparation before the first spawn (e.g. check
   * binary availability, warm caches). Called at most once per process.
   */
  prepare?(): Promise<void>;

  /**
   * Optional: Parse a single streaming line from stdout during execution.
   * Returns a tracker event input if the line is meaningful, or null.
   * Used to emit real-time events (e.g. tool calls, progress) to the tracker.
   */
  parseStreamingLine?(line: string): { kind: string; message: string; payload?: Record<string, unknown> } | null;
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
