import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { createTracker } from "../../src/db/tracker.ts";
import { runMigrations } from "../../src/db/migrations.ts";
import { handleTool } from "../../src/mcp/tools.ts";

describe("related artifacts context sharing", () => {
  let db: Database;
  let tracker: ReturnType<typeof createTracker>;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    tracker = createTracker(db);
  });

  it("lists artifacts from sibling issues in the same plan run", async () => {
    const parent = tracker.insertIssue({ uuid: nanoid(), title: "parent", state: "in_progress" });
    tracker.insertPlanRun({ id: "RUN-1", caller_issue_uuid: parent.uuid, script: "", meta: { name: "r", max_issues: 10 }, wall_time_ms: 60_000 });
    const sub1 = tracker.insertIssue({ uuid: nanoid(), title: "s1", state: "todo", plan_run_id: "RUN-1" });
    const sub2 = tracker.insertIssue({ uuid: nanoid(), title: "s2", state: "todo", plan_run_id: "RUN-1" });

    tracker.insertArtifact({ issue_uuid: sub1.uuid, attempt: 0, source: "mcp", kind: "note", label: "sub1 note", content: "hello" });
    tracker.insertArtifact({ issue_uuid: sub2.uuid, attempt: 0, source: "mcp", kind: "note", label: "sub2 note", content: "world" });

    const result = (await handleTool("symphony.list_related_artifacts", {}, sub1.uuid, 0, tracker)) as {
      related_issue_uuids: string[];
      artifacts: Array<{ issue_uuid: string; label: string | null }>;
    };

    expect(result.related_issue_uuids).toContain(sub2.uuid);
    expect(result.related_issue_uuids).not.toContain(sub1.uuid);
    expect(result.artifacts.some((a) => a.issue_uuid === sub2.uuid && a.label === "sub2 note")).toBe(true);
    expect(result.artifacts.some((a) => a.issue_uuid === sub1.uuid)).toBe(false);
  });

  it("includes parent issue and blocker artifacts", async () => {
    const parent = tracker.insertIssue({ uuid: nanoid(), title: "parent", state: "in_progress" });
    const child = tracker.insertIssue({ uuid: nanoid(), title: "child", state: "todo" });
    const blocker = tracker.insertIssue({ uuid: nanoid(), title: "blocker", state: "done" });

    tracker.insertPlanRun({ id: "RUN-2", caller_issue_uuid: parent.uuid, script: "", meta: { name: "r", max_issues: 10 }, wall_time_ms: 60_000 });
    tracker.updateIssue(child.uuid, { title: child.title, state: child.state, plan_run_id: "RUN-2" });
    tracker.insertBlocker(child.uuid, blocker.uuid, "done");

    tracker.insertArtifact({ issue_uuid: parent.uuid, attempt: 0, source: "mcp", kind: "note", label: "parent note", content: "p" });
    tracker.insertArtifact({ issue_uuid: blocker.uuid, attempt: 0, source: "mcp", kind: "note", label: "blocker note", content: "b" });

    const result = (await handleTool("symphony.list_related_artifacts", {}, child.uuid, 0, tracker)) as {
      related_issue_uuids: string[];
      artifacts: Array<{ issue_uuid: string; label: string | null }>;
    };

    expect(result.related_issue_uuids).toContain(parent.uuid);
    expect(result.related_issue_uuids).toContain(blocker.uuid);
    expect(result.artifacts.some((a) => a.label === "parent note")).toBe(true);
    expect(result.artifacts.some((a) => a.label === "blocker note")).toBe(true);
  });

  it("lists artifacts for multiple related issues via tracker helper", () => {
    const a = tracker.insertIssue({ uuid: nanoid(), title: "a", state: "done" });
    const b = tracker.insertIssue({ uuid: nanoid(), title: "b", state: "done" });
    tracker.insertArtifact({ issue_uuid: a.uuid, attempt: 0, source: "mcp", kind: "note", label: "a1", content: "a" });
    tracker.insertArtifact({ issue_uuid: b.uuid, attempt: 0, source: "mcp", kind: "note", label: "b1", content: "b" });

    const artifacts = tracker.listArtifactsByIssues([a.uuid, b.uuid]);
    expect(artifacts.length).toBe(2);
    expect(artifacts.map((x) => x.label).sort()).toEqual(["a1", "b1"]);
  });
});
