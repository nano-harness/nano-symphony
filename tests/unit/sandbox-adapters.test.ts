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

describe("claude-code adapter settings", () => {
  test("does not write .claude/settings.local.json", async () => {
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
      issueUuid: "claude-settings-1",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "claude-code",
    });

    const settingsPath = path.join(workspace, ".claude/settings.local.json");
    await expect(fs.access(settingsPath)).rejects.toBeDefined();
  });

  test("uses --permission-mode auto in spawn invocation", async () => {
    const workspace = await makeTempDir();
    const argsFile = path.join(workspace, "args.txt");
    const binary = path.join(workspace, "fake-claude.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        `echo "$@" > ${argsFile}`,
        "cat > /dev/null",
        `printf '%s\\n' '{"type":"result","result":"{\\"status\\":\\"success\\"}"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueUuid: "claude-settings-2",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "claude-code",
    });

    const args = await fs.readFile(argsFile, "utf-8");
    expect(args).toContain("--permission-mode auto");
  });

  test("uses MCP config when transport is mcp", async () => {
    const workspace = await makeTempDir();
    const argsFile = path.join(workspace, "args.txt");
    const binary = path.join(workspace, "fake-claude.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        `echo "$@" > ${argsFile}`,
        "cat > /dev/null",
        `printf '%s\\n' '{"type":"result","result":"{\\"status\\":\\"success\\"}"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueUuid: "claude-settings-3",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "claude-code",
      agentConfig: { transport: "mcp" },
    });

    const args = await fs.readFile(argsFile, "utf-8");
    expect(args).toContain("--mcp-config");
  });
});
