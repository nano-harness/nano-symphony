import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";

function mkTracker() {
  const db = new Database(":memory:");
  runMigrations(db);
  return createTracker(db);
}

describe("tracker comments", () => {
  let tracker: ReturnType<typeof mkTracker>;

  beforeEach(() => {
    tracker = mkTracker();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "Test issue", state: "todo" });
  });

  test("addComment creates a comment with default author", () => {
    const comment = tracker.addComment("i1", { body: "Hello world" });
    expect(comment.id).toBeTruthy();
    expect(comment.issue_id).toBe("i1");
    expect(comment.author).toBe("operator");
    expect(comment.body).toBe("Hello world");
    expect(comment.ts).toBeGreaterThan(0);
    expect(comment.metadata).toBeNull();
  });

  test("addComment with custom author", () => {
    const comment = tracker.addComment("i1", { body: "Hi", author: "alice" });
    expect(comment.author).toBe("alice");
  });

  test("addComment with metadata", () => {
    const comment = tracker.addComment("i1", { body: "Meta", metadata: { kind: "directive" } });
    expect(comment.metadata).toEqual({ kind: "directive" });
  });

  test("listComments returns comments in ts ASC order", async () => {
    tracker.addComment("i1", { body: "first" });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    tracker.addComment("i1", { body: "second" });
    await new Promise((r) => setTimeout(r, 5));
    tracker.addComment("i1", { body: "third" });

    const comments = tracker.listComments("i1");
    expect(comments.length).toBe(3);
    expect(comments[0].body).toBe("first");
    expect(comments[1].body).toBe("second");
    expect(comments[2].body).toBe("third");
    expect(comments[0].ts).toBeLessThanOrEqual(comments[1].ts);
    expect(comments[1].ts).toBeLessThanOrEqual(comments[2].ts);
  });

  test("listComments with since filter", async () => {
    const c1 = tracker.addComment("i1", { body: "old" });
    await new Promise((r) => setTimeout(r, 5));
    tracker.addComment("i1", { body: "new" });

    const comments = tracker.listComments("i1", { since: c1.ts });
    expect(comments.length).toBe(1);
    expect(comments[0].body).toBe("new");
  });

  test("listComments with limit", () => {
    tracker.addComment("i1", { body: "a" });
    tracker.addComment("i1", { body: "b" });
    tracker.addComment("i1", { body: "c" });

    const comments = tracker.listComments("i1", { limit: 2 });
    expect(comments.length).toBe(2);
  });

  test("getComment returns comment by id", () => {
    const created = tracker.addComment("i1", { body: "find me" });
    const found = tracker.getComment(created.id);
    expect(found).not.toBeNull();
    expect(found!.body).toBe("find me");
    expect(found!.id).toBe(created.id);
  });

  test("getComment returns null for non-existent id", () => {
    expect(tracker.getComment("nonexistent")).toBeNull();
  });

  test("deleteComment removes the comment", () => {
    const comment = tracker.addComment("i1", { body: "to delete" });
    const deleted = tracker.deleteComment(comment.id);
    expect(deleted).toBe(true);
    expect(tracker.getComment(comment.id)).toBeNull();
  });

  test("deleteComment is idempotent (returns false for non-existent)", () => {
    const deleted = tracker.deleteComment("nonexistent");
    expect(deleted).toBe(false);
  });

  test("countComments returns correct count", () => {
    expect(tracker.countComments("i1")).toBe(0);
    tracker.addComment("i1", { body: "a" });
    tracker.addComment("i1", { body: "b" });
    expect(tracker.countComments("i1")).toBe(2);
  });

  test("deleteIssue cascades to comments", () => {
    tracker.addComment("i1", { body: "will be deleted" });
    tracker.addComment("i1", { body: "also deleted" });
    expect(tracker.countComments("i1")).toBe(2);

    tracker.deleteIssue("i1");
    // After deletion, no orphan comments
    expect(tracker.listComments("i1")).toEqual([]);
  });

  test("comments are scoped to issue", () => {
    tracker.insertIssue({ id: "i2", identifier: "TEST-2", title: "Other", state: "todo" });
    tracker.addComment("i1", { body: "for i1" });
    tracker.addComment("i2", { body: "for i2" });

    expect(tracker.listComments("i1").length).toBe(1);
    expect(tracker.listComments("i2").length).toBe(1);
    expect(tracker.listComments("i1")[0].body).toBe("for i1");
    expect(tracker.listComments("i2")[0].body).toBe("for i2");
  });
});
