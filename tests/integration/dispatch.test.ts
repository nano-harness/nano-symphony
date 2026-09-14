import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { findWorkspaceConflict } from "../../src/orchestrator/index.ts";
function makeTracker() { const db = new Database(":memory:"); runMigrations(db); return createTracker(db); }
describe("dispatch integration", () => {
  let tracker: ReturnType<typeof createTracker>;
  beforeEach(() => { tracker = makeTracker(); });
  test("getCandidates only returns unblocked issues", () => {
    const db = new Database(":memory:"); runMigrations(db); const t2 = createTracker(db);
    const blocker = t2.insertIssue({ uuid: "uuid-1", title: "Blocker", state: "todo" });
    const blocked = t2.insertIssue({ uuid: "uuid-2", title: "Blocked", state: "todo" });
    t2.insertBlocker(blocked.uuid, blocker.uuid, "todo");
    const candidates = t2.getCandidates(10); expect(candidates.length).toBe(1); expect(candidates[0].uuid).toBe(blocker.uuid);
  });
  test("claimed issue not returned as candidate", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" }); tracker.claimIssue(issue.uuid, 0);
    expect(tracker.getCandidates(10).length).toBe(0);
  });
  test("released issue returned as candidate again", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" }); tracker.claimIssue(issue.uuid, 0); tracker.releaseIssue(issue.uuid, "released");
    expect(tracker.getCandidates(10).length).toBe(1);
  });
  test("done issue not returned as candidate", () => {
    tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "done" });
    expect(tracker.getCandidates(10).length).toBe(0);
  });
  test("priority ordering: urgent > high > medium > low", () => {
    tracker.insertIssue({ uuid: "uuid-4", title: "Low", state: "todo", priority: "low" });
    tracker.insertIssue({ uuid: "uuid-2", title: "High", state: "todo", priority: "high" });
    tracker.insertIssue({ uuid: "uuid-1", title: "Urgent", state: "todo", priority: "urgent" });
    tracker.insertIssue({ uuid: "uuid-3", title: "Medium", state: "todo", priority: "medium" });
    const c = tracker.getCandidates(10); expect(c[0].priority).toBe("urgent"); expect(c[1].priority).toBe("high"); expect(c[2].priority).toBe("medium"); expect(c[3].priority).toBe("low");
  });
});

describe("dispatch integration: shared external workspace", () => {
  let tracker: ReturnType<typeof createTracker>;
  beforeEach(() => { tracker = makeTracker(); });

  // Mirrors the orchestrator tick: candidates are filtered through
  // findWorkspaceConflict before claimIssue, inside the same transaction.
  function tryDispatch(uuid: string, attempt: number): "claimed" | "conflict" | "skipped" {
    return tracker.withTransaction(() => {
      const wsOverride = tracker.getIssue(uuid)?.workspace_path?.trim();
      if (wsOverride && findWorkspaceConflict(tracker, uuid, wsOverride)) return "conflict";
      return tracker.claimIssue(uuid, attempt) ? "claimed" : "skipped";
    });
  }

  test("two issues sharing one workspace_path are not dispatched concurrently", () => {
    tracker.insertIssue({ uuid: "uuid-a", title: "A", state: "todo", workspace_path: "/tmp/shared-ws" });
    tracker.insertIssue({ uuid: "uuid-b", title: "B", state: "todo", workspace_path: "/tmp/shared-ws" });
    expect(tracker.getCandidates(10).length).toBe(2);

    expect(tryDispatch("uuid-a", 0)).toBe("claimed");
    expect(tryDispatch("uuid-b", 0)).toBe("conflict");
    // B stays unclaimed and remains a candidate for a later tick.
    expect(tracker.getRun("uuid-b")).toBeNull();
    expect(tracker.getCandidates(10).map((c) => c.uuid)).toEqual(["uuid-b"]);
  });

  test("issues without workspace_path dispatch normally alongside an active external run", () => {
    tracker.insertIssue({ uuid: "uuid-a", title: "A", state: "todo", workspace_path: "/tmp/shared-ws" });
    tracker.insertIssue({ uuid: "uuid-c", title: "C", state: "todo" });

    expect(tryDispatch("uuid-a", 0)).toBe("claimed");
    expect(tryDispatch("uuid-c", 0)).toBe("claimed");
  });

  test("stale release frees the workspace so the waiting issue can be claimed", () => {
    tracker.insertIssue({ uuid: "uuid-a", title: "A", state: "todo", workspace_path: "/tmp/shared-ws" });
    tracker.insertIssue({ uuid: "uuid-b", title: "B", state: "todo", workspace_path: "/tmp/shared-ws" });
    expect(tryDispatch("uuid-a", 0)).toBe("claimed");
    expect(tryDispatch("uuid-b", 0)).toBe("conflict");

    // A stops heartbeating; the tick detects it as stale and releases it.
    tracker.updateHeartbeat("uuid-a", Date.now() - 600_000);
    const stale = tracker.fetchStaleRuns(Date.now() - 120_000);
    expect(stale.map((r) => r.issue_uuid)).toEqual(["uuid-a"]);
    tracker.releaseIssue("uuid-a", "released");

    expect(tryDispatch("uuid-b", 0)).toBe("claimed");
  });

  test("normal completion frees the workspace for the next issue", () => {
    tracker.insertIssue({ uuid: "uuid-a", title: "A", state: "todo", workspace_path: "/tmp/shared-ws" });
    tracker.insertIssue({ uuid: "uuid-b", title: "B", state: "todo", workspace_path: "/tmp/shared-ws" });
    expect(tryDispatch("uuid-a", 0)).toBe("claimed");
    tracker.releaseIssue("uuid-a", "released");

    expect(tryDispatch("uuid-b", 0)).toBe("claimed");
  });
});
