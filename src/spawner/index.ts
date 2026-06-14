import path from "path";
import fs from "fs/promises";
import type { SpawnContext, AgentAdapterConfig } from "./types.ts";
import type { AgentResultSummary, AgentArtifacts } from "./agent-result-payload.ts";
import { getAdapter, type AgentKind } from "./agent-adapter.ts";
import { stripSymphonyInternals } from "./env.ts";

// Eagerly import adapters so they self-register
import "./adapters/nano.ts";
import "./adapters/claude-code.ts";

// Track which adapters have been prepared (prepare() is idempotent but should only run once)
const preparedAdapters = new Set<string>();

export type { SpawnContext, AgentAdapterConfig } from "./types.ts";

export interface SpawnOptions {
  issueUuid: string;
  attempt: number;
  workspace: string;
  prompt: string;
  token: string;
  mcpUrl: string;
  binary: string;
  timeoutMs: number;
  /** Agent kind for adapter selection. */
  agentKind: AgentKind;
  logger?: { warn: (obj: unknown, msg: string) => void };
  onStreamEvent?: (event: { kind: string; message: string; payload?: Record<string, unknown> }) => void;
  // S9: Called with the spawned process PID so the caller can persist it for crash-restart cleanup.
  onPidAssigned?: (pid: number) => void;
  // Heartbeat: track last heartbeat timestamp for liveness monitoring
  onHeartbeat?: (ts: number) => void;
  /** Extra env vars forwarded verbatim to the agent process (from workflow agent.extra_env). */
  extraEnv?: Record<string, string>;
  /** Agent-specific config (permissions, sandbox paths, etc.) derived from workflow agent section. */
  agentConfig?: AgentAdapterConfig;
}

export interface SpawnResult {
  exitCode: number | null;
  killedByTimeout: boolean;
  duration_ms: number;
  agentResult: AgentResultSummary | null;
  artifacts: AgentArtifacts;
  // S10: True if stdout was truncated at the 32MB cap.
  stdoutTruncated?: boolean;
}

// Exit codes aligned with nano-agent pkg/cli/binary.go:31-36
export const NANO_EXIT = {
  SUCCESS: 0,
  RETRY: 10,
  ABANDONED: 20,
  TIMEOUT: 30,
  UNCLASSIFIED: 1,
} as const;

// Map of issueUuid → active subprocess for cancel support
const activeProcesses = new Map<string, { proc: ReturnType<typeof Bun.spawn>; kill: () => void }>();
const SIGKILL_ESCALATION_MS = 3000;

/**
 * Cancel a running agent by issueUuid. Sends SIGTERM, then SIGKILL after timeout.
 * Returns true if a process was found and killed, false otherwise.
 */
export function cancelAgent(issueUuid: string): boolean {
  const entry = activeProcesses.get(issueUuid);
  if (!entry) return false;
  entry.kill();
  return true;
}

/** Returns the number of currently active agent processes. */
export function getActiveProcessCount(): number {
  return activeProcesses.size;
}

/** Force-kill all active agent processes. Used during shutdown. */
export function killAllAgents(): void {
  for (const [, entry] of activeProcesses) {
    entry.kill();
  }
}

