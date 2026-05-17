import path from "path";
import fs from "fs/promises";

export interface SpawnOptions {
  issueId: string;
  attempt: number;
  workspace: string;
  prompt: string;
  token: string;
  mcpUrl: string;
  binary: string;
  timeoutMs: number;
  sandboxConfig?: {
    backend: "native" | "docker" | "none";
    network_access: boolean;
    extra_read_only_paths: string[];
    extra_writable_paths: string[];
    docker_image?: string;
    docker_runtime?: string;
  };
}

export interface NanoSentinel {
  status: "success" | "needs_retry" | "abandoned" | "timeout";
  exit_code?: number;
  duration_ms?: number;
  tool_calls?: number;
  tokens?: { input: number; output: number };
  goal_state?: {
    condition: string;
    achieved_at?: string | null;
    started_at?: string;
    turns_evaluated?: number;
    tokens_spent?: number;
    max_turns?: number;
    last_reason?: string;
  };
  cache_key?: string;
  sandbox?: {
    enabled: boolean;
    backend: "none" | "native" | "docker";
    backend_detail?: string;
    network: "inherited" | "allowed" | "denied";
  };
}

export interface SpawnResult {
  exitCode: number | null;
  killedByTimeout: boolean;
  duration_ms: number;
  sentinel: NanoSentinel | null;
}

// Bound to nano-agent's streamable HTTP MCP transport and env-expanded headers.
const nanoAgentConfig = (mcpUrl: string, sandboxConfig?: SpawnOptions["sandboxConfig"]) => {
  const sandbox = sandboxConfig ?? {
    backend: "native",
    network_access: true,
    extra_read_only_paths: [],
    extra_writable_paths: [],
  };

  // Ensure arrays are defined even if sandboxConfig is partially specified
  const extraReadOnlyPaths = sandbox.extra_read_only_paths ?? [];
  const extraWritablePaths = sandbox.extra_writable_paths ?? [];

  const renderYamlList = (key: string, values: string[]) => {
    if (values.length === 0) return `  ${key}: []`;
    return [`  ${key}:`, ...values.map((p) => `    - ${JSON.stringify(p)}`)].join("\n");
  };

  const dockerLines = [
    sandbox.backend === "docker" ? `  docker_image: ${JSON.stringify(sandbox.docker_image ?? "ubuntu:24.04")}` : null,
    sandbox.backend === "docker" && sandbox.docker_runtime
      ? `  docker_runtime: ${JSON.stringify(sandbox.docker_runtime)}`
      : null,
  ].filter((line): line is string => line !== null);

  return `mcpServers:
  symphony:
    url: "${mcpUrl}"
    transport: streamable
    headers:
      # Keep this literal so nano-agent expands SYMPHONY_TOKEN in the child process.
      X-Symphony-Token: "\${env:SYMPHONY_TOKEN}"

sandbox:
  enabled: ${sandbox.backend !== "none"}
  backend: ${sandbox.backend}
  network_access: ${sandbox.network_access}
${renderYamlList("extra_read_only_paths", extraReadOnlyPaths)}
${renderYamlList("extra_writable_paths", extraWritablePaths)}
${dockerLines.length > 0 ? `\n${dockerLines.join("\n")}` : ""}
`;
};

// Exit codes aligned with nano-agent pkg/cli/binary.go:31-36
export const NANO_EXIT = {
  SUCCESS: 0,
  RETRY: 10,
  ABANDONED: 20,
  TIMEOUT: 30,
  UNCLASSIFIED: 1,
} as const;

// Must match nano-agent's binaryResultSentinel (pkg/cli/binary.go:26).
// DO NOT change without verifying against nano-agent source — the unit test
// in tests/unit/sentinel-prefix.test.ts encodes the actual value as a string
// literal that future drift will turn red.
const SENTINEL_PREFIX = "<<<NANO_RESULT>>>";

function extractSentinelFromText(text: string): NanoSentinel | null {
  try {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const idx = lines[i].indexOf(SENTINEL_PREFIX);
      if (idx >= 0) {
        const json = lines[i].slice(idx + SENTINEL_PREFIX.length).trim();
        return JSON.parse(json) as NanoSentinel;
      }
    }
  } catch {
    // sentinel 缺失或解析失败一律视为 null，让 worker 走兜底路径
  }
  return null;
}

export async function spawnAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const { issueId, attempt, workspace, prompt, token, mcpUrl, binary, timeoutMs, sandboxConfig } = opts;

  await fs.writeFile(path.join(workspace, ".nano.yaml"), nanoAgentConfig(mcpUrl, sandboxConfig), "utf-8");

  const logsDir = path.join(workspace, "logs");
  await fs.mkdir(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `attempt-${attempt}.log`);

  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null) as [string, string][]),
    SYMPHONY_ISSUE_ID: issueId,
    SYMPHONY_WORKSPACE: workspace,
    SYMPHONY_TOKEN: token,
    SYMPHONY_MCP_URL: mcpUrl,
    // Sandbox must allow network access for MCP loopback to symphony.
    // Explicitly override any user global environment variables.
    NANO_SANDBOX_NETWORK_ACCESS: "true",
    // Explicitly enable sandbox (double insurance with --sandbox=on flag).
    NANO_SANDBOX_ENABLED: "true",
    NANO_SANDBOX_BACKEND: sandboxConfig?.backend ?? "native",
  };

  const startedAt = Date.now();
  let killedByTimeout = false;

  // Use pipes to capture stdout/stderr in-memory (eliminates flush race)
  const proc = Bun.spawn([binary, "binary", "exec", "--sandbox=on"], {
    cwd: workspace,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Collect stdout and stderr chunks
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const stdoutPromise = (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutChunks.push(value);
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
        stderrChunks.push(value);
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

  // Decode collected output
  const stdoutText = new TextDecoder().decode(Buffer.concat(stdoutChunks.map(c => Buffer.from(c))));
  const stderrText = new TextDecoder().decode(Buffer.concat(stderrChunks.map(c => Buffer.from(c))));

  // Write combined log file for debugging
  await Bun.write(logFile, `${stdoutText}\n--- stderr ---\n${stderrText}`);

  // Extract sentinel from stdout (zero race - all output collected before parsing)
  const sentinel = extractSentinelFromText(stdoutText);

  return { exitCode, killedByTimeout, duration_ms: Date.now() - startedAt, sentinel };
}
