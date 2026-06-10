import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs/promises";
import os from "os";
import path from "path";
import pino from "pino";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { runWorker } from "../../src/orchestrator/worker.ts";
import type { SpawnResult } from "../../src/spawner/index.ts";

const silentLogger = pino({ level: "silent" });

function mkTracker() {
  const db = new Database(":memory:");
  runMigrations(db);
  return { tracker: createTracker(db), db };
}

describe("worker persists artifacts.patch via tracker", () => {
  test("patch from spawnResult.artifacts is recorded on the run", async () => {
    const { tracker, db } = mkTracker();
    tracker.insertIssue({ uuid: "patch-1", title: "t", state: "todo" });
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-patch-"));

    const fakePatch = "diff --git a/foo b/foo\n+hello\n";

    const spawn = async (): Promise<SpawnResult> => ({
      exitCode: 0,
      killedByTimeout: false,
      duration_ms: 100,
      agentResult: { status: "success", goal_state: { last_reason: "done" } },
      artifacts: { patch: fakePatch },
    });

    await runWorker("patch-1", 0, {
      tracker,
      workflow: { workflow: { agent: { binary: "true", timeout_ms: 5000 }, workspace: { root: wsRoot, git_baseline: false } } as any, template: "x" },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
      spawn: spawn as any,
    });

    const row = db.query("SELECT last_patch FROM symphony_runs WHERE issue_uuid = ?").get("patch-1") as { last_patch: string | null };
    expect(row.last_patch).toBe(fakePatch);

    // Also verify patch_collected event was emitted
    const events = tracker.getEvents().filter((e) => e.issue_uuid === "patch-1" && e.kind === "patch_collected");
    expect(events.length).toBe(1);
  });

  test("no patch field leaves last_patch as NULL", async () => {
    const { tracker, db } = mkTracker();
    tracker.insertIssue({ uuid: "patch-2", title: "t", state: "todo" });
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-patch-"));

    const spawn = async (): Promise<SpawnResult> => ({
      exitCode: 0,
      killedByTimeout: false,
      duration_ms: 100,
      agentResult: { status: "success", goal_state: { last_reason: "done" } },
      artifacts: {},
    });

    await runWorker("patch-2", 0, {
      tracker,
      workflow: { workflow: { agent: { binary: "true", timeout_ms: 5000 }, workspace: { root: wsRoot, git_baseline: false } } as any, template: "x" },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
      spawn: spawn as any,
    });

    const row = db.query("SELECT last_patch FROM symphony_runs WHERE issue_uuid = ?").get("patch-2") as { last_patch: string | null };
    expect(row.last_patch).toBeNull();
  });
});
