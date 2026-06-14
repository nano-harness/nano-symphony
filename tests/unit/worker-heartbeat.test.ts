import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs/promises";
import os from "os";
import path from "path";
import pino from "pino";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { runWorker } from "../../src/orchestrator/worker.ts";
import type { SpawnOptions, SpawnResult } from "../../src/spawner/index.ts";

const silentLogger = pino({ level: "silent" });

function mkTracker() {
  const db = new Database(":memory:");
  runMigrations(db);
  return createTracker(db);
}

describe("worker heartbeat", () => {
  test("forwards spawner heartbeats to tracker.updateHeartbeat", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({ uuid: "hb-1", title: "t", state: "todo" });
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-hb-"));

    let heartbeatTs = 0;
    const mockSpawn = async (opts: SpawnOptions): Promise<SpawnResult> => {
      opts.onHeartbeat?.(123456789);
      return {
        exitCode: 0,
        killedByTimeout: false,
        duration_ms: 10,
        agentResult: { status: "success" },
        artifacts: {},
      };
    };

    await runWorker("hb-1", 0, {
      tracker,
      workflow: { workflow: { agent: { kind: "nano", timeout_ms: 5000 }, workspace: { root: wsRoot, git_baseline: false } } as any, template: "x" },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
      spawn: mockSpawn as typeof import("../../src/spawner/index.ts").spawnAgent,
    });

    const run = tracker.getRun("hb-1")!;
    expect(run.heartbeat_at).toBe(123456789);
  });

  test("sets heartbeat_timeout from orchestrator/worker config", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({ uuid: "hb-2", title: "t", state: "todo" });
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-hb-"));

    const mockSpawn = async (_opts: SpawnOptions): Promise<SpawnResult> => ({
      exitCode: 0,
      killedByTimeout: false,
      duration_ms: 10,
      agentResult: { status: "success" },
      artifacts: {},
    });

    await runWorker("hb-2", 0, {
      tracker,
      workflow: { workflow: { agent: { kind: "nano", timeout_ms: 5000 }, workspace: { root: wsRoot, git_baseline: false } } as any, template: "x" },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
      spawn: mockSpawn as typeof import("../../src/spawner/index.ts").spawnAgent,
    });

    const run = tracker.getRun("hb-2")!;
    expect(run.heartbeat_timeout_ms).toBeGreaterThan(0);
  });
});
