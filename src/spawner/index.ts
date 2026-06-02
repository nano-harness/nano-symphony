import path from "path";
import fs from "fs/promises";
import type { SpawnContext } from "./types.ts";
import type { AgentResultSummary, AgentArtifacts } from "./agent-result-payload.ts";
import { getAdapter, type AgentKind } from "./agent-adapter.ts";
import { stripSymphonyInternals } from "./env.ts";

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
  onStreamEvent?: (event: { kind: string; message: string; payload?: Record<string, unknown> }) => void;
  // S9: Called with the spawned process PID so the caller can persist it for crash-restart cleanup.
  onPidAssigned?: (pid: number) => void;
  /** Extra env vars forwarded verbatim to the agent process (from workflow agent.extra_env). */
  extraEnv?: Record<string, string>;
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

// Map of issueId → active subprocess for cancel support
const activeProcesses = new Map<string, { proc: ReturnType<typeof Bun.spawn>; kill: () => void }>();
const SIGKILL_ESCALATION_MS = 3000;

/**
 * Cancel a running agent by issueId. Sends SIGTERM, then SIGKILL after timeout.
 * Returns true if a process was found and killed, false otherwise.
 */
export function cancelAgent(issueId: string): boolean {
  const entry = activeProcesses.get(issueId);
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
  const { issueId, attempt, workspace, prompt, token, mcpUrl, binary, timeoutMs, logger, onStreamEvent, onPidAssigned } = opts;
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
    extraEnv: opts.extraEnv,
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

  // Env: start from user's full environment minus symphony's own service credentials,
  // then merge adapter-specific vars (MCP URL, token, etc.) and workflow extra_env.
  const env: Record<string, string> = {
    ...stripSymphonyInternals(process.env),
    ...invocation.env,
    ...(opts.extraEnv ?? {}),
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

  // Register process for cancel support — kill the entire process tree
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const KILL_SIGNALS = new Set(["SIGTERM", "SIGKILL"]);
  const killProcessTree = (pid: number, signal: string) => {
    if (!KILL_SIGNALS.has(signal)) return;
    try { Bun.spawnSync(["pkill", `-${signal}`, "-P", String(pid)]); } catch { /* best-effort */ }
    try { process.kill(pid, signal as NodeJS.Signals); } catch { /* already dead */ }
  };
  const killFn = () => {
    const pid = proc.pid;
    killProcessTree(pid, "SIGTERM");
    killTimer = setTimeout(() => killProcessTree(pid, "SIGKILL"), SIGKILL_ESCALATION_MS);
  };
  activeProcesses.set(issueId, { proc, kill: killFn });
  // S9: Notify caller of the PID so it can be persisted for crash-restart cleanup.
  onPidAssigned?.(proc.pid);

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
          } else {
            stdoutChunks.push(value);
          }
        }
        // Tail ring buffer: always keep the most recent TAIL_BUFFER_LIMIT bytes so
        // the final result JSON line is never dropped.
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
  activeProcesses.delete(issueId);

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
