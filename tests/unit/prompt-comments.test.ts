import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { renderPrompt, formatComments } from "../../src/prompt/renderer.ts";

function mkTracker() {
  const db = new Database(":memory:");
  runMigrations(db);
  return createTracker(db);
}

describe("prompt comments rendering", () => {
  test("no comments: does not render comments block", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });

    const result = await renderPrompt("Do work", { }, { tracker, issueId: "i1" });
    expect(result.text).toBe("Do work");
    expect(result.meta.commentIds).toEqual([]);
    expect(result.meta.truncated).toBe(false);
  });

  test("renders comments in ts ASC order", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });
    tracker.addComment("i1", { body: "first comment", author: "alice" });
    tracker.addComment("i1", { body: "second comment", author: "operator" });

    const result = await renderPrompt("Do work", { }, { tracker, issueId: "i1" });
    expect(result.text).toContain("## Operator comments (2)");
    expect(result.text).toContain("first comment");
    expect(result.text).toContain("second comment");
    expect(result.text).toContain("alice");
    expect(result.text).toContain("operator");
    // Comments should come before the template text
    const commentsIdx = result.text.indexOf("## Operator comments");
    const bodyIdx = result.text.indexOf("Do work");
    expect(commentsIdx).toBeLessThan(bodyIdx);
    expect(result.meta.commentIds.length).toBe(2);
  });

  test("comments + revision_requested: correct order (revision first, then comments)", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });
    tracker.recordEvent("i1", "revision_requested", "Fix tests", { note: "Fix the failing tests" });
    tracker.addComment("i1", { body: "I added some context", author: "operator" });

    const result = await renderPrompt("Do work", { }, { tracker, issueId: "i1" });
    const reviewIdx = result.text.indexOf("Reviewer requested changes");
    const commentsIdx = result.text.indexOf("## Operator comments");
    expect(reviewIdx).toBeGreaterThanOrEqual(0);
    expect(commentsIdx).toBeGreaterThan(reviewIdx);
  });

  test("revision_requested not injected when started is more recent", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });
    tracker.recordEvent("i1", "revision_requested", "Fix tests", { note: "Fix the failing tests" });
    // Simulate a start event after revision_requested
    await new Promise((r) => setTimeout(r, 5));
    tracker.recordEvent("i1", "started", "Started", {});
    tracker.addComment("i1", { body: "context", author: "operator" });

    const result = await renderPrompt("Do work", { }, { tracker, issueId: "i1" });
    expect(result.text).not.toContain("Reviewer requested changes");
    expect(result.text).toContain("## Operator comments");
  });

  test("meta.commentIds matches injected comments", async () => {
    const tracker = mkTracker();
    tracker.insertIssue({ id: "i1", identifier: "TEST-1", title: "t", state: "todo" });
    const c1 = tracker.addComment("i1", { body: "comment one" });
    const c2 = tracker.addComment("i1", { body: "comment two" });

    const result = await renderPrompt("Do work", { }, { tracker, issueId: "i1" });
    expect(result.meta.commentIds).toContain(c1.id);
    expect(result.meta.commentIds).toContain(c2.id);
    expect(result.meta.commentIds.length).toBe(2);
  });
});

describe("formatComments truncation", () => {
  test("truncates by count (max 50)", () => {
    const comments = Array.from({ length: 60 }, (_, i) => ({
      id: `c${i}`,
      ts: 1000 + i,
      author: "op",
      body: `comment ${i}`,
    }));

    const { rendered, includedIds, truncated } = formatComments(comments);
    expect(includedIds.length).toBe(50);
    expect(truncated).toBe(true);
    expect(rendered).toContain("(10 older comments omitted)");
    // Should keep the LAST 50 (most recent)
    expect(includedIds[0]).toBe("c10");
    expect(includedIds[49]).toBe("c59");
  });

  test("truncates by byte limit", () => {
    // Create comments that exceed 16KiB total
    const bigBody = "x".repeat(2000);
    const comments = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      ts: 1000 + i,
      author: "op",
      body: bigBody,
    }));

    const { includedIds, truncated } = formatComments(comments);
    expect(includedIds.length).toBeLessThan(20);
    expect(truncated).toBe(true);
  });

  test("no truncation when within limits", () => {
    const comments = [
      { id: "c1", ts: 1000, author: "op", body: "short" },
      { id: "c2", ts: 1001, author: "op", body: "also short" },
    ];

    const { includedIds, truncated } = formatComments(comments);
    expect(includedIds.length).toBe(2);
    expect(truncated).toBe(false);
  });

  test("empty comments returns empty string", () => {
    const { rendered, includedIds, truncated } = formatComments([]);
    expect(rendered).toBe("");
    expect(includedIds).toEqual([]);
    expect(truncated).toBe(false);
  });
});
