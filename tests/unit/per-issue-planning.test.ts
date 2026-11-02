import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";

function makeTracker() {
  const db = new Database(":memory:");
  runMigrations(db);
  return createTracker(db);
}

describe("per-issue planning override", () => {
  describe("DB round-trip for require_plan", () => {
    let tracker: ReturnType<typeof makeTracker>;

    beforeEach(() => {
      tracker = makeTracker();
    });

    test("require_plan: true persists and reads back as true", () => {
      const issue = tracker.insertIssue({ uuid: "uuid-1", title: "Plan required", state: "todo", require_plan: true });
      const fetched = tracker.getIssue(issue.uuid);
      expect(fetched).not.toBeNull();
      expect(fetched!.require_plan).toBe(true);
    });

    test("require_plan: false persists and reads back as false", () => {
      const issue = tracker.insertIssue({ uuid: "uuid-2", title: "Skip planning", state: "todo", require_plan: false });
      const fetched = tracker.getIssue(issue.uuid);
      expect(fetched).not.toBeNull();
      expect(fetched!.require_plan).toBe(false);
    });

    test("require_plan: null (omitted) defaults to null", () => {
      const issue = tracker.insertIssue({ uuid: "uuid-3", title: "Follow workflow", state: "todo" });
      const fetched = tracker.getIssue(issue.uuid);
      expect(fetched).not.toBeNull();
      expect(fetched!.require_plan).toBeNull();
    });

    test("require_plan: null explicit persists and reads back as null", () => {
      const issue = tracker.insertIssue({ uuid: "uuid-4", title: "Explicit null", state: "todo", require_plan: null });
      const fetched = tracker.getIssue(issue.uuid);
      expect(fetched).not.toBeNull();
      expect(fetched!.require_plan).toBeNull();
    });

    test("require_plan can be updated via updateIssue", () => {
      const issue = tracker.insertIssue({ uuid: "uuid-5", title: "Changeable", state: "todo", require_plan: null });
      tracker.updateIssue(issue.uuid, { title: "Changeable", state: "todo", require_plan: true });
      expect(tracker.getIssue(issue.uuid)!.require_plan).toBe(true);
    });

    test("listIssues includes require_plan field", () => {
      const a = tracker.insertIssue({ uuid: "uuid-1", title: "A", state: "todo", require_plan: true });
      const b = tracker.insertIssue({ uuid: "uuid-2", title: "B", state: "todo", require_plan: false });
      const c = tracker.insertIssue({ uuid: "uuid-3", title: "C", state: "todo" });
      const issues = tracker.listIssues();
      expect(issues.find(i => i.uuid === a.uuid)!.require_plan).toBe(true);
      expect(issues.find(i => i.uuid === b.uuid)!.require_plan).toBe(false);
      expect(issues.find(i => i.uuid === c.uuid)!.require_plan).toBeNull();
    });
  });
});
