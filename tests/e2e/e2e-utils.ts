import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

type MockSemantics = "success" | "needs_retry" | "handoff" | "abandoned";

export interface E2eOptions {
  mockSemantics?: MockSemantics;
  mockSkipComplete?: boolean;
  mockSleepSec?: number;
  mockFailFetch?: boolean;
  timeoutSec?: number;
  realBinary?: string;       // If provided, uses real nano-agent instead of mock
  promptOverride?: string;   // Custom prompt template
}

export interface E2eResult {
  issueId: string;
  run: any;
  events: any[];
  baseUrl: string;
  e2eRoot: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000); // 20s timeout
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, tickMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(tickMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function buildWorkflowMd(agentBinary: string, mockEnv: Record<string, string>, promptOverride?: string): string {
  const defaultPrompt = "{{ issue.title }}\\n\\nAttempt: {{ attempt }}\\n\\n{{ issue.description }}";
  const prompt = promptOverride ?? defaultPrompt;

  const lines = [
    "---",
    "tracker:",
    "  type: e2e",
    "agent:",
    `  binary: \"${agentBinary.replace(/\\/g, "\\\\")}\"`,
    "  timeout_ms: 10000",
    "  max_retries: 0",
  ];

  if (Object.keys(mockEnv).length > 0) {
    lines.push("  extra_env:");
    for (const [k, v] of Object.entries(mockEnv)) {
      lines.push(`    ${k}: "${v}"`);
    }
  }

  lines.push(
    "---",
    "",
    "# nano-symphony e2e WORKFLOW",
    "",
    prompt,
    ""
  );

  return lines.join("\n");
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port ?? 0;
  server.stop();
  if (!port) throw new Error("Failed to allocate free port");
  return port;
}

export async function runE2e(opts: E2eOptions = {}): Promise<E2eResult> {
  const repoRoot = process.cwd();
  const port = await getFreePort();
  const baseUrl = `http://localhost:${port}`;
  const timeoutSec = opts.timeoutSec ?? 10;

  const e2eRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-e2e-"));
  const dbPath = path.join(e2eRoot, "symphony.db");
  const workspacesRoot = path.join(e2eRoot, "workspaces");
  const workflowPath = path.join(e2eRoot, "WORKFLOW.md");
  const mockAgentPath = path.join(repoRoot, "scripts", "mock-agent.sh");
  const agentBinary = opts.realBinary ?? mockAgentPath;

  await fs.mkdir(workspacesRoot, { recursive: true });

  // Build mock env vars to inject into the agent process via agent.extra_env in the workflow YAML.
  // (S3: the spawner's ENV_ALLOWLIST blocks server env vars from reaching child processes, so mock
  // test vars must be passed explicitly through the workflow config instead.)
  const mockEnv: Record<string, string> = {};
  if (!opts.realBinary) {
    mockEnv.MOCK_SEMANTICS = opts.mockSemantics ?? "success";
    if (opts.mockSkipComplete) mockEnv.MOCK_SKIP_COMPLETE = "1";
    if (opts.mockFailFetch) mockEnv.MOCK_FAIL_FETCH = "1";
    if (opts.mockSleepSec != null) mockEnv.MOCK_SLEEP_BEFORE_COMPLETE = String(opts.mockSleepSec);
  }

  await fs.writeFile(workflowPath, buildWorkflowMd(agentBinary, mockEnv, opts.promptOverride), "utf-8");

  const e2eApiToken = "e2e-test-api-token";
  const env: Record<string, string> = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    WORKSPACE_ROOT: workspacesRoot,
    WORKFLOW_PATH: workflowPath,
    NANO_BIN: agentBinary,
    // S1: Provide a stable token for e2e so all API calls can authenticate.
    API_TOKEN: e2eApiToken,
  };

  const authHeaders = { "X-Symphony-Token": e2eApiToken };

  // Use absolute path to bun to avoid PATH issues in CI/test environments
  const bunPath = Bun.which("bun") ?? process.execPath;
  const server = Bun.spawn([bunPath, "src/index.ts"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const readOutput = async () => {
    const stdout = await new Response(server.stdout).text().catch(() => "");
    const stderr = await new Response(server.stderr).text().catch(() => "");
    return { stdout, stderr };
  };

  try {
    // Wait for server to start (with timeout). Use /api/v1/health (auth-exempt) to detect readiness.
    await waitFor(async () => {
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${baseUrl}/api/v1/health`, { signal: controller.signal }).finally(() => clearTimeout(tid));
        return res.ok;
      } catch {
        return false;
      }
    }, 20_000);

    const issue = await fetchJson(`${baseUrl}/api/v1/issues`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        identifier: `E2E-${port}`,
        title: "E2E debug issue",
        description: "Created by bun:test",
        priority: "medium",
        state: "todo",
        labels: ["e2e"],
      }),
    });

    const issueId = issue?.id as string | undefined;
    if (!issueId) throw new Error(`Missing issue id in response: ${JSON.stringify(issue)}`);

    // Default orchestrator tick is 5s; give it enough time.
    await waitFor(
      async () => {
        try {
          const run = await fetchJson(`${baseUrl}/api/v1/runs/${issueId}`, { headers: authHeaders });
          const state = String(run.last_state);
          return ["released", "in_review", "paused", "cancelled", "retry_queued"].includes(state);
        } catch {
          return false;
        }
      },
      (timeoutSec + 30) * 1000
    );

    const run = await fetchJson(`${baseUrl}/api/v1/runs/${issueId}`, { headers: authHeaders });
    const events = await fetchJson(`${baseUrl}/api/v1/events`, { headers: authHeaders });
    const issueEvents = (events as any[]).filter((e) => e.issue_id === issueId);

    return { issueId, run, events: issueEvents, baseUrl, e2eRoot };
  } catch (err) {
    const out = await readOutput();
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n\n` +
        `server stdout:\n${out.stdout}\n\nserver stderr:\n${out.stderr}`
    );
  } finally {
    server.kill();
    await server.exited;
    await fs.rm(e2eRoot, { recursive: true, force: true });
  }
}
