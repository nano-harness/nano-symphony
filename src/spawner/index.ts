import path from "path";
import fs from "fs/promises";
import type { SpawnContext } from "./types.ts";
import type { AgentResultSummary, AgentArtifacts } from "./agent-result-payload.ts";
import { getAdapter, type AgentKind } from "./agent-adapter.ts";

// Eagerly import adapters so they self-register
import "./adapters/nano.ts";
import "./adapters/claude-code.ts";

export type { SpawnContext } from "./types.ts";

export interface SpawnOptions {
  issueId: string;
  attempt: number;
  workspace: string;
  prompt: string;
  token: string;
  mcpUrl: string;
  binary: string;
  timeoutMs: number;
  agentKind?: AgentKind;
  logger?: { warn: (obj: unknown, msg: string) => void };
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
}

export interface SpawnResult {
  exitCode: number | null;
  killedByTimeout: boolean;
  duration_ms: number;
  agentResult: AgentResultSummary | null;
  artifacts: AgentArtifacts;
}

// Exit codes aligned with nano-agent pkg/cli/binary.go:31-36
export const NANO_EXIT = {
  SUCCESS: 0,
  RETRY: 10,
  ABANDONED: 20,
  TIMEOUT: 30,
  UNCLASSIFIED: 1,
} as const;

export async function spawnAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const { issueId, attempt, workspace, prompt, token, mcpUrl, binary, timeoutMs, sandboxConfig, permissionMode, permissionAuto, logger } = opts;
  const agentKind: AgentKind = opts.agentKind ?? "nano";
  const adapter = getAdapter(agentKind);

  const outputDir = path.join(workspace, ".nano-out");
  await fs.mkdir(outputDir, { recursive: true });

  const ctx: SpawnContext = {
    issueId,
    attempt,
    workspace,
    prompt,
    token,
    mcpUrl,
    binary,
    timeoutMs,
    outputDir,
    sandboxConfig,
    permissionMode,
    permissionAuto,
    logger,
  };

  // Write workspace files produced by the adapter
  const files = adapter.renderWorkspaceFiles(ctx);
  for (const file of files) {
    const filePath = path.join(workspace, file.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.contents, { encoding: "utf-8", mode: file.mode });
  }

  const logsDir = path.join(workspace, "logs");
  await fs.mkdir(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `attempt-${attempt}.log`);

  // Build spawn invocation from adapter
  const invocation = adapter.buildSpawnInvocation(ctx);

  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null) as [string, string][]),
    ...invocation.env,
  };

  const startedAt = Date.now();
  let killedByTimeout = false;

  // Use pipes to capture stdout/stderr
  const proc = Bun.spawn(invocation.argv, {
    cwd: workspace,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Open log file for streaming writes
  const { createWriteStream } = await import("node:fs");
  const { finished } = await import("node:stream/promises");

  const logStream = createWriteStream(logFile, { flags: "w" });
  logStream.write("--- log start ---\n");

  // Capture stdout fully for result parsing
  const stdoutChunks: Uint8Array[] = [];

  const stdoutPromise = (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutChunks.push(value);
        logStream.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  })();

  const stderrPromise = (async () => {
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        logStream.write("[err] ");
        logStream.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  })();

  const timeoutHandle = setTimeout(() => {
    killedByTimeout = true;
    proc.kill();
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  // Wait for all output to be collected
  await Promise.all([stdoutPromise, stderrPromise]);

  // Close the log stream
  logStream.end();
  await finished(logStream);

  // Parse result from stdout
  const decoder = new TextDecoder();
  const stdoutText = stdoutChunks.map(c => decoder.decode(c, { stream: true })).join("") + decoder.decode();
  const agentResult = adapter.parseResult(stdoutText);

  // Collect artifacts
  const artifacts = await adapter.collectArtifacts(ctx);

  return { exitCode, killedByTimeout, duration_ms: Date.now() - startedAt, agentResult, artifacts };
}
