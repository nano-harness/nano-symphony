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

async function makeFakeBinary(stdoutLine: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-tokfake-"));
  const bin = path.join(dir, "fake-nano.sh");
  await fs.writeFile(
    bin,
    ["#!/bin/sh", "cat > /dev/null", `printf '%s\\n' '${stdoutLine.replace(/'/g, "'\\''")}'`].join("\n"),
    "utf-8",
  );
  await fs.chmod(bin, 0o755);
  return bin;
}

describe("worker auto-records token stats from sentinel", () => {
  test("populates symphony_runs token columns when sentinel.tokens present", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({ id: "tok-1", identifier: "TOK-1", title: "t", state: "todo" });
    const binary = await makeFakeBinary(
      `<<<NANO_RESULT>>>{"status":"success","tokens":{"input":12345,"output":678},"goal_state":{"condition":"x","achieved_at":"2026-05-17T00:00:00Z","last_reason":"ok"}}`,
    );

    await runWorker("tok-1", 0, {
      tracker,
      workflow: { workflow: { agent: { binary, timeout_ms: 5000 } } as any, template: "x" },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
    });

    const run = tracker.getRun("tok-1")!;
    expect(run.token_input).toBe(12345);
    expect(run.token_output).toBe(678);
    expect(run.token_total).toBe(12345 + 678);
  });

  test("leaves token columns at 0 when sentinel has no tokens field", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({ id: "tok-2", identifier: "TOK-2", title: "t", state: "todo" });
    const binary = await makeFakeBinary(
      `<<<NANO_RESULT>>>{"status":"success","goal_state":{"condition":"x","achieved_at":"2026-05-17T00:00:00Z"}}`,
    );

    await runWorker("tok-2", 0, {
      tracker,
      workflow: { workflow: { agent: { binary, timeout_ms: 5000 } } as any, template: "x" },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
    });

    const run = tracker.getRun("tok-2")!;
    expect(run.token_input).toBe(0);
    expect(run.token_output).toBe(0);
    expect(run.token_total).toBe(0);
  });
});
