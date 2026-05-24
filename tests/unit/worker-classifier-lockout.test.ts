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

/**
 * Creates a fake binary that outputs a given JSON line on stdout (simulating agent result).
 */
async function makeFakeBinaryWithOutput(output: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-lockout-bin-"));
  const bin = path.join(dir, "fake-nano.sh");
  await fs.writeFile(bin, [
    "#!/bin/sh",
    "cat > /dev/null",
    `printf '%s\\n' '${output.replace(/'/g, "'\\''")}'`,
    "exit 0",
  ].join("\n"), "utf-8");
  await fs.chmod(bin, 0o755);
  return bin;
}

async function makeSilentBinary(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-lockout-bin-"));
  const bin = path.join(dir, "fake-nano.sh");
  await fs.writeFile(bin, ["#!/bin/sh", "cat > /dev/null", "exit 0"].join("\n"), "utf-8");
  await fs.chmod(bin, 0o755);
  return bin;
}

describe("worker in-process result delivery", () => {
  test("NoStdoutOutput results in no_result_payload event (abandoned)", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const tracker = createTracker(db);
    tracker.insertIssue({ id: "i3", identifier: "LOCK-3", title: "t", state: "todo" });

    const binary = await makeSilentBinary();
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-workspaces-"));

    await runWorker("i3", 0, {
      tracker,
      workflow: { workflow: { agent: { binary, timeout_ms: 5000 }, workspace: { root: wsRoot, git_baseline: false } } as any, template: "x" },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
    });

    const ev = tracker.getEvents().find((e) => e.issue_id === "i3" && e.kind === "no_result_payload");
    expect(ev).toBeDefined();
  });

  test("ValidStdoutJSON parses and completes successfully", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const tracker = createTracker(db);
    tracker.insertIssue({ id: "i5", identifier: "LOCK-5", title: "t", state: "todo" });

    const output = JSON.stringify({ status: "success", reason: "all done" });
    const binary = await makeFakeBinaryWithOutput(output);
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-workspaces-"));

    await runWorker("i5", 0, {
      tracker,
      workflow: { workflow: { agent: { binary, timeout_ms: 5000 }, workspace: { root: wsRoot, git_baseline: false } } as any, template: "x" },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
    });

    const ev = tracker.getEvents().find((e) => e.issue_id === "i5" && e.kind === "completed");
    expect(ev).toBeDefined();
  });

  test("NeedsRetry stdout triggers retry scheduling", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const tracker = createTracker(db);
    tracker.insertIssue({ id: "i6", identifier: "LOCK-6", title: "t", state: "todo" });

    const output = JSON.stringify({ status: "needs_retry", reason: "temp failure" });
    const binary = await makeFakeBinaryWithOutput(output);
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-workspaces-"));

    await runWorker("i6", 0, {
      tracker,
      workflow: { workflow: { agent: { binary, timeout_ms: 5000, max_retries: 3 }, workspace: { root: wsRoot, git_baseline: false } } as any, template: "x" },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
    });

    const retries = tracker.fetchDueRetries(Date.now() + 600_000);
    expect(retries.length).toBe(1);
    expect(retries[0].issue_id).toBe("i6");
  });
});
