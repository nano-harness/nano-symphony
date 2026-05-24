import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs/promises";
import os from "os";
import path from "path";
import pino from "pino";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { runWorker } from "../../src/orchestrator/worker.ts";

const silentLogger = pino({ level: "silent" });

function mkTracker() {
  const db = new Database(":memory:");
  runMigrations(db);
  return createTracker(db);
}

async function makeFakeBinaryWithOutput(output: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-tokfake-"));
  const bin = path.join(dir, "fake-nano.sh");
  await fs.writeFile(
    bin,
    ["#!/bin/sh", "cat > /dev/null", `printf '%s\\n' '${output.replace(/'/g, "'\\''")}'`, "exit 0"].join("\n"),
    "utf-8",
  );
  await fs.chmod(bin, 0o755);
  return bin;
}

describe("worker auto-records token stats from agent result payload", () => {
  test("populates symphony_runs token columns when payload.tokens present", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({ id: "tok-1", identifier: "TOK-1", title: "t", state: "todo" });
    const output = JSON.stringify({
      status: "success",
      tokens: { input: 12345, output: 678 },
      goal_state: { last_reason: "ok" },
    });
    const binary = await makeFakeBinaryWithOutput(output);
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-workspaces-"));

    await runWorker("tok-1", 0, {
      tracker,
      workflow: { workflow: { agent: { binary, timeout_ms: 5000 }, workspace: { root: wsRoot, git_baseline: false } } as any, template: "x" },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
    });

    const run = tracker.getRun("tok-1")!;
    expect(run.token_input).toBe(12345);
    expect(run.token_output).toBe(678);
    expect(run.token_total).toBe(12345 + 678);
  });

  test("leaves token columns at 0 when payload has no tokens field", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({ id: "tok-2", identifier: "TOK-2", title: "t", state: "todo" });
    const output = JSON.stringify({ status: "success" });
    const binary = await makeFakeBinaryWithOutput(output);
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-workspaces-"));

    await runWorker("tok-2", 0, {
      tracker,
      workflow: { workflow: { agent: { binary, timeout_ms: 5000 }, workspace: { root: wsRoot, git_baseline: false } } as any, template: "x" },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
    });

    const run = tracker.getRun("tok-2")!;
    expect(run.token_input).toBe(0);
    expect(run.token_output).toBe(0);
    expect(run.token_total).toBe(0);
  });
});
