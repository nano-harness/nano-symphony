import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { runMigrations } from "../../src/db/migrations.ts";
import { createTracker } from "../../src/db/tracker.ts";
import { createHttpServer } from "../../src/http/server.ts";

const TEST_TOKEN = "symlink-test-token";

async function makeAppWithWorkspace(workspacePath: string) {
  const db = new Database(":memory:");
  runMigrations(db);
  const tracker = createTracker(db);

  const ISSUE_ID = "ws-test-1";
  tracker.insertIssue({
    uuid: ISSUE_ID,
    title: "Workspace test",
    priority: "medium",
    state: "todo",
    labels: [],
  });
  // claimIssue creates the run row; updateWorkspacePath sets the path.
  tracker.claimIssue(ISSUE_ID, 0);
  tracker.updateWorkspacePath(ISSUE_ID, workspacePath, false);

  const app = createHttpServer(tracker, () => undefined, () => {}, { apiToken: TEST_TOKEN });
  return { app, issueId: ISSUE_ID };
}

describe("S4: Workspace file endpoint symlink protection", () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-s4-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("reading a normal file inside workspace succeeds", async () => {
    const file = path.join(workspaceDir, "hello.txt");
    await fs.writeFile(file, "hello world");

    const { app, issueId } = await makeAppWithWorkspace(workspaceDir);
    const res = await app.request("/api/v1/workspaces/" + issueId + "/file?path=hello.txt", {
      headers: { "X-Symphony-Token": TEST_TOKEN },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello world");
  });

  test("symlink pointing outside workspace is blocked (403)", async () => {
    // Create a target file outside workspace
    const externalFile = path.join(tmpDir, "secret.txt");
    await fs.writeFile(externalFile, "top secret");

    // Create symlink inside workspace pointing to external file
    const symlinkPath = path.join(workspaceDir, "escape.txt");
    await fs.symlink(externalFile, symlinkPath);

    const { app, issueId } = await makeAppWithWorkspace(workspaceDir);
    const res = await app.request("/api/v1/workspaces/" + issueId + "/file?path=escape.txt", {
      headers: { "X-Symphony-Token": TEST_TOKEN },
    });
    expect(res.status).toBe(403);
  });

  test("path traversal (../) is blocked (403 or 404)", async () => {
    const { app, issueId } = await makeAppWithWorkspace(workspaceDir);
    // Attempt to read outside the workspace via path traversal
    const res = await app.request(
      "/api/v1/workspaces/" + issueId + "/file?path=" + encodeURIComponent("../../etc/passwd"),
      { headers: { "X-Symphony-Token": TEST_TOKEN } }
    );
    // Should be blocked — either 403 (path escape) or 404 (file not found outside)
    expect([403, 404]).toContain(res.status);
  });
});
