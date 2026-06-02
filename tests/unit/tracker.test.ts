import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
function makeDb() { const db = new Database(":memory:"); runMigrations(db); return db; }
describe("tracker", () => {
  let db: Database; let tracker: ReturnType<typeof createTracker>;
  beforeEach(() => { db = makeDb(); tracker = createTracker(db); });
  test("insertIssue and getIssue", () => {
    tracker.insertIssue({ id: "issue-1", identifier: "TASK-1", title: "Test Issue", description: "A test issue", priority: "high", state: "todo", labels: ["feature"] });
    const issue = tracker.getIssue("issue-1");
    expect(issue).not.toBeNull(); expect(issue!.title).toBe("Test Issue"); expect(issue!.labels).toEqual(["feature"]); expect(issue!.blockers).toEqual([]);
  });
  test("getIssue returns null for missing issue", () => { expect(tracker.getIssue("nonexistent")).toBeNull(); });
  test("listIssues returns all issues", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.insertIssue({ id: "2", identifier: "A-2", title: "Issue B", state: "in_progress" });
    expect(tracker.listIssues().length).toBe(2);
  });
  test("listIssues filters by state", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.insertIssue({ id: "2", identifier: "A-2", title: "Issue B", state: "in_progress" });
    const todos = tracker.listIssues({ state: "todo" }); expect(todos.length).toBe(1); expect(todos[0].state).toBe("todo");
  });
  test("claimIssue succeeds for unclaimed issue", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    expect(tracker.claimIssue("1", 0)).toBe(true);
  });
  test("claimIssue fails for already claimed issue", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.claimIssue("1", 0); expect(tracker.claimIssue("1", 0)).toBe(false);
  });
  test("releaseIssue updates state", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.claimIssue("1", 0); tracker.releaseIssue("1", "released"); expect(tracker.getActiveRuns().length).toBe(0);
  });
  test("recordEvent stores events", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.recordEvent("1", "started", "Agent started", { attempt: 0 });
    const events = tracker.getEvents(); expect(events.length).toBe(1); expect(events[0].kind).toBe("started");
  });
  test("getLatestEventByKind returns the newest matching event", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.insertIssue({ id: "2", identifier: "A-2", title: "Issue B", state: "todo" });
    tracker.recordEvent("1", "session_completed", "First", { semantics: "needs_retry" });
    tracker.recordEvent("2", "session_completed", "Other", { semantics: "success" });
    tracker.recordEvent("1", "started", "Started");
    tracker.recordEvent("1", "session_completed", "Latest", { semantics: "handoff" });
    const event = tracker.getLatestEventByKind("1", "session_completed");
    expect(event).not.toBeNull();
    expect(event!.message).toBe("Latest");
    expect(JSON.parse(event!.payload_json!)).toEqual({ semantics: "handoff" });
    expect(tracker.getLatestEventByKind("missing", "session_completed")).toBeNull();
  });
  test("getEvents with since filter", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    const before = Date.now() - 1; tracker.recordEvent("1", "started", "Agent started");
    expect(tracker.getEvents(before).length).toBe(1); expect(tracker.getEvents(Date.now() + 1000).length).toBe(0);
  });
  test("getNextTaskNumber returns 1 for empty DB", () => {
    expect(tracker.getNextTaskNumber()).toBe(1);
  });
  test("getNextTaskNumber skips non-TASK identifiers", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.insertIssue({ id: "2", identifier: "TASK-5", title: "Issue B", state: "todo" });
    expect(tracker.getNextTaskNumber()).toBe(6);
  });
  test("getNextTaskNumber handles TASK-2 vs TASK-10 numeric order", () => {
    tracker.insertIssue({ id: "1", identifier: "TASK-2", title: "Issue A", state: "todo" });
    tracker.insertIssue({ id: "2", identifier: "TASK-10", title: "Issue B", state: "todo" });
    expect(tracker.getNextTaskNumber()).toBe(11);
  });
  test("insertBlocker adds blockers to getIssue", () => {
    tracker.insertIssue({ id: "1", identifier: "TASK-1", title: "Issue A", state: "todo" });
    tracker.insertIssue({ id: "2", identifier: "TASK-2", title: "Issue B", state: "backlog" });
    tracker.insertBlocker("2", "1", "todo");
    expect(tracker.getIssue("2")!.blockers).toEqual([{ blocker_id: "1", blocker_state: "todo" }]);
  });
  test("getCandidates returns eligible issues", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo", priority: "high" });
    tracker.insertIssue({ id: "2", identifier: "A-2", title: "Issue B", state: "todo", priority: "low" });
    tracker.insertIssue({ id: "3", identifier: "A-3", title: "Issue C", state: "done" });
    const candidates = tracker.getCandidates(10); expect(candidates.length).toBe(2); expect(candidates[0].id).toBe("1");
  });
  test("scheduleRetry and fetchDueRetries", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.claimIssue("1", 0); tracker.scheduleRetry("1", Date.now() - 1000, 1);
    const retries = tracker.fetchDueRetries(Date.now()); expect(retries.length).toBe(1); expect(retries[0].issue_id).toBe("1");
  });
  test("updateTokenStats", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.claimIssue("1", 0); tracker.updateTokenStats("1", 100, 200, 300);
    const runs = tracker.getActiveRuns(); expect(runs[0].token_input).toBe(100);
  });

  test("updateLastBlockerFingerprint persists across handles", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.updateLastBlockerFingerprint("1", "sandbox_denied:/etc/passwd");
    expect(tracker.getLastBlockerFingerprint("1")).toBe("sandbox_denied:/etc/passwd");

    // Simulate reopening database
    const newTracker = createTracker(db);
    expect(newTracker.getLastBlockerFingerprint("1")).toBe("sandbox_denied:/etc/passwd");
  });

  test("updateLastBlockerFingerprint can clear fingerprint with null", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.updateLastBlockerFingerprint("1", "some_blocker");
    expect(tracker.getLastBlockerFingerprint("1")).toBe("some_blocker");

    tracker.updateLastBlockerFingerprint("1", null);
    expect(tracker.getLastBlockerFingerprint("1")).toBeNull();
  });

  test("getLastBlockerFingerprint returns null for missing issue", () => {
    expect(tracker.getLastBlockerFingerprint("nonexistent")).toBeNull();
  });

  test("migration upgrades schema with last_blocker_fingerprint", () => {
    // Schema migration is already tested by beforeEach calling runMigrations
    // This test verifies the column exists and works
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" });
    tracker.updateLastBlockerFingerprint("1", "test_fingerprint");

    const raw = db.query("SELECT last_blocker_fingerprint FROM issues WHERE id = ?").get("1") as { last_blocker_fingerprint: string };
    expect(raw.last_blocker_fingerprint).toBe("test_fingerprint");
  });

  test("getCandidates excludes plan_review issues", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Todo issue", state: "todo" });
    tracker.insertIssue({ id: "2", identifier: "A-2", title: "Planning issue", state: "planning" });
    tracker.insertIssue({ id: "3", identifier: "A-3", title: "Plan review issue", state: "plan_review" });
    const candidates = tracker.getCandidates(10);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain("1");
    expect(ids).toContain("2"); // planning IS a candidate
    expect(ids).not.toContain("3"); // plan_review is NOT a candidate
  });

  test("getEventsByKind returns events of matching kind for issue", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue", state: "planning" });
    tracker.recordEvent("1", "plan_submitted", "Plan v1", { markdown: "# Plan 1", revision: 0 });
    tracker.recordEvent("1", "progress", "Working", {});
    tracker.recordEvent("1", "plan_submitted", "Plan v2", { markdown: "# Plan 2", revision: 1 });
    const planEvents = tracker.getEventsByKind("1", "plan_submitted");
    expect(planEvents.length).toBe(2);
    expect(planEvents.every((e) => e.kind === "plan_submitted")).toBe(true);
  });
});
