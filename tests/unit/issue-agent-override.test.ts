import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";

function mk() {
  const db = new Database(":memory:");
  runMigrations(db);
  return createTracker(db);
}

describe("tracker round-trips agent_kind / agent_binary", () => {
  test("insert + getIssue persists overrides", () => {
    const t = mk();
    t.insertIssue({
      id: "i1", identifier: "I-1", title: "t", state: "todo",
      agent_kind: "claude-code", agent_binary: "/opt/claude",
    });
    const got = t.getIssue("i1")!;
    expect(got.agent_kind).toBe("claude-code");
    expect(got.agent_binary).toBe("/opt/claude");
  });

  test("missing overrides default to null", () => {
    const t = mk();
    t.insertIssue({ id: "i2", identifier: "I-2", title: "t", state: "todo" });
    const got = t.getIssue("i2")!;
    expect(got.agent_kind).toBeNull();
    expect(got.agent_binary).toBeNull();
  });

  test("listIssues includes agent fields", () => {
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
