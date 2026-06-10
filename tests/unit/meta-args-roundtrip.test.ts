/**
 * B1: Verify that meta and args are stored as single-encoded JSON, not double-encoded.
 * POST /plan-runs and MCP spawn_plan_run must pass raw objects to the tracker,
 * which is the only encoding point.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";

function makeDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

describe("plan-run meta/args roundtrip (B1)", () => {
  let tracker: ReturnType<typeof createTracker>;

  beforeEach(() => {
    tracker = createTracker(makeDb());
  });

  test("meta is stored once as JSON and reads back as object", () => {
    const meta = { max_issues: 5, max_budget_tokens: 100_000, name: "my-plan" };
    tracker.insertPlanRun({
      id: "run-1",
      script: "emit_result(args)",
      meta,
      args: { x: 1 },
    });

    const stored = tracker.getPlanRun("run-1");
    expect(stored).not.toBeNull();

    // meta column is JSON-encoded once — parsing it must yield the original object
    const parsedMeta = JSON.parse(stored!.meta);
    expect(parsedMeta).toEqual(meta);
    // Must NOT be double-encoded (i.e., meta must not be a string when parsed)
    expect(typeof parsedMeta).toBe("object");
    expect(typeof parsedMeta.max_issues).toBe("number");
  });

  test("args is stored once as JSON and reads back as object", () => {
    tracker.insertPlanRun({
      id: "run-2",
      script: "emit_result(args)",
      meta: { max_issues: 1 },
      args: { x: 1, label: "hello" },
    });

    const stored = tracker.getPlanRun("run-2");
    expect(stored).not.toBeNull();

    const parsedArgs = JSON.parse(stored!.args!);
    expect(parsedArgs).toEqual({ x: 1, label: "hello" });
    // args.x must be number 1, not string "1" (double-encode would give that)
    expect(parsedArgs.x).toBe(1);
  });

  test("null args stored as null", () => {
    tracker.insertPlanRun({
      id: "run-3",
      script: "emit_result({})",
      meta: { max_issues: 1 },
    });

    const stored = tracker.getPlanRun("run-3");
    expect(stored).not.toBeNull();
    expect(stored!.args).toBeNull();
  });

  test("meta with nested objects roundtrips correctly", () => {
    const meta = { max_issues: 10, tags: ["a", "b"], nested: { deep: true } };
    tracker.insertPlanRun({
      id: "run-4",
      script: "emit_result({})",
      meta,
    });

    const stored = tracker.getPlanRun("run-4");
    const parsedMeta = JSON.parse(stored!.meta);
    expect(parsedMeta.tags).toEqual(["a", "b"]);
    expect(parsedMeta.nested.deep).toBe(true);
  });
});
