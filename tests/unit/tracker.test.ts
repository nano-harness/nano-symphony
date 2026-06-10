import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
function makeDb() { const db = new Database(":memory:"); runMigrations(db); return db; }
describe("tracker", () => {
  let db: Database; let tracker: ReturnType<typeof createTracker>;
  beforeEach(() => { db = makeDb(); tracker = createTracker(db); });
  test("insertIssue and getIssue", () => {
    tracker.insertIssue({ uuid: "issue-1", title: "Test Issue", description: "A test issue", priority: "high", state: "todo", labels: ["feature"] });
    const issue = tracker.getIssue("issue-1");
    expect(issue).not.toBeNull(); expect(issue!.title).toBe("Test Issue"); expect(issue!.labels).toEqual(["feature"]); expect(issue!.blockers).toEqual([]);
  });
  test("getIssue returns null for missing issue", () => { expect(tracker.getIssue("nonexistent")).toBeNull(); });
  test("listIssues returns all issues", () => {
    tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    tracker.insertIssue({ uuid: "uuid-2", title: "Issue B", state: "in_progress" });
    expect(tracker.listIssues().length).toBe(2);
  });
  test("listIssues filters by state", () => {
    tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    tracker.insertIssue({ uuid: "uuid-2", title: "Issue B", state: "in_progress" });
    const todos = tracker.listIssues({ state: "todo" }); expect(todos.length).toBe(1); expect(todos[0].state).toBe("todo");
  });
  test("claimIssue succeeds for unclaimed issue", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    expect(tracker.claimIssue(issue.uuid, 0)).toBe(true);
  });
  test("claimIssue fails for already claimed issue", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    tracker.claimIssue(issue.uuid, 0); expect(tracker.claimIssue(issue.uuid, 0)).toBe(false);
  });
  test("releaseIssue updates state", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    tracker.claimIssue(issue.uuid, 0); tracker.releaseIssue(issue.uuid, "released"); expect(tracker.getActiveRuns().length).toBe(0);
  });
  test("recordEvent stores events", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    tracker.recordEvent(issue.uuid, "started", "Agent started", { attempt: 0 });
    const events = tracker.getEvents(); expect(events.length).toBe(1); expect(events[0].kind).toBe("started");
  });
  test("getLatestEventByKind returns the newest matching event", () => {
    const issue1 = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    const issue2 = tracker.insertIssue({ uuid: "uuid-2", title: "Issue B", state: "todo" });
    tracker.recordEvent(issue1.uuid, "session_completed", "First", { semantics: "needs_retry" });
    tracker.recordEvent(issue2.uuid, "session_completed", "Other", { semantics: "success" });
    tracker.recordEvent(issue1.uuid, "started", "Started");
    tracker.recordEvent(issue1.uuid, "session_completed", "Latest", { semantics: "handoff" });
    const event = tracker.getLatestEventByKind(issue1.uuid, "session_completed");
    expect(event).not.toBeNull();
    expect(event!.message).toBe("Latest");
    expect(JSON.parse(event!.payload_json!)).toEqual({ semantics: "handoff" });
    expect(tracker.getLatestEventByKind("missing", "session_completed")).toBeNull();
  });
  test("getEvents with since filter", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    const before = Date.now() - 1; tracker.recordEvent(issue.uuid, "started", "Agent started");
    expect(tracker.getEvents(before).length).toBe(1); expect(tracker.getEvents(Date.now() + 1000).length).toBe(0);
  });
  test("insertIssue auto-assigns sequential numeric id", () => {
    const a = tracker.insertIssue({ uuid: "uuid-a", title: "Issue A", state: "todo" });
    const b = tracker.insertIssue({ uuid: "uuid-b", title: "Issue B", state: "todo" });
    expect(typeof a.id).toBe("number");
    expect(b.id).toBe(a.id + 1);
    expect(a.identifier).toBe(`TASK-${a.id}`);
    expect(b.identifier).toBe(`TASK-${b.id}`);
  });
  test("insertBlocker adds blockers to getIssue", () => {
    const issue1 = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    const issue2 = tracker.insertIssue({ uuid: "uuid-2", title: "Issue B", state: "backlog" });
    tracker.insertBlocker(issue2.uuid, issue1.uuid, "todo");
    expect(tracker.getIssue(issue2.uuid)!.blockers).toEqual([{ blocker_uuid: issue1.uuid, blocker_state: "todo" }]);
  });
  test("getCandidates returns eligible issues", () => {
    const issue1 = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo", priority: "high" });
    tracker.insertIssue({ uuid: "uuid-2", title: "Issue B", state: "todo", priority: "low" });
    tracker.insertIssue({ uuid: "uuid-3", title: "Issue C", state: "done" });
    const candidates = tracker.getCandidates(10); expect(candidates.length).toBe(2); expect(candidates[0].uuid).toBe(issue1.uuid);
  });
  test("scheduleRetry and fetchDueRetries", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    tracker.claimIssue(issue.uuid, 0); tracker.scheduleRetry(issue.uuid, Date.now() - 1000, 1);
    const retries = tracker.fetchDueRetries(Date.now()); expect(retries.length).toBe(1); expect(retries[0].issue_uuid).toBe(issue.uuid);
  });
  test("updateTokenStats", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    tracker.claimIssue(issue.uuid, 0); tracker.updateTokenStats(issue.uuid, 100, 200, 300);
    const runs = tracker.getActiveRuns(); expect(runs[0].token_input).toBe(100);
  });

  test("updateLastBlockerFingerprint persists across handles", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    tracker.updateLastBlockerFingerprint(issue.uuid, "sandbox_denied:/etc/passwd");
    expect(tracker.getLastBlockerFingerprint(issue.uuid)).toBe("sandbox_denied:/etc/passwd");

    // Simulate reopening database
    const newTracker = createTracker(db);
    expect(newTracker.getLastBlockerFingerprint(issue.uuid)).toBe("sandbox_denied:/etc/passwd");
  });

  test("updateLastBlockerFingerprint can clear fingerprint with null", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    tracker.updateLastBlockerFingerprint(issue.uuid, "some_blocker");
    expect(tracker.getLastBlockerFingerprint(issue.uuid)).toBe("some_blocker");

    tracker.updateLastBlockerFingerprint(issue.uuid, null);
    expect(tracker.getLastBlockerFingerprint(issue.uuid)).toBeNull();
  });

  test("getLastBlockerFingerprint returns null for missing issue", () => {
    expect(tracker.getLastBlockerFingerprint("nonexistent")).toBeNull();
  });

  test("migration upgrades schema with last_blocker_fingerprint", () => {
    // Schema migration is already tested by beforeEach calling runMigrations
    // This test verifies the column exists and works
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue A", state: "todo" });
    tracker.updateLastBlockerFingerprint(issue.uuid, "test_fingerprint");

    const raw = db.query("SELECT last_blocker_fingerprint FROM issues WHERE uuid = ?").get(issue.uuid) as { last_blocker_fingerprint: string };
    expect(raw.last_blocker_fingerprint).toBe("test_fingerprint");
  });

  test("getCandidates excludes plan_review issues", () => {
    const issue1 = tracker.insertIssue({ uuid: "uuid-1", title: "Todo issue", state: "todo" });
    const issue2 = tracker.insertIssue({ uuid: "uuid-2", title: "Planning issue", state: "planning" });
    const issue3 = tracker.insertIssue({ uuid: "uuid-3", title: "Plan review issue", state: "plan_review" });
    const candidates = tracker.getCandidates(10);
    const uuids = candidates.map((c) => c.uuid);
    expect(uuids).toContain(issue1.uuid);
    expect(uuids).toContain(issue2.uuid); // planning IS a candidate
    expect(uuids).not.toContain(issue3.uuid); // plan_review is NOT a candidate
  });

  test("getEventsByKind returns events of matching kind for issue", () => {
    const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Issue", state: "planning" });
    tracker.recordEvent(issue.uuid, "plan_submitted", "Plan v1", { markdown: "# Plan 1", revision: 0 });
    tracker.recordEvent(issue.uuid, "progress", "Working", {});
    tracker.recordEvent(issue.uuid, "plan_submitted", "Plan v2", { markdown: "# Plan 2", revision: 1 });
    const planEvents = tracker.getEventsByKind(issue.uuid, "plan_submitted");
    expect(planEvents.length).toBe(2);
    expect(planEvents.every((e) => e.kind === "plan_submitted")).toBe(true);
  });

  test("rejectPlanRun transitions awaiting approval runs to cancelled", () => {
    tracker.insertPlanRun({
      id: "plan-run-1",
      script: "return 'ok';",
      meta: { name: "Plan", max_issues: 1 },
    });
    tracker.updatePlanRunState("plan-run-1", "awaiting_approval");

    tracker.rejectPlanRun("plan-run-1", "Not approved");

    const run = tracker.getPlanRun("plan-run-1");
    expect(run?.state).toBe("cancelled");
    expect(run?.approval_status).toBe("rejected");
    expect(run?.approval_reason).toBe("Not approved");
    expect(run?.finished_at).not.toBeNull();
  });

  test("setPlanRunDryRunSummary stores JSON once", () => {
    tracker.insertPlanRun({
      id: "plan-run-2",
      script: "return 'ok';",
      meta: { name: "Plan", max_issues: 1 },
    });

    tracker.setPlanRunDryRunSummary("plan-run-2", {
      ok: true,
      phases: ["default"],
      estimated_issues: 1,
      issue_prompts: [],
      max_issues: 1,
    });

    const run = tracker.getPlanRun("plan-run-2");
    expect(run?.dry_run_summary).not.toBeNull();
    expect(JSON.parse(run!.dry_run_summary!)).toEqual({
      ok: true,
      phases: ["default"],
      estimated_issues: 1,
      issue_prompts: [],
      max_issues: 1,
    });
  });
});
