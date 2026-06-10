/**
 * B3+B4: nano adapter unit tests.
 * Validates renderWorkspaceFiles writes .mcp.json (Claude Code compatible format)
 * and .nano/nano.yaml for permission_mode.
 * Also validates buildSpawnInvocation produces expected argv/env.
 */
import { describe, test, expect } from "bun:test";
import { nanoAdapter } from "../../src/spawner/adapters/nano.ts";
import type { SpawnContext } from "../../src/spawner/types.ts";

function makeCtx(overrides: Partial<SpawnContext> = {}): SpawnContext {
  return {
    issueUuid: "issue-1",
    attempt: 0,
    workspace: "/workspace",
    prompt: "do something",
    token: "test-token-abc",
    mcpUrl: "http://localhost:4123/mcp",
    outputDir: "/workspace/.nano-out",
    config: {},
    ...overrides,
  };
}

describe("nano adapter — renderWorkspaceFiles (B3)", () => {
  test("writes .mcp.json with http transport type", () => {
    const files = nanoAdapter.renderWorkspaceFiles(makeCtx());
    expect(files.length).toBeGreaterThanOrEqual(1);
    const mcpFile = files.find(f => f.path === ".mcp.json");
    expect(mcpFile).toBeDefined();
    expect(mcpFile!.mode).toBe(0o600);
    const parsed = JSON.parse(mcpFile!.contents);
    expect(parsed.mcpServers.symphony.type).toBe("http");
    expect(parsed.mcpServers.symphony.url).toBe("http://localhost:4123/mcp");
    expect(parsed.mcpServers.symphony.headers["X-Symphony-Token"]).toBe("test-token-abc");
  });

  test("writes .nano/nano.yaml with permission_mode auto by default", () => {
    const files = nanoAdapter.renderWorkspaceFiles(makeCtx());
    const yaml = files.find(f => f.path === ".nano/nano.yaml");
    expect(yaml).toBeDefined();
    expect(yaml!.contents).toBe("permission_mode: auto\n");
  });

  test("writes .nano/nano.yaml with custom permission_mode", () => {
    const files = nanoAdapter.renderWorkspaceFiles(makeCtx({ config: { permission_mode: "yolo" } }));
    const yaml = files.find(f => f.path === ".nano/nano.yaml");
    expect(yaml).toBeDefined();
    expect(yaml!.contents).toContain("permission_mode: yolo");
  });

  test("writes .nano/nano.yaml only when trusted_binaries configured", () => {
    const ctx = makeCtx({ config: { trusted_binaries: ["git", "npm"] } });
    const files = nanoAdapter.renderWorkspaceFiles(ctx);
    const yaml = files.find(f => f.path === ".nano/nano.yaml");
    expect(yaml).toBeDefined();
    expect(yaml!.contents).toContain("permission_mode: auto");
    expect(yaml!.contents).toContain("trusted_binaries:");
    expect(yaml!.contents).toContain("git");
    expect(yaml!.contents).toContain("npm");
  });

  test("writes .nano/nano.yaml only when hooks configured", () => {
    const ctx = makeCtx({ config: { hooks: { before_run: "echo start" } } });
    const files = nanoAdapter.renderWorkspaceFiles(ctx);
    const yaml = files.find(f => f.path === ".nano/nano.yaml");
    expect(yaml).toBeDefined();
    expect(yaml!.contents).toContain("permission_mode: auto");
    expect(yaml!.contents).toContain("hooks:");
    expect(yaml!.contents).toContain("before_run:");
    expect(yaml!.contents).toContain("echo start");
  });

  test("writes both .mcp.json and .nano/nano.yaml when hooks + trusted_binaries present", () => {
    const ctx = makeCtx({
      config: {
        trusted_binaries: ["git"],
        hooks: { before_run: "echo start" },
      },
    });
    const files = nanoAdapter.renderWorkspaceFiles(ctx);
    expect(files.find(f => f.path === ".mcp.json")).toBeDefined();
    const yaml = files.find(f => f.path === ".nano/nano.yaml");
    expect(yaml).toBeDefined();
    expect(yaml!.contents).toContain("permission_mode: auto");
    expect(yaml!.contents).toContain("trusted_binaries:");
    expect(yaml!.contents).toContain("hooks:");
  });
});

