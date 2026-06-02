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

describe("worker resolves agent from issue overrides first", () => {
  test("issue.agent_kind overrides workflow.agent.kind", async () => {
    const { tracker } = mkTracker();
    tracker.insertIssue({
      id: "ag-1", identifier: "AG-1", title: "t", state: "todo",
      agent_kind: "claude-code",
    });
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-ag-"));

    let observed: { agentKind?: string; binary?: string } = {};
    const spawn = async (opts: any): Promise<SpawnResult> => {
      observed = { agentKind: opts.agentKind, binary: opts.binary };
      return {
        exitCode: 0, killedByTimeout: false, duration_ms: 50,
        agentResult: { status: "success", goal_state: { last_reason: "done" } },
        artifacts: {},
      };
    };

    await runWorker("ag-1", 0, {
      tracker,
      workflow: {
        workflow: {
          agent: { kind: "nano", binary: "nano", timeout_ms: 5000 },
          workspace: { root: wsRoot, git_baseline: false },
        } as any,
        template: "x",
      },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
      spawn: spawn as any,
    });

    expect(observed.agentKind).toBe("claude-code");
    // binary = agentConfig?.binary ?? kind_default. Workflow sets binary: "nano", so it wins.
    expect(observed.binary).toBe("nano");
  });

  test("missing override falls back to workflow defaults", async () => {
    const { tracker } = mkTracker();
    tracker.insertIssue({ id: "ag-2", identifier: "AG-2", title: "t", state: "todo" });
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-ag-"));

    let observed: { agentKind?: string; binary?: string } = {};
    const spawn = async (opts: any): Promise<SpawnResult> => {
      observed = { agentKind: opts.agentKind, binary: opts.binary };
      return {
        exitCode: 0, killedByTimeout: false, duration_ms: 50,
        agentResult: { status: "success", goal_state: { last_reason: "done" } },
        artifacts: {},
      };
    };

    await runWorker("ag-2", 0, {
      tracker,
      workflow: {
        workflow: {
          agent: { kind: "claude-code", timeout_ms: 5000 },
          workspace: { root: wsRoot, git_baseline: false },
        } as any,
        template: "x",
      },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
      spawn: spawn as any,
    });

    expect(observed.agentKind).toBe("claude-code");
    expect(observed.binary).toBe("claude");
  });

  test("started event payload carries agent_kind + agent_overridden", async () => {
    const { tracker } = mkTracker();
    tracker.insertIssue({
      id: "ag-3", identifier: "AG-3", title: "t", state: "todo",
      agent_kind: "claude-code",
    });
    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-ag-"));

    const spawn = async (): Promise<SpawnResult> => ({
      exitCode: 0, killedByTimeout: false, duration_ms: 50,
      agentResult: { status: "success", goal_state: { last_reason: "done" } },
      artifacts: {},
    });

    await runWorker("ag-3", 0, {
      tracker,
      workflow: {
        workflow: {
          agent: { kind: "nano", timeout_ms: 5000 },
          workspace: { root: wsRoot, git_baseline: false },
        } as any,
        template: "x",
      },
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
      spawn: spawn as any,
    });

    const started = tracker.getEvents()
      .filter((e) => e.issue_id === "ag-3" && e.kind === "started")[0];
    expect(started).toBeDefined();
    const payload = JSON.parse(started.payload_json!);
    expect(payload.agent_kind).toBe("claude-code");
    expect(payload.agent_overridden).toBe(true);
  });
});
