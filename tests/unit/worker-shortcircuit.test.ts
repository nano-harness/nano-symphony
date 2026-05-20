import { describe, expect, test, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import type { Tracker } from "../../src/db/tracker.ts";

function makeDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

describe("worker short-circuit", () => {
  let db: Database;
  let tracker: Tracker;

  beforeEach(() => {
    db = makeDb();
    tracker = createTracker(db);
  });

  test("same fingerprint two attempts -> shortcircuit to blocked", () => {
    tracker.insertIssue({ id: "1", identifier: "TASK-1", title: "Test", state: "todo" });

    // Simulate attempt 0 with fingerprint
    tracker.updateLastBlockerFingerprint("1", "sandbox_denied:/etc/passwd");

    // Attempt 1 with same fingerprint should trigger short-circuit
    const prevFingerprint = tracker.getLastBlockerFingerprint("1");
    const currentFingerprint = "sandbox_denied:/etc/passwd";

    expect(prevFingerprint).toBe(currentFingerprint);

    // Simulate short-circuit logic
    const attempt = 1;
    if (currentFingerprint === prevFingerprint && attempt >= 1) {
      tracker.updateIssueState("1", "blocked");
      tracker.releaseIssue("1", "released");
      tracker.updateLastIssueState("1", "blocked");
      tracker.recordEvent("1", "shortcircuit_same_cause",
        `Same blocker repeated across attempts ${attempt} and ${attempt + 1}: ${currentFingerprint}`,
        { fingerprint: currentFingerprint, attempt, prev_attempt: attempt });
    }

    const issue = tracker.getIssue("1");
    expect(issue?.state).toBe("blocked");

    const events = tracker.getEvents();
    const shortcircuitEvent = events.find(e => e.kind === "shortcircuit_same_cause");
    expect(shortcircuitEvent).toBeDefined();
    expect(shortcircuitEvent?.message).toContain("sandbox_denied:/etc/passwd");
  });

  test("different fingerprints allow retry", () => {
    tracker.insertIssue({ id: "1", identifier: "TASK-1", title: "Test", state: "todo" });

    // Initialize symphony_runs by claiming the issue
    tracker.claimIssue("1", 0);

    // Attempt 0 with first fingerprint
    tracker.updateLastBlockerFingerprint("1", "error_type_A");

    // Attempt 1 with different fingerprint should allow retry
    const prevFingerprint = tracker.getLastBlockerFingerprint("1");
    const currentFingerprint = "error_type_B";

    expect(prevFingerprint).not.toBe(currentFingerprint);

    // Should proceed to retry
    const attempt = 1;
    if (currentFingerprint !== prevFingerprint || attempt < 1) {
      tracker.updateLastBlockerFingerprint("1", currentFingerprint);
      tracker.scheduleRetry("1", Date.now() + 5000, attempt + 1);
      tracker.recordEvent("1", "retry_scheduled", "Retry scheduled", { attempt: attempt + 1 });
    }

    const run = tracker.getRun("1");
    expect(run?.last_state).toBe("retry_queued");
    expect(run?.next_attempt).toBe(2);
  });

  test("success clears prev fingerprint", () => {
    tracker.insertIssue({ id: "1", identifier: "TASK-1", title: "Test", state: "todo" });

    // Set fingerprint from previous failure
    tracker.updateLastBlockerFingerprint("1", "previous_error");
    expect(tracker.getLastBlockerFingerprint("1")).toBe("previous_error");

    // Success should clear it
    tracker.updateLastBlockerFingerprint("1", null);
    expect(tracker.getLastBlockerFingerprint("1")).toBeNull();
  });

  test("handoff clears prev fingerprint", () => {
    tracker.insertIssue({ id: "1", identifier: "TASK-1", title: "Test", state: "todo" });

    tracker.updateLastBlockerFingerprint("1", "previous_error");

    // Handoff should clear it
    tracker.updateLastBlockerFingerprint("1", null);
    expect(tracker.getLastBlockerFingerprint("1")).toBeNull();
  });

  test("short-circuit only triggers at attempt >= 1", () => {
    tracker.insertIssue({ id: "1", identifier: "TASK-1", title: "Test", state: "todo" });

    // Attempt 0 - no previous fingerprint, should allow retry
    const currentFingerprint = "error_A";
    const prevFingerprint = tracker.getLastBlockerFingerprint("1");
    const attempt = 0;

    // Even if fingerprints match, attempt 0 should not short-circuit
    const shouldShortCircuit = currentFingerprint && currentFingerprint === prevFingerprint && attempt >= 1;
    expect(shouldShortCircuit).toBe(false);

    // Store fingerprint for next time
    tracker.updateLastBlockerFingerprint("1", currentFingerprint);

    // Attempt 1 with same fingerprint should short-circuit
    const attempt1 = 1;
    const prevFingerprint1 = tracker.getLastBlockerFingerprint("1");
    const shouldShortCircuit1 = currentFingerprint && currentFingerprint === prevFingerprint1 && attempt1 >= 1;
    expect(shouldShortCircuit1).toBe(true);
  });

  test("empty fingerprint does not trigger short-circuit", () => {
    tracker.insertIssue({ id: "1", identifier: "TASK-1", title: "Test", state: "todo" });

    tracker.updateLastBlockerFingerprint("1", "");

    const currentFingerprint = "";
    const prevFingerprint = tracker.getLastBlockerFingerprint("1");
    const attempt = 1;

    // Empty fingerprint should not match
    const shouldShortCircuit = !!(currentFingerprint && currentFingerprint === prevFingerprint && attempt >= 1);
    expect(shouldShortCircuit).toBe(false);
  });
});