export async function spawnAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const { issueUuid, attempt, workspace, prompt, token, mcpUrl, binary, timeoutMs, logger, onStreamEvent, onPidAssigned, onHeartbeat } = opts;
  const agentKind: AgentKind = opts.agentKind ?? "claude-code";
  const adapter = getAdapter(agentKind);

  // One-time adapter preparation (e.g. binary check, cache warm-up)
  if (adapter.prepare && !preparedAdapters.has(agentKind)) {
    preparedAdapters.add(agentKind);
    await adapter.prepare();
  }

  const outputDir = path.join(workspace, ".nano-out");
  await fs.mkdir(outputDir, { recursive: true });

  const ctx: SpawnContext = {
    issueUuid,
    attempt,
    workspace,
    prompt,
    token,
    mcpUrl,
    outputDir,
    extraEnv: opts.extraEnv,
    logger,
    config: opts.agentConfig ?? {},
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

  // S10: Spawner injects binary at argv[0] so all adapters are consistent
  const argv = [opts.binary, ...invocation.argv];

  // Env: start from user's full environment minus symphony's own service credentials,
  // then merge adapter-specific vars (MCP URL, token, etc.) and workflow extra_env.
  const env: Record<string, string> = {
    ...stripSymphonyInternals(process.env),
    ...invocation.env,
    SYMPHONY_MCP_URL: opts.mcpUrl,
    SYMPHONY_TOKEN: opts.token,
    // Stable identity for agent-side cache/resume correlation.
    SYMPHONY_RESUME_IDENTITY: `${opts.issueUuid}:${opts.attempt}`,
    NANO_CACHE_KEY: opts.issueUuid,
    ...(opts.extraEnv ?? {}),
  };

  const startedAt = Date.now();
  let killedByTimeout = false;

  // Use pipes to capture stdout/stderr
  const proc = Bun.spawn(argv, {
    cwd: workspace,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Register process for cancel support — kill the entire process tree
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const KILL_SIGNALS = new Set(["SIGTERM", "SIGKILL"]);
  const killProcessTree = (pid: number, signal: string) => {
    if (!KILL_SIGNALS.has(signal)) return;
    if (process.platform === "darwin") {
      // macOS: pkill -P only kills direct children. Use a recursive approach
      // to find and kill the entire process subtree via pgrep + recursive kill.
      const killDescendants = (parentPid: number) => {
        try {
          const result = Bun.spawnSync(["pgrep", "-P", String(parentPid)]);
          const output = result.stdout.toString().trim();
          if (output) {
            for (const childPid of output.split("\n").map(Number).filter(Boolean)) {
              killDescendants(childPid);
            }
          }
        } catch { /* best-effort */ }
        try { process.kill(parentPid, signal as NodeJS.Signals); } catch { /* already dead */ }
      };
      killDescendants(pid);
    } else {
      // Linux: pkill -P reliably kills the process group children
      try { Bun.spawnSync(["pkill", `-${signal}`, "-P", String(pid)]); } catch { /* best-effort */ }
      try { process.kill(pid, signal as NodeJS.Signals); } catch { /* already dead */ }
    }
  };
  const killFn = () => {
    const pid = proc.pid;
    killProcessTree(pid, "SIGTERM");
    killTimer = setTimeout(() => killProcessTree(pid, "SIGKILL"), SIGKILL_ESCALATION_MS);
  };
  activeProcesses.set(issueUuid, { proc, kill: killFn });
  // S9: Notify caller of the PID so it can be persisted for crash-restart cleanup.
  onPidAssigned?.(proc.pid);

  // Heartbeat: start a process-level heartbeat timer that updates heartbeat_at
  // while the agent process is alive. This catches process crashes (SIGKILL, OOM, etc.)
  // without requiring the agent to explicitly call a heartbeat MCP tool.
  const heartbeatInterval = opts.agentKind === "nano" ? 30_000 : 60_000; // nano: 30s, claude-code: 60s
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (onHeartbeat) {
    heartbeatTimer = setInterval(() => {
      onHeartbeat(Date.now());
    }, heartbeatInterval);
  }

  proc.stdin.write(prompt);
  proc.stdin.end();

  // Open log file for streaming writes
  const { createWriteStream } = await import("node:fs");
  const { finished } = await import("node:stream/promises");

  const logStream = createWriteStream(logFile, { flags: "w" });
  logStream.write("--- log start ---\n");

  // Capture stdout for result parsing.
  // A1: Cap head accumulation at 32MB to prevent OOM from runaway agents.
  // Additionally keep a 1MB tail ring buffer so the final JSON result line (which
  // appears at the very end of stdout) is always available even when the head is
  // truncated.  Without the tail buffer a >32MB run would be misclassified as
  // abandoned/no_result_payload because parseResult could not find the JSON line.
  const STDOUT_BUFFER_LIMIT = 32 * 1024 * 1024; // 32MB head cap
  const TAIL_BUFFER_LIMIT = 1 * 1024 * 1024;   // 1MB tail ring buffer
  const stdoutChunks: Uint8Array[] = [];
  const tailChunks: Uint8Array[] = [];
  let stdoutBytes = 0;
  let tailBytes = 0;
  let stdoutTruncated = false;
  const lineDecoder = new TextDecoder();
  let lineBuf = "";

  const stdoutPromise = (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Head buffer: accumulate until the cap.
        if (!stdoutTruncated) {
          stdoutBytes += value.byteLength;
          if (stdoutBytes > STDOUT_BUFFER_LIMIT) {
            stdoutTruncated = true;
            // The chunk that crosses the boundary goes into the tail buffer
            // so it isn't lost (it may contain the start of the result JSON).
          } else {
            stdoutChunks.push(value);
          }
        }
        // Tail ring buffer: always keep the most recent TAIL_BUFFER_LIMIT bytes so
        // the final result JSON line is never dropped.  This includes the
        // boundary-crossing chunk that triggered truncation.
        if (stdoutTruncated) {
          tailChunks.push(value);
          tailBytes += value.byteLength;
          // Trim oldest tail chunks when over budget
          while (tailBytes > TAIL_BUFFER_LIMIT && tailChunks.length > 1) {
            tailBytes -= tailChunks.shift()!.byteLength;
          }
        }
        logStream.write(value);

        // Parse streaming lines for real-time events
        if (onStreamEvent && adapter.parseStreamingLine) {
          lineBuf += lineDecoder.decode(value, { stream: true });
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop() ?? "";
          for (const line of lines) {
            const ev = adapter.parseStreamingLine(line);
            if (ev) onStreamEvent(ev);
          }
        }
      }
      // Process any remaining partial line
      if (onStreamEvent && adapter.parseStreamingLine && lineBuf.trim()) {
        const ev = adapter.parseStreamingLine(lineBuf);
        if (ev) onStreamEvent(ev);
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
    killFn(); // S3: kill entire process tree (same as cancel), not just the direct child
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);
  if (killTimer) clearTimeout(killTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  activeProcesses.delete(issueUuid);

  // Wait for all output to be collected
  await Promise.all([stdoutPromise, stderrPromise]);

  // Close the log stream
  logStream.end();
  await finished(logStream);

  // Parse result from stdout: combine head buffer with tail ring buffer.
  // When truncated, the tail contains the bytes most likely to hold the result JSON line.
  const decoder = new TextDecoder();
  let stdoutText: string;
  if (stdoutTruncated && tailChunks.length > 0) {
    const headText = stdoutChunks.map(c => decoder.decode(c, { stream: true })).join("") + decoder.decode();
    // Reuse decoder (flushed above) for the tail chunks.
    const tailText = tailChunks.map(c => decoder.decode(c, { stream: true })).join("") + decoder.decode();
    // Combine: head + separator + tail.  parseResult scans from the end of the
    // string, so placing the tail at the end guarantees the final result line
    // is found even if it is not in the first 32MB.
    stdoutText = headText + "\n" + tailText;
  } else {
    stdoutText = stdoutChunks.map(c => decoder.decode(c, { stream: true })).join("") + decoder.decode();
  }
  const agentResult = adapter.parseResult(stdoutText);

  // Collect artifacts
  const artifacts = await adapter.collectArtifacts(ctx);

  return { exitCode, killedByTimeout, duration_ms: Date.now() - startedAt, agentResult, artifacts, stdoutTruncated };
}
