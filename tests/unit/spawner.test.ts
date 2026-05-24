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
  test("writes .nano/nano.yaml with mcp config, sends prompt on stdin, parses stdout result", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > args.txt",
        "cat > stdin.txt",
        "printf '%s' \"$SYMPHONY_TOKEN\" > token-env.txt",
        `printf '%s\\n' '{"status":"success","reason":"done"}'`,
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    const result = await spawnAgent({
      issueId: "issue-1",
      attempt: 2,
      workspace,
      prompt: "prompt from stdin",
      token: "secret-token",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.killedByTimeout).toBe(false);
    expect(result.agentResult).toEqual({ status: "success", reason: "done" });
    expect(await fs.readFile(path.join(workspace, "stdin.txt"), "utf-8")).toBe("prompt from stdin");
    expect(await fs.readFile(path.join(workspace, "token-env.txt"), "utf-8")).toBe("secret-token");

    const nanoYaml = await fs.readFile(path.join(workspace, ".nano/nano.yaml"), "utf-8");
    expect(nanoYaml).toContain("transport: streamable");
    expect(nanoYaml).toContain('X-Symphony-Token: "${env:SYMPHONY_TOKEN}"');
    expect(nanoYaml).toContain("sandbox:");
    expect(nanoYaml).toContain("enabled: true");
    expect(nanoYaml).toContain("backend: native");
    expect(nanoYaml).toContain("network_access: true");
    expect(nanoYaml).toContain("read_only_paths:");
    expect(nanoYaml).toContain(".config/nano");
    expect(nanoYaml).not.toContain("secret-token");
    // New format uses mcp: top-level key
    expect(nanoYaml).toContain("mcp:");
    expect(nanoYaml).toContain("servers:");
    // No result hook in new format
    expect(nanoYaml).not.toContain("hooks:");
    expect(nanoYaml).not.toContain("Stop:");
    expect(nanoYaml).not.toContain("result-hook.sh");
  });

  test("returns null agentResult when stdout is empty", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(binary, "#!/bin/sh\ncat > /dev/null\nexit 0", "utf-8");
    await fs.chmod(binary, 0o755);

    const result = await spawnAgent({
      issueId: "issue-empty",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
    });

    expect(result.agentResult).toBeNull();
  });

  test("collects patch artifact from output dir", async () => {
    const workspace = await makeTempDir();
    const outputDir = path.join(workspace, ".nano-out");
    await fs.mkdir(outputDir, { recursive: true });
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
      issueId: "issue-patch",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
    });

    expect(result.artifacts.patch).toBe("diff --git a/foo b/foo\n");
  });

  test("auto-injects Linux default read-only paths for native sandbox on linux", async () => {
    if (process.platform !== "linux") {
      return; // Skip on non-Linux platforms
    }

    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(binary, "#!/bin/sh\ncat > /dev/null\nexit 0", "utf-8");
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueId: "issue-linux",
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
        extra_denied_paths: [],
      },
    });

    const nanoYaml = await fs.readFile(path.join(workspace, ".nano/nano.yaml"), "utf-8");
    expect(nanoYaml).toContain('"/opt"');
    expect(nanoYaml).toContain('.local"');
    expect(nanoYaml).toContain('.bun"');
    expect(nanoYaml).toContain('.cargo"');
    expect(nanoYaml).toContain('.rustup"');
    expect(nanoYaml).toContain('.nvm"');
    expect(nanoYaml).toContain('.pyenv"');
  });

  test("merges user paths with platform defaults without duplicates", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(binary, "#!/bin/sh\ncat > /dev/null\nexit 0", "utf-8");
    await fs.chmod(binary, 0o755);

    const userPath = process.platform === "darwin" ? "/opt/homebrew" : "/opt";
    const customPath = "/Users/me/.gitconfig";

    await spawnAgent({
      issueId: "issue-merge",
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
        extra_read_only_paths: [userPath, customPath],
        extra_writable_paths: [],
        extra_denied_paths: [],
      },
    });

    const nanoYaml = await fs.readFile(path.join(workspace, ".nano/nano.yaml"), "utf-8");
    const lines = nanoYaml.split("\n");
    const userPathOccurrences = lines.filter((line) => line.includes(`"${userPath}"`)).length;

    // Should appear exactly once (no duplicates)
    expect(userPathOccurrences).toBe(1);
    expect(nanoYaml).toContain(`"${customPath}"`);
    expect(nanoYaml).toContain('.local"');
  });

  test("does not inject platform defaults for docker or none backends", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(binary, "#!/bin/sh\ncat > /dev/null\nexit 0", "utf-8");
    await fs.chmod(binary, 0o755);

    // Test docker backend
    await spawnAgent({
      issueId: "issue-docker",
      attempt: 0,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      sandboxConfig: {
        backend: "docker",
        network_access: true,
        extra_read_only_paths: [],
        extra_writable_paths: [],
        extra_denied_paths: [],
      },
    });

    let nanoYaml = await fs.readFile(path.join(workspace, ".nano/nano.yaml"), "utf-8");
    expect(nanoYaml).toContain("extra_read_only_paths: []");
    expect(nanoYaml).toContain("read_only_paths: []");

    // Test none backend
    await spawnAgent({
      issueId: "issue-none",
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
        extra_denied_paths: [],
      },
    });

    nanoYaml = await fs.readFile(path.join(workspace, ".nano/nano.yaml"), "utf-8");
    expect(nanoYaml).toContain("extra_read_only_paths: []");
    expect(nanoYaml).toContain("read_only_paths: []");
  });

  test("writes permission_mode to .nano/nano.yaml and command args when specified", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > args.txt",
        "printf '%s' \"$NANO_PERMISSION_MODE\" > permission-mode-env.txt",
        "cat > /dev/null",
        "exit 0",
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueId: "issue-perm",
      attempt: 1,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      permissionMode: "auto",
    });

    const nanoYaml = await fs.readFile(path.join(workspace, ".nano/nano.yaml"), "utf-8");
    expect(nanoYaml).toContain("permission_mode: auto");

    const args = await fs.readFile(path.join(workspace, "args.txt"), "utf-8");
    expect(args).toContain("--permission-mode=auto");

    const permEnv = await fs.readFile(path.join(workspace, "permission-mode-env.txt"), "utf-8");
    expect(permEnv).toBe("auto");
  });

  test("writes permission_auto config to .nano/nano.yaml when specified", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(binary, "#!/bin/sh\ncat > /dev/null\nexit 0", "utf-8");
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueId: "issue-perm-auto",
      attempt: 1,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      permissionMode: "auto",
      permissionAuto: {
        backend: "llm",
        model: "claude-haiku-3-5",
        confidence_threshold: 0.85,
        timeout_seconds: 10,
        cache_ttl_minutes: 60,
        allow_rules: ["Bash(vwsd *)"],
        denial_max_consecutive: 3,
        denial_max_total: 20,
      },
    });

    const nanoYaml = await fs.readFile(path.join(workspace, ".nano/nano.yaml"), "utf-8");
    expect(nanoYaml).toContain("permission_mode: auto");
    expect(nanoYaml).toContain("permission_auto:");
    expect(nanoYaml).toContain("backend: llm");
    expect(nanoYaml).toContain("confidence_threshold: 0.85");
    expect(nanoYaml).toContain("timeout_seconds: 10");
    expect(nanoYaml).toContain("cache_ttl_minutes: 60");
    expect(nanoYaml).toContain("allow_rules:");
    expect(nanoYaml).toContain("Bash(vwsd *)");
    expect(nanoYaml).toContain("denial_max_consecutive: 3");
    expect(nanoYaml).toContain("denial_max_total: 20");
  });

  test("omits permission_auto.model from yaml when NANO_PERMISSION_AUTO_MODEL env is set", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(binary, "#!/bin/sh\ncat > /dev/null\nexit 0", "utf-8");
    await fs.chmod(binary, 0o755);

    const originalEnv = process.env.NANO_PERMISSION_AUTO_MODEL;
    process.env.NANO_PERMISSION_AUTO_MODEL = "claude-opus-4";

    try {
      await spawnAgent({
        issueId: "issue-perm-model-env",
        attempt: 1,
        workspace,
        prompt: "test",
        token: "tok",
        mcpUrl: "http://localhost:4123/mcp",
        binary,
        timeoutMs: 5_000,
        permissionMode: "auto",
        permissionAuto: {
          backend: "llm",
          model: "claude-haiku-3-5",
          confidence_threshold: 0.8,
          timeout_seconds: 5,
          cache_ttl_minutes: 30,
          allow_rules: [],
          denial_max_consecutive: 0,
          denial_max_total: 0,
        },
      });

      const nanoYaml = await fs.readFile(path.join(workspace, ".nano/nano.yaml"), "utf-8");
      expect(nanoYaml).toContain("permission_auto:");
      expect(nanoYaml).toContain("backend: llm");
      expect(nanoYaml).not.toContain("model:");
      expect(nanoYaml).not.toContain("allow_rules:");
      expect(nanoYaml).not.toContain("denial_max_consecutive:");
      expect(nanoYaml).not.toContain("denial_max_total:");
    } finally {
      if (originalEnv !== undefined) {
        process.env.NANO_PERMISSION_AUTO_MODEL = originalEnv;
      } else {
        delete process.env.NANO_PERMISSION_AUTO_MODEL;
      }
    }
  });

  test("passes permission_auto.model via env when specified", async () => {
    const workspace = await makeTempDir();
    const binary = path.join(workspace, "fake-nano.sh");
    await fs.writeFile(
      binary,
      [
        "#!/bin/sh",
        "printf '%s' \"$NANO_PERMISSION_AUTO_MODEL\" > permission-model-env.txt",
        "cat > /dev/null",
        "exit 0",
      ].join("\n"),
      "utf-8"
    );
    await fs.chmod(binary, 0o755);

    await spawnAgent({
      issueId: "issue-perm-model",
      attempt: 1,
      workspace,
      prompt: "test",
      token: "tok",
      mcpUrl: "http://localhost:4123/mcp",
      binary,
      timeoutMs: 5_000,
      permissionMode: "auto",
      permissionAuto: {
        backend: "llm",
        model: "claude-haiku-3-5",
        confidence_threshold: 0.8,
        timeout_seconds: 5,
        cache_ttl_minutes: 30,
        allow_rules: [],
        denial_max_consecutive: 0,
        denial_max_total: 0,
      },
    });

    const modelEnv = await fs.readFile(path.join(workspace, "permission-model-env.txt"), "utf-8");
    expect(modelEnv).toBe("claude-haiku-3-5");
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
      issueId: "issue-claude",
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
      issueId: "issue-claude-err",
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
      issueId: "issue-claude-err2",
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
      issueId: "issue-claude-art",
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
});
