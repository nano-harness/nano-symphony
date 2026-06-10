import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
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
