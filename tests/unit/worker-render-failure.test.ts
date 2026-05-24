import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Logger } from "pino";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { runWorker } from "../../src/orchestrator/worker.ts";

const silentLogger: Logger = {
  level: "silent",
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger,
} as any;

function mkTracker() {
  const db = new Database(":memory:");
  runMigrations(db);
  return createTracker(db);
}

describe("runWorker render failure handling", () => {
  test("records error event and syncs last_issue_state on render failure", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({
      id: "i1", identifier: "TEST-1", title: "t", state: "todo",
    });

    const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-workspaces-"));

    // Template references an undefined variable → liquid renderPrompt will throw
    const workflow = {
      workflow: { agent: { binary: "/nonexistent-binary" }, workspace: { root: wsRoot, git_baseline: false } } as any,
      template: "Hello {{ does_not_exist.field }}",
    };

    await runWorker("i1", 0, {
      tracker,
      workflow,
      logger: silentLogger,
      mcpUrl: "http://localhost:0/mcp",
    });

    const events = tracker.getEvents().filter((e) => e.issue_id === "i1");
    expect(events.some((e) => e.kind === "error")).toBe(true);
    const errorEvent = events.find((e) => e.kind === "error")!;
    expect(errorEvent.message).toContain("Failed to render prompt");

    const run = tracker.getRun("i1")!;
    expect(run.last_state).toBe("released");
    // Critical: last_issue_state synced so candidate SQL doesn't re-pick
    expect(run.last_issue_state).toBe("todo");

    // Second tick: candidate query must NOT return this issue
    const candidates = tracker.getCandidates(10);
    expect(candidates.find((c) => c.id === "i1")).toBeUndefined();
  });
});
