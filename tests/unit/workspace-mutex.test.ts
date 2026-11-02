import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import path from "path";
import os from "os";
import { createTracker } from "../../src/db/tracker.ts";
import { runMigrations } from "../../src/db/migrations.ts";
import { findWorkspaceConflict, recordWorkspaceConflictSkipped } from "../../src/orchestrator/index.ts";
import { resolveWorkspacePath } from "../../src/workspace/manager.ts";

describe("cross-issue workspace mutual exclusion", () => {
  let db: Database;
  let tracker: ReturnType<typeof createTracker>;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    tracker = createTracker(db);
  });

  function insertWithWorkspace(title: string, workspacePath: string) {
    return tracker.insertIssue({ uuid: nanoid(), title, state: "todo", workspace_path: workspacePath });
  }

  it("resolves override paths like ensureWorkspace (absolute, relative, ~)", () => {
    expect(resolveWorkspacePath("/tmp/ws")).toBe(path.resolve("/tmp/ws"));
    expect(resolveWorkspacePath("/tmp/ws/")).toBe(path.resolve("/tmp/ws"));
    expect(resolveWorkspacePath("rel/ws", "/tmp/root")).toBe(path.resolve("/tmp/root", "rel/ws"));
    expect(resolveWorkspacePath("~/ws")).toBe(path.resolve(os.homedir(), "ws"));
  });

  it("returns null when no run holds the workspace", () => {
    const issue = insertWithWorkspace("candidate", "/tmp/ws-mutex-a");
    expect(findWorkspaceConflict(tracker, issue.uuid, "/tmp/ws-mutex-a")).toBeNull();
  });

  it("detects a conflict against a claimed run that has not started its worker yet", () => {
    const holder = insertWithWorkspace("holder", "/tmp/ws-mutex-b");
    tracker.claimIssue(holder.uuid, 0);
    const candidate = insertWithWorkspace("candidate", "/tmp/ws-mutex-b");

    const conflict = findWorkspaceConflict(tracker, candidate.uuid, "/tmp/ws-mutex-b");
    expect(conflict).not.toBeNull();
    expect(conflict!.conflicting_issue_uuid).toBe(holder.uuid);
    expect(conflict!.workspace_path).toBe(path.resolve("/tmp/ws-mutex-b"));
  });

  it("matches equivalent spellings of the same directory", () => {
    const holder = insertWithWorkspace("holder", "/tmp/ws-mutex-c/");
    tracker.claimIssue(holder.uuid, 0);
    const candidate = insertWithWorkspace("candidate", "/tmp/ws-mutex-c");

    expect(findWorkspaceConflict(tracker, candidate.uuid, "/tmp/ws-mutex-c")).not.toBeNull();
  });

  it("detects a conflict against the resolved path recorded by a running worker", () => {
    const holder = tracker.insertIssue({ uuid: nanoid(), title: "holder", state: "todo", workspace_path: "ext/ws" });
    tracker.claimIssue(holder.uuid, 0);
    // Worker stores the resolved absolute path once it starts.
    tracker.updateWorkspacePath(holder.uuid, path.resolve("/tmp/root-x", "ext/ws"), false);
    const candidate = insertWithWorkspace("candidate", "/tmp/root-x/ext/ws");

    const conflict = findWorkspaceConflict(tracker, candidate.uuid, "/tmp/root-x/ext/ws", "/tmp/root-x");
    expect(conflict).not.toBeNull();
    expect(conflict!.conflicting_issue_uuid).toBe(holder.uuid);
  });

  it("does not conflict with the candidate's own active run", () => {
    const issue = insertWithWorkspace("self", "/tmp/ws-mutex-d");
    tracker.claimIssue(issue.uuid, 0);
    expect(findWorkspaceConflict(tracker, issue.uuid, "/tmp/ws-mutex-d")).toBeNull();
  });

  it("does not conflict with a different workspace", () => {
    const holder = insertWithWorkspace("holder", "/tmp/ws-mutex-e");
    tracker.claimIssue(holder.uuid, 0);
    const candidate = insertWithWorkspace("candidate", "/tmp/ws-mutex-f");
    expect(findWorkspaceConflict(tracker, candidate.uuid, "/tmp/ws-mutex-f")).toBeNull();
  });

  it("treats a retry_queued run as still holding its workspace", () => {
    const holder = insertWithWorkspace("holder", "/tmp/ws-mutex-g");
    tracker.claimIssue(holder.uuid, 0);
    tracker.scheduleRetry(holder.uuid, Date.now() + 60_000, 1);
    const candidate = insertWithWorkspace("candidate", "/tmp/ws-mutex-g");

    const conflict = findWorkspaceConflict(tracker, candidate.uuid, "/tmp/ws-mutex-g");
    expect(conflict).not.toBeNull();
    expect(conflict!.conflicting_issue_uuid).toBe(holder.uuid);
  });

  it("frees the workspace once the holding run is released", () => {
    const holder = insertWithWorkspace("holder", "/tmp/ws-mutex-h");
    tracker.claimIssue(holder.uuid, 0);
    tracker.releaseIssue(holder.uuid, "released");
    const candidate = insertWithWorkspace("candidate", "/tmp/ws-mutex-h");

    expect(findWorkspaceConflict(tracker, candidate.uuid, "/tmp/ws-mutex-h")).toBeNull();
  });

  it("records a workspace_conflict_skipped event and throttles repeats", () => {
    const candidate = insertWithWorkspace("candidate", "/tmp/ws-mutex-i");
    const conflict = { workspace_path: path.resolve("/tmp/ws-mutex-i"), conflicting_issue_uuid: "holder-uuid" };

    recordWorkspaceConflictSkipped(tracker, candidate.uuid, conflict);
    recordWorkspaceConflictSkipped(tracker, candidate.uuid, conflict);

    const events = tracker.getEventsByKind(candidate.uuid, "workspace_conflict_skipped");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payload_json ?? "{}") as { workspace_path: string; conflicting_issue_uuid: string };
    expect(payload.workspace_path).toBe(conflict.workspace_path);
    expect(payload.conflicting_issue_uuid).toBe("holder-uuid");
  });

  it("records a fresh event when the conflicting issue changes", () => {
    const candidate = insertWithWorkspace("candidate", "/tmp/ws-mutex-j");

    recordWorkspaceConflictSkipped(tracker, candidate.uuid, { workspace_path: "/tmp/ws-mutex-j", conflicting_issue_uuid: "holder-1" });
    recordWorkspaceConflictSkipped(tracker, candidate.uuid, { workspace_path: "/tmp/ws-mutex-j", conflicting_issue_uuid: "holder-2" });

    expect(tracker.getEventsByKind(candidate.uuid, "workspace_conflict_skipped").length).toBe(2);
  });
});
