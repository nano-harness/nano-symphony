import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ensureWorkspace, cleanupWorkspace } from "../src/workspace/manager.ts";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "bun";

describe("ensureWorkspace", () => {
  const testRoot = path.join(os.tmpdir(), "symphony-workspace-test");

  beforeEach(async () => {
    await fs.mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  test("returns managed=true with default path", async () => {
    const result = await ensureWorkspace("TEST-1");
    expect(result.managed).toBe(true);
    expect(result.path).toContain("TEST-1");
    // Verify directory was created
    await fs.stat(result.path);
  });

  test("honors override and returns managed=false", async () => {
    const customPath = path.join(testRoot, "custom-workspace");
    const result = await ensureWorkspace("TEST-2", customPath);
    expect(result.managed).toBe(false);
    expect(result.path).toBe(path.resolve(customPath));
    // Verify directory was created
    await fs.stat(result.path);
  });

  test("expands ~ in override path", async () => {
    const result = await ensureWorkspace("TEST-3", "~/test-workspace");
    expect(result.managed).toBe(false);
    expect(result.path).toContain(os.homedir());
    expect(result.path).toContain("test-workspace");
  });

  test("creates missing override dir (mkdir -p)", async () => {
    const nestedPath = path.join(testRoot, "deep", "nested", "path");
    const result = await ensureWorkspace("TEST-4", nestedPath);
    expect(result.managed).toBe(false);
    expect(result.path).toBe(path.resolve(nestedPath));
    // Verify nested directory was created
    await fs.stat(result.path);
  });

  test("handles relative override paths", async () => {
    const result = await ensureWorkspace("TEST-5", "relative/path");
    expect(result.managed).toBe(false);
    expect(path.isAbsolute(result.path)).toBe(true);
  });

  test("trims whitespace from override", async () => {
    const customPath = path.join(testRoot, "trimmed");
    const result = await ensureWorkspace("TEST-6", `  ${customPath}  `);
    expect(result.managed).toBe(false);
    expect(result.path).toBe(path.resolve(customPath));
  });

  test("treats empty string as no override", async () => {
    const result = await ensureWorkspace("TEST-7", "");
    expect(result.managed).toBe(true);
    expect(result.path).toContain("TEST-7");
  });

  test("treats null as no override", async () => {
    const result = await ensureWorkspace("TEST-8", null);
    expect(result.managed).toBe(true);
    expect(result.path).toContain("TEST-8");
  });
});

describe("cleanupWorkspace", () => {
  const testRoot = path.join(os.tmpdir(), "symphony-cleanup-test");

  beforeEach(async () => {
    await fs.mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  test("is no-op when managed=false", async () => {
    const externalPath = path.join(testRoot, "external");
    await fs.mkdir(externalPath, { recursive: true });
    await fs.writeFile(path.join(externalPath, "file.txt"), "content");

    await cleanupWorkspace(externalPath, false);

    // Directory should still exist
    await fs.stat(externalPath);
    const content = await fs.readFile(path.join(externalPath, "file.txt"), "utf-8");
    expect(content).toBe("content");
  });

  test("removes directory when managed=true", async () => {
    const managedPath = path.join(testRoot, "managed");
    await fs.mkdir(managedPath, { recursive: true });
    await fs.writeFile(path.join(managedPath, "file.txt"), "content");

    await cleanupWorkspace(managedPath, true);

    // Directory should be removed
    try {
      await fs.stat(managedPath);
      expect.unreachable("Directory should have been removed");
    } catch (err: any) {
      expect(err.code).toBe("ENOENT");
    }
  });
});

describe("ensureWorkspace git baseline", () => {
  const tmpRoot = path.join(os.tmpdir(), "symphony-git-baseline-test");

  test("managed + git_baseline=true initializes git with empty baseline", async () => {
    const result = await ensureWorkspace("TEST-GB-1", null, tmpRoot, true);
    await fs.stat(path.join(result.path, ".git"));
    const proc = spawn(["git", "-C", result.path, "rev-parse", "HEAD"], { stdout: "pipe" });
    expect(await proc.exited).toBe(0);
    await fs.rm(result.path, { recursive: true, force: true });
  });

  test("managed + git_baseline=false skips init", async () => {
    const result = await ensureWorkspace("TEST-GB-2", null, tmpRoot, false);
    await fs.stat(path.join(result.path, ".git")).then(
      () => expect.unreachable(".git should not exist"),
      (err: any) => expect(err.code).toBe("ENOENT")
    );
    await fs.rm(result.path, { recursive: true, force: true });
  });

  test("external workspace_path is never initialized even with git_baseline=true", async () => {
    const ext = path.join(tmpRoot, "external-no-git");
    await fs.mkdir(ext, { recursive: true });
    const result = await ensureWorkspace("TEST-GB-3", ext, tmpRoot, true);
    await fs.stat(path.join(result.path, ".git")).then(
      () => expect.unreachable("external path must not be auto-initialized"),
      (err: any) => expect(err.code).toBe("ENOENT")
    );
    await fs.rm(ext, { recursive: true, force: true });
  });

  test("re-ensure on existing managed dir does not corrupt git state", async () => {
    const result1 = await ensureWorkspace("TEST-GB-4", null, tmpRoot, true);
    await fs.writeFile(path.join(result1.path, "x.txt"), "hello", "utf-8");
    const result2 = await ensureWorkspace("TEST-GB-4", null, tmpRoot, true);
    expect(result2.path).toBe(result1.path);
    const proc = spawn(["git", "-C", result2.path, "status", "--porcelain"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(out).toContain("x.txt");
    await fs.rm(result1.path, { recursive: true, force: true });
  });
});
