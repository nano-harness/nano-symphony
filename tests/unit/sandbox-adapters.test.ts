import { describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawnAgent } from "../../src/spawner/index.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-claude-sb-"));
  tempDirs.push(dir);
  return dir;
}

describe("claude-code adapter sandbox settings", () => {
  test("writes .claude/settings.local.json with sandbox enabled and critical paths", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-claude.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        `printf '%s\\n' '{"type":"result","result":"{\\"status\\":\\"success\\"}"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueId: "claude-sb-1",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "claude-code",
      sandboxConfig: {
        backend: "native",
        network_access: true,
        extra_read_only_paths: ["/custom/read"],
        extra_writable_paths: ["/custom/write"],
        extra_denied_paths: ["/custom/denied"],
      },
    });

    const settingsPath = path.join(workspace, ".claude/settings.local.json");
    const raw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw);

    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.filesystem.allowWrite).toContain("/custom/write");
    expect(settings.sandbox.filesystem.allowRead).toContain("/custom/read");

    // Critical paths in both denyRead and denyWrite
    const home = os.homedir();
    expect(settings.sandbox.filesystem.denyWrite).toContain(path.join(home, ".ssh"));
    expect(settings.sandbox.filesystem.denyWrite).toContain(path.join(home, ".aws"));
    expect(settings.sandbox.filesystem.denyWrite).toContain(path.join(home, ".gnupg"));
    expect(settings.sandbox.filesystem.denyWrite).toContain(path.join(home, ".kube"));
    expect(settings.sandbox.filesystem.denyWrite).toContain(path.join(home, ".config/gh"));
    expect(settings.sandbox.filesystem.denyWrite).toContain(path.join(home, ".docker/config.json"));

    expect(settings.sandbox.filesystem.denyRead).toContain(path.join(home, ".ssh"));
    expect(settings.sandbox.filesystem.denyRead).toContain(path.join(home, ".aws"));

    // Extra denied paths merged
    expect(settings.sandbox.filesystem.denyWrite).toContain("/custom/denied");
    expect(settings.sandbox.filesystem.denyRead).toContain("/custom/denied");

    // No network block when network_access is true
    expect(settings.sandbox.network).toBeUndefined();
  });

  test("writes sandbox disabled when backend=none", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-claude.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        `printf '%s\\n' '{"type":"result","result":"{\\"status\\":\\"success\\"}"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueId: "claude-sb-2",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "claude-code",
      sandboxConfig: {
        backend: "none",
        network_access: true,
        extra_read_only_paths: [],
        extra_writable_paths: [],
        extra_denied_paths: [],
      },
    });

    const settingsPath = path.join(workspace, ".claude/settings.local.json");
    const raw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw);

    expect(settings.sandbox.enabled).toBe(false);
    expect(settings.sandbox.filesystem).toBeUndefined();
  });

  test("disables network via empty allowedDomains when network_access=false", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-claude.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        `printf '%s\\n' '{"type":"result","result":"{\\"status\\":\\"success\\"}"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueId: "claude-sb-3",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "claude-code",
      sandboxConfig: {
        backend: "native",
        network_access: false,
        extra_read_only_paths: [],
        extra_writable_paths: [],
        extra_denied_paths: [],
      },
    });

    const settingsPath = path.join(workspace, ".claude/settings.local.json");
    const raw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw);

    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.network.allowedDomains).toEqual([]);
  });
});

describe("nano adapter .nano/nano.yaml path", () => {
  test("writes to .nano/nano.yaml not .nano.yaml", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(binary, "#!/bin/sh\ncat > /dev/null\nexit 0", "utf-8");
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueId: "nano-path-1",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
    });

    // .nano/nano.yaml must exist
    const newPath = path.join(workspace, ".nano/nano.yaml");
    const stat = await fs.stat(newPath);
    expect(stat.isFile()).toBe(true);

    // Legacy .nano.yaml must NOT exist
    const legacyPath = path.join(workspace, ".nano.yaml");
    let legacyExists = true;
    try { await fs.stat(legacyPath); } catch { legacyExists = false; }
    expect(legacyExists).toBe(false);
  });

  test("includes extra_denied_paths in .nano/nano.yaml when present", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(binary, "#!/bin/sh\ncat > /dev/null\nexit 0", "utf-8");
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueId: "nano-denied-1",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      sandboxConfig: {
        backend: "native",
        network_access: true,
        extra_read_only_paths: [],
        extra_writable_paths: [],
        extra_denied_paths: ["/secrets/vault", "/etc/shadow"],
      },
    });

    const yaml = await fs.readFile(path.join(workspace, ".nano/nano.yaml"), "utf-8");
    expect(yaml).toContain("extra_denied_paths:");
    expect(yaml).toContain("/secrets/vault");
    expect(yaml).toContain("/etc/shadow");
  });

  test("omits extra_denied_paths when backend=none", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(binary, "#!/bin/sh\ncat > /dev/null\nexit 0", "utf-8");
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueId: "nano-denied-2",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      sandboxConfig: {
        backend: "none",
        network_access: true,
        extra_read_only_paths: [],
        extra_writable_paths: [],
        extra_denied_paths: ["/secrets/vault"],
      },
    });

    const yaml = await fs.readFile(path.join(workspace, ".nano/nano.yaml"), "utf-8");
    expect(yaml).not.toContain("extra_denied_paths:");
    expect(yaml).toContain("enabled: false");
  });
});
