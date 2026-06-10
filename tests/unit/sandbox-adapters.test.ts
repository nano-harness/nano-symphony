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
  test("writes .claude/settings.local.json as empty object", async () => {
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
    const raw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw);

    // Settings should be empty — let the user's own claude-code settings manage sandbox
    expect(settings).toEqual({});
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
});