describe("nano adapter — buildSpawnInvocation (B4)", () => {
  test("argv starts with 'binary exec' and contains --stream and --mcp-config", () => {
    const { argv } = nanoAdapter.buildSpawnInvocation(makeCtx());
    expect(argv.slice(0, 2)).toEqual(["binary", "exec"]);
    expect(argv).toContain("--stream");
    const mcpIdx = argv.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(argv[mcpIdx + 1]).toBe("/workspace/.mcp.json");
  });

  test("argv contains --permission-mode from config", () => {
    const ctx = makeCtx({ config: { permission_mode: "yolo" } });
    const { argv } = nanoAdapter.buildSpawnInvocation(ctx);
    const idx = argv.indexOf("--permission-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("yolo");
  });

  test("argv contains --allowedTools mcp_symphony_* and symphony.*", () => {
    const { argv } = nanoAdapter.buildSpawnInvocation(makeCtx());
    const allowedTools: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === "--allowedTools") allowedTools.push(argv[i + 1]);
    }
    expect(allowedTools).toContain("mcp_symphony_*");
    expect(allowedTools).toContain("symphony.*");
  });

  test("extra allow rules forwarded as --allowedTools", () => {
    const ctx = makeCtx({ config: { permissions: { allow: ["Bash(git *)"] } } });
    const { argv } = nanoAdapter.buildSpawnInvocation(ctx);
    const allowedTools: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === "--allowedTools") allowedTools.push(argv[i + 1]);
    }
    expect(allowedTools).toContain("Bash(git *)");
  });

  test("deny rules forwarded as --disallowedTools", () => {
    const ctx = makeCtx({ config: { permissions: { deny: ["Bash(rm *)"] } } });
    const { argv } = nanoAdapter.buildSpawnInvocation(ctx);
    const disallowedTools: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === "--disallowedTools") disallowedTools.push(argv[i + 1]);
    }
    expect(disallowedTools).toContain("Bash(rm *)");
  });

  test("extra_writable_paths forwarded as --add-dir", () => {
    const ctx = makeCtx({ config: { sandbox: { extra_writable_paths: ["/tmp/data"] } } });
    const { argv } = nanoAdapter.buildSpawnInvocation(ctx);
    const addDirs: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === "--add-dir") addDirs.push(argv[i + 1]);
    }
    expect(addDirs).toContain("/tmp/data");
  });

  test("env contains SYMPHONY_ISSUE_UUID and SYMPHONY_WORKSPACE, no SYMPHONY_TOKEN or SYMPHONY_MCP_URL", () => {
    const { env, argv } = nanoAdapter.buildSpawnInvocation(makeCtx());
    expect(env.SYMPHONY_ISSUE_UUID).toBe("issue-1");
    expect(env.SYMPHONY_WORKSPACE).toBe("/workspace");
    expect(env.SYMPHONY_TOKEN).toBeUndefined();
    expect(env.SYMPHONY_MCP_URL).toBeUndefined();
    expect(argv).toContain("--mcp-config");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe("/workspace/.mcp.json");
  });

  test("no --timeout-ms in argv", () => {
    const { argv } = nanoAdapter.buildSpawnInvocation(makeCtx());
    expect(argv).not.toContain("--timeout-ms");
    expect(argv).not.toContainEqual(expect.stringContaining("--timeout-ms="));
  });

  test("no --disallowedTools when deny list empty", () => {
    const { argv } = nanoAdapter.buildSpawnInvocation(makeCtx());
    expect(argv).not.toContain("--disallowedTools");
  });

  test("no --add-dir when extra_writable_paths empty", () => {
    const { argv } = nanoAdapter.buildSpawnInvocation(makeCtx());
    expect(argv).not.toContain("--add-dir");
  });
});

describe("nano adapter — parseStreamingLine", () => {
  test("parses tool_use with tool_name and tool_params", () => {
    const result = nanoAdapter.parseStreamingLine!(
      JSON.stringify({ type: "tool_use", tool_name: "Bash", tool_params: { command: "echo hi" } })
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("tool_call");
    expect(result!.message).toBe("Tool: Bash");
    expect(result!.payload).toEqual({ tool: "Bash", input: { command: "echo hi" } });
  });

  test("parses tool_result with tool_name and tool_result", () => {
    const result = nanoAdapter.parseStreamingLine!(
      JSON.stringify({ type: "tool_result", tool_name: "Bash", tool_result: { stdout: "hi" } })
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("tool_result");
    expect(result!.message).toBe("Result: Bash");
    expect(result!.payload).toEqual({ tool: "Bash", result: { stdout: "hi" } });
  });

  test("parses content as assistant_chunk", () => {
    const result = nanoAdapter.parseStreamingLine!(
      JSON.stringify({ type: "content", content: "Hello world" })
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("assistant_chunk");
    expect(result!.message).toBe("Hello world");
  });

  test("parses stream_content as assistant_chunk", () => {
    const result = nanoAdapter.parseStreamingLine!(
      JSON.stringify({ type: "stream_content", content: "streaming" })
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("assistant_chunk");
    expect(result!.message).toBe("streaming");
  });

  test("parses token_stats with input/output/total", () => {
    const result = nanoAdapter.parseStreamingLine!(
      JSON.stringify({ type: "token_stats", token_stats: { input: 10, output: 20, total: 30 } })
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("token_stats");
    expect(result!.message).toBe("Tokens: in=10 out=20");
    expect(result!.payload).toEqual({ input: 10, output: 20, total: 30 });
  });

  test("returns null for empty line", () => {
    expect(nanoAdapter.parseStreamingLine!("")).toBeNull();
    expect(nanoAdapter.parseStreamingLine!("   ")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(nanoAdapter.parseStreamingLine!("not json")).toBeNull();
  });

  test("returns null for missing type field", () => {
    expect(nanoAdapter.parseStreamingLine!(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  test("returns null for unknown type", () => {
    expect(nanoAdapter.parseStreamingLine!(JSON.stringify({ type: "unknown" }))).toBeNull();
  });

  test("truncates assistant_chunk to 4096 chars", () => {
    const longContent = "a".repeat(5000);
    const result = nanoAdapter.parseStreamingLine!(
      JSON.stringify({ type: "content", content: longContent })
    );
    expect(result).toBeDefined();
    expect(result!.message).toHaveLength(4096);
  });

  test("uses last known tool_name when tool_result lacks tool_name", () => {
    // First emit a tool_use to set lastToolName
    nanoAdapter.parseStreamingLine!(
      JSON.stringify({ type: "tool_use", tool_name: "GitStatus" })
    );
    // Then emit a tool_result without tool_name
    const result = nanoAdapter.parseStreamingLine!(
      JSON.stringify({ type: "tool_result", tool_result: "clean" })
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("tool_result");
    expect(result!.payload).toEqual({ tool: "GitStatus", result: "clean" });
  });
});

describe("nano adapter — prepare", () => {
  test("prepare is defined", () => {
    expect(nanoAdapter.prepare).toBeDefined();
  });
});
