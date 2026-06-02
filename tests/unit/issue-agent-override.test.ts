import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";

function mk() {
  const db = new Database(":memory:");
  runMigrations(db);
  return createTracker(db);
}

describe("tracker round-trips agent_kind", () => {
  test("insert + getIssue persists agent_kind override", () => {
    const t = mk();
    t.insertIssue({
      id: "i1", identifier: "I-1", title: "t", state: "todo",
      agent_kind: "claude-code",
    });
    const got = t.getIssue("i1")!;
    expect(got.agent_kind).toBe("claude-code");
  });

  test("missing override defaults to null", () => {
    const t = mk();
    t.insertIssue({ id: "i2", identifier: "I-2", title: "t", state: "todo" });
    const got = t.getIssue("i2")!;
    expect(got.agent_kind).toBeNull();
  });

  test("listIssues includes agent_kind field", () => {
    const t = mk();
    t.insertIssue({
      id: "i3", identifier: "I-3", title: "t", state: "todo",
      agent_kind: "nano",
    });
    const list = t.listIssues();
    const i3 = list.find((i) => i.id === "i3")!;
    expect(i3.agent_kind).toBe("nano");
  });
});
