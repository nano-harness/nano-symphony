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
    t2.insertIssue({ id: "1", identifier: "A-1", title: "Blocker", state: "todo" });
    t2.insertIssue({ id: "2", identifier: "A-2", title: "Blocked", state: "todo" });
    db.exec(`INSERT INTO issue_blockers (issue_id, blocker_id, blocker_state) VALUES ('2', '1', 'todo')`);
    const candidates = t2.getCandidates(10); expect(candidates.length).toBe(1); expect(candidates[0].id).toBe("1");
  });
  test("claimed issue not returned as candidate", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" }); tracker.claimIssue("1", 0);
    expect(tracker.getCandidates(10).length).toBe(0);
  });
  test("released issue returned as candidate again", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "todo" }); tracker.claimIssue("1", 0); tracker.releaseIssue("1", "released");
    expect(tracker.getCandidates(10).length).toBe(1);
  });
  test("done issue not returned as candidate", () => {
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Issue A", state: "done" });
    expect(tracker.getCandidates(10).length).toBe(0);
  });
  test("priority ordering: urgent > high > medium > low", () => {
    tracker.insertIssue({ id: "4", identifier: "A-4", title: "Low", state: "todo", priority: "low" });
    tracker.insertIssue({ id: "2", identifier: "A-2", title: "High", state: "todo", priority: "high" });
    tracker.insertIssue({ id: "1", identifier: "A-1", title: "Urgent", state: "todo", priority: "urgent" });
    tracker.insertIssue({ id: "3", identifier: "A-3", title: "Medium", state: "todo", priority: "medium" });
    const c = tracker.getCandidates(10); expect(c[0].priority).toBe("urgent"); expect(c[1].priority).toBe("high"); expect(c[2].priority).toBe("medium"); expect(c[3].priority).toBe("low");
  });
});
