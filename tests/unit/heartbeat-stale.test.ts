import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { createTracker } from "../../src/db/tracker.ts";
import { runMigrations } from "../../src/db/migrations.ts";

describe("heartbeat stale detection", () => {
  let db: Database;
  let tracker: ReturnType<typeof createTracker>;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    tracker = createTracker(db);
  });

  it("does not mark a freshly-claimed run as stale when heartbeat_at is seeded", () => {
    const issue = tracker.insertIssue({ uuid: nanoid(), title: "hb", state: "todo" });
    tracker.claimIssue(issue.uuid, 0);
    tracker.setHeartbeatTimeout(issue.uuid, 120_000);
    tracker.updateHeartbeat(issue.uuid, Date.now());

    const stale = tracker.fetchStaleRuns(Date.now() - 120_000);
    expect(stale.some((r) => r.issue_uuid === issue.uuid)).toBe(false);
  });

  it("marks a run stale once heartbeat_at ages past the timeout", () => {
    const issue = tracker.insertIssue({ uuid: nanoid(), title: "hb", state: "todo" });
    tracker.claimIssue(issue.uuid, 0);
    tracker.setHeartbeatTimeout(issue.uuid, 120_000);
    tracker.updateHeartbeat(issue.uuid, Date.now() - 200_000);

    const stale = tracker.fetchStaleRuns(Date.now() - 120_000);
    expect(stale.some((r) => r.issue_uuid === issue.uuid)).toBe(true);
  });
});
