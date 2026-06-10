import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawnAgent } from "../../src/spawner/index.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nano-symphony-spawner-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("spawnAgent (nano adapter)", () => {
  test("passes --permission-mode auto, sends prompt on stdin, parses stdout result", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > args.txt",
        "cat > stdin.txt",
        "printf '%s' \"$SYMPHONY_ISSUE_UUID\" > issue-uuid-env.txt",
        `printf '%s\\n' '{"status":"success","reason":"done"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    const result = await spawnAgent({
      issueUuid: "issue-1",
      attempt: 2,
      workspace,
      prompt: "prompt from stdin",
      token: "secret-token",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "nano",
    });

    expect(result.exitCode).toBe(0);
    expect(result.killedByTimeout).toBe(false);
    expect(result.agentResult).toEqual({ status: "success", reason: "done" });
    expect(await fs.readFile(path.join(workspace, "stdin.txt"), "utf-8")).toBe("prompt from stdin");
    expect(await fs.readFile(path.join(workspace, "issue-uuid-env.txt"), "utf-8")).toBe("issue-1");

    const args = await fs.readFile(path.join(workspace, "args.txt"), "utf-8");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("auto");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("mcp_symphony_*");

    // .mcp.json must be written with Claude Code compatible MCP config
    const mcpJson = await fs.readFile(path.join(workspace, ".mcp.json"), "utf-8");
    const parsed = JSON.parse(mcpJson);
    expect(parsed.mcpServers.symphony.type).toBe("http");
    expect(parsed.mcpServers.symphony.url).toBe("http://localhost:4123/mcp");
    expect(parsed.mcpServers.symphony.headers["X-Symphony-Token"]).toBe("secret-token");
  });

  test("returns null agentResult when stdout is empty", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(binary, "#!/bin/sh\ncat > /dev/null\nexit 0", "utf-8");
    await fs.chmod(binary, 0o755);

    const result = await spawnAgent({
      issueUuid: "issue-empty",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "nano",
    });

    expect(result.agentResult).toBeNull();
  });

  test("returns empty artifacts for nano adapter (patch no longer produced by agent)", async () => {
    const workspace = await makeTempDir();
    const outputDir = path.join(workspace, ".nano-out");
    await fs.mkdir(outputDir, { recursive: true });
    // Even if a legacy solution.patch exists, nano adapter should ignore it
    await fs.writeFile(path.join(outputDir, "solution.patch"), "diff --git a/foo b/foo\n", "utf-8");

    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        `printf '%s\\n' '{"status":"success"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    const result = await spawnAgent({
      issueUuid: "issue-patch",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "nano",
    });

    expect(result.artifacts).toEqual({});
  });

});

describe("spawnAgent (claude-code adapter)", () => {
  test("writes .mcp.json and system prompt for claude-code kind", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-claude.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        `printf '%s\\n' '{"type":"result","result":"{\\"status\\":\\"success\\",\\"reason\\":\\"done\\"}"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    const result = await spawnAgent({
      issueUuid: "issue-claude",
      attempt: 0,
      workspace,
      prompt: "do the thing",
      token: "tok-123",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "claude-code",
    });

    expect(result.exitCode).toBe(0);
    expect(result.agentResult).toEqual({ status: "success", reason: "done" });

    const mcpJson = await fs.readFile(path.join(workspace, ".mcp.json"), "utf-8");
    const parsed = JSON.parse(mcpJson);
    expect(parsed.mcpServers.symphony.url).toBe("http://localhost:4123/mcp");

    const systemPrompt = await fs.readFile(path.join(workspace, ".claude/append-system-prompt.md"), "utf-8");
    expect(systemPrompt).toContain("status");
    expect(systemPrompt).toContain("JSON");
  });

  test("returns null agentResult when envelope is_error and result missing", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-claude.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        // Missing `result` field — zod envelope rejects this
        `printf '%s\\n' '{"type":"error","is_error":true}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    const result = await spawnAgent({
      issueUuid: "issue-claude-err",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "claude-code",
    });

    expect(result.exitCode).toBe(0);
    expect(result.agentResult).toBeNull();
  });

  test("parses result from is_error envelope when result is present", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-claude.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        `printf '%s\\n' '{"type":"error","is_error":true,"result":"{\\"status\\":\\"abandoned\\",\\"reason\\":\\"rate limited\\"}"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    const result = await spawnAgent({
      issueUuid: "issue-claude-err2",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "claude-code",
    });

    expect(result.exitCode).toBe(0);
    expect(result.agentResult).toEqual({ status: "abandoned", reason: "rate limited" });
  });

  test("always returns artifacts object for claude-code adapter", async () => {
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

    const result = await spawnAgent({
      issueUuid: "issue-claude-art",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      agentKind: "claude-code",
    });

    expect(result.artifacts).toEqual({});
  });
  test("S3: child process does not receive symphony service credentials from env", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "env-probe.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        // Probe symphony's admin API token (must be blocked)
        "[ -n \"$API_TOKEN\" ] && printf '%s' \"$API_TOKEN\" > api-token-probe.txt || printf '%s' '<unset>' > api-token-probe.txt",
        // Probe an arbitrary user env var (must be forwarded in local trust mode)
        "[ -n \"$USER_CUSTOM_VAR\" ] && printf '%s' \"$USER_CUSTOM_VAR\" > user-var-probe.txt || printf '%s' '<unset>' > user-var-probe.txt",
        `printf '%s\n' '{"status":"success","reason":"done"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    const origApiToken = process.env.API_TOKEN;
    const origUserVar = process.env.USER_CUSTOM_VAR;
    process.env.API_TOKEN = "symphony-admin-secret";
    process.env.USER_CUSTOM_VAR = "user-value-1234";

    try {
      await spawnAgent({
        issueUuid: "issue-env-s3",
        attempt: 0,
        workspace,
        prompt: "test",
        token: "tok",
        mcpUrl: "http://localhost:4123/mcp",
        binary,
        timeoutMs: 5_000,
        agentKind: "nano",
      });
    } finally {
      if (origApiToken === undefined) delete process.env.API_TOKEN; else process.env.API_TOKEN = origApiToken;
      if (origUserVar === undefined) delete process.env.USER_CUSTOM_VAR; else process.env.USER_CUSTOM_VAR = origUserVar;
    }

    // Symphony admin credentials must NOT reach the agent
    const apiTokenProbe = await fs.readFile(path.join(workspace, "api-token-probe.txt"), "utf-8");
    expect(apiTokenProbe).toBe("<unset>");

    // Ordinary user env vars MUST reach the agent (local trust model)
    const userVarProbe = await fs.readFile(path.join(workspace, "user-var-probe.txt"), "utf-8");
    expect(userVarProbe).toBe("user-value-1234");
  });

});

describe("spawnAgent A1 — stdout tail ring buffer", () => {
  test("A1: parses result from last line when stdout has lots of padding", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fat-stdout.sh");

    // Emit padding lines then the result JSON on the final line.
    // This validates that parseResult finds a JSON line at the very end of stdout,
    // which is the core invariant guarded by the tail ring buffer.
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "yes 'padding line 0123456789abcdef' | head -n 20000",
        `printf '%s\\n' '{"status":"success","reason":"tail-found"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    const result = await spawnAgent({
      issueUuid: "issue-a1",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 15_000,
      agentKind: "nano",
    });

    expect(result.exitCode).toBe(0);
    expect(result.agentResult).not.toBeNull();
    expect(result.agentResult?.status).toBe("success");
    expect(result.agentResult?.reason).toBe("tail-found");
  });
});
