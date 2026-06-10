import path from "path";
import { AgentResultSummarySchema, parseLastJsonLine } from "../agent-result-payload.ts";
import type { AgentResultSummary, AgentArtifacts } from "../agent-result-payload.ts";
import { registerAdapter, type AgentAdapter, type WorkspaceFile, type SpawnInvocation } from "../agent-adapter.ts";
import type { SpawnContext } from "../types.ts";

let lastToolName = "unknown_tool";

/** Render .mcp.json — Claude Code compatible format, shared with nano's --mcp-config parser. */
function renderMcpJson(ctx: SpawnContext): string {
  return JSON.stringify({
    mcpServers: {
      symphony: {
        type: "http",
        url: ctx.mcpUrl,
        headers: {
          "X-Symphony-Token": ctx.token,
        },
      },
    },
  }, null, 2);
}

/** Minimal YAML for nano-specific config (hooks, trusted_binaries, permission_mode) written to .nano/nano.yaml. */
function renderNanoYaml(ctx: SpawnContext): string {
  const lines: string[] = [];
  lines.push(`permission_mode: ${ctx.config.permission_mode ?? "auto"}`);
  if (ctx.config.trusted_binaries?.length) {
    lines.push("trusted_binaries:");
    for (const b of ctx.config.trusted_binaries) {
      lines.push(`  - ${b}`);
    }
  }
  if (ctx.config.hooks && Object.keys(ctx.config.hooks).length > 0) {
    lines.push("hooks:");
    for (const [k, v] of Object.entries(ctx.config.hooks)) {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  return lines.join("\n") + "\n";
}

export const nanoAdapter: AgentAdapter = {
  kind: "nano",

  async prepare(): Promise<void> {
    // Verify nano binary is available
    const ok = await Bun.spawn(["nano", "--version"], { stdout: "ignore", stderr: "ignore" }).exited;
    if (ok !== 0) {
      console.warn("[nano-adapter] nano binary not found or not executable");
    }
  },

  renderWorkspaceFiles(ctx: SpawnContext): WorkspaceFile[] {
    return [
      { path: ".mcp.json", contents: renderMcpJson(ctx), mode: 0o600 },
      { path: ".nano/nano.yaml", contents: renderNanoYaml(ctx), mode: 0o644 },
    ];
  },

  buildSpawnInvocation(ctx: SpawnContext): SpawnInvocation {
    const argv = [
      "binary", "exec",
      "--output-dir", ctx.outputDir,
      "--stream",
      "--mcp-config", path.join(ctx.workspace, ".mcp.json"),
      "--permission-mode", ctx.config.permission_mode ?? "auto",
      "--allowedTools", "mcp_symphony_*",
      "--allowedTools", "symphony.*",
      ...(ctx.config.permissions?.allow ?? []).flatMap(r => ["--allowedTools", r]),
      ...(ctx.config.permissions?.deny ?? []).flatMap(r => ["--disallowedTools", r]),
      ...(ctx.config.sandbox?.extra_writable_paths ?? []).flatMap(p => ["--add-dir", p]),
    ];

    return {
      argv,
      env: {
        SYMPHONY_ISSUE_UUID: ctx.issueUuid,
        SYMPHONY_WORKSPACE: ctx.workspace,
      },
    };
  },

  parseResult(stdout: string): AgentResultSummary | null {
    // First try the standard last-JSON-line parser
    const result = parseLastJsonLine(stdout, AgentResultSummarySchema);
    if (result) return result;

    // Fallback: try to find a "done" event from --stream mode NDJSON output
    const lines = stdout.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "done") {
          if (parsed.result) {
            const check = AgentResultSummarySchema.safeParse(parsed.result);
            if (check.success) return check.data;
          }
          // nano v0.8.3 outputs {"type":"done"} without a result field on
          // successful completion. Treat it as success so the worker can
          // cross-validate with the exit code.
          return { status: "success", reason: "agent completed" };
        }
      } catch { continue; }
    }
    return null;
  },

  collectArtifacts: async (_ctx: SpawnContext): Promise<AgentArtifacts> => {
    // nano-agent no longer writes solution.patch; artifacts are collected via
    // git diff in the orchestrator (collectAllArtifacts) instead.
    return {};
  },

  parseStreamingLine(line: string): { kind: string; message: string; payload?: Record<string, unknown> } | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const type = obj.type as string | undefined;
      if (!type) return null;

      // tool_use → tool_call (MCP tool invocation)
      if (type === "tool_use") {
        const name = (obj.tool_name as string) ?? "unknown_tool";
        lastToolName = name;
        return {
          kind: "tool_call",
          message: `Tool: ${name}`,
          payload: { tool: name, input: obj.tool_params },
        };
      }

      // content / stream_content → assistant_chunk
      if ((type === "content" || type === "stream_content") && obj.content) {
        const text = String(obj.content).slice(0, 4096);
        if (text) {
          return { kind: "assistant_chunk", message: text };
        }
      }

      // tool_result → tool_result
      if (type === "tool_result") {
        const name = (obj.tool_name as string) ?? lastToolName;
        lastToolName = "unknown_tool";
        return {
          kind: "tool_result",
          message: `Result: ${name}`,
          payload: { tool: name, result: obj.tool_result },
        };
      }

      // token_stats → per-turn token usage
      if (type === "token_stats" && obj.token_stats) {
        const ts = obj.token_stats as Record<string, unknown>;
        return {
          kind: "token_stats",
          message: `Tokens: in=${ts.input ?? 0} out=${ts.output ?? 0}`,
          payload: { input: Number(ts.input ?? 0), output: Number(ts.output ?? 0), total: Number(ts.total ?? 0) },
        };
      }

      return null;
    } catch {
      return null;
    }
  },
};

registerAdapter(nanoAdapter);
