import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";

describe("circuit breaker", () => {
  let tracker: ReturnType<typeof createTracker>;

  beforeEach(() => {
    const db = new Database(":memory:");
    runMigrations(db);
    tracker = createTracker(db);
  });

  function countConsecutiveFailures(issueUuid: string): number {
    const events = tracker.getEventsByKind(issueUuid, "session_completed");
    let count = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const payload = JSON.parse(events[i].payload_json ?? "{}") as { semantics?: string };
      if (payload.semantics === "needs_retry") count++;
      else break;
    }
    return count;
  }

  test("countConsecutiveFailures helper works", () => {
    const issue = tracker.insertIssue({ uuid: "issue-cb", title: "CB", state: "in_progress" });
    tracker.recordEvent(issue.uuid, "session_completed", "ok", { semantics: "success" });
    tracker.recordEvent(issue.uuid, "session_completed", "fail", { semantics: "needs_retry" });
    tracker.recordEvent(issue.uuid, "session_completed", "fail", { semantics: "needs_retry" });
    expect(countConsecutiveFailures(issue.uuid)).toBe(2);
  });

  test("getCandidates excludes blocked state", () => {
    const issue = tracker.insertIssue({ uuid: "issue-blocked", title: "Blocked", state: "blocked" });
    tracker.claimIssue(issue.uuid, 0);
    tracker.releaseIssue(issue.uuid, "released");
    const candidates = tracker.getCandidates(10);
    expect(candidates.some((i) => i.uuid === issue.uuid)).toBe(false);
  });
});
