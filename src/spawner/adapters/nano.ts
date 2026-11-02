import path from "path";
import { AgentResultSummarySchema, parseLastJsonLine } from "../agent-result-payload.ts";
import type { AgentResultSummary, AgentArtifacts } from "../agent-result-payload.ts";
import { registerAdapter, type AgentAdapter, type WorkspaceFile, type SpawnInvocation, isMcpTransport } from "../agent-adapter.ts";
import { renderEnvFile, renderMcpJson } from "../cli-files.ts";
import type { SpawnContext } from "../types.ts";

let lastToolName = "unknown_tool";

function renderNanoYaml(ctx: SpawnContext): string {
  const lines: string[] = [];
  const mode = ctx.config.permission_mode ?? "auto";

  lines.push("permission_mode: " + mode);

  // Headless binary exec needs an explicit daemon confirm_policy or tools that
  // require confirmation (including the first run_shell_command) are blocked
  // fail-closed. This mirrors --dangerously-skip-permissions for non-interactive runs.
  lines.push("daemon:");
  lines.push("  confirm_policy: allow");

  lines.push("sandbox:");
  lines.push("  backend: native");
  if (ctx.config.sandbox?.network_access) {
    lines.push("  network_access: true");
  } else {
    lines.push("  network_access: false");
  }

  // In ModeAuto the permission manager only fast-paths a small hardcoded list
  // of safe MCP tools. The injected symphony MCP server (emit_result,
  // session_completed, etc.) is not on that list, so headless runs would
  // reach the confirmation stage and fail-closed. Add an explicit session
  // allowlist for the trusted symphony MCP namespace only when MCP is enabled.
  if (mode === "auto" && isMcpTransport(ctx.config)) {
    lines.push("permission_auto:");
    lines.push("  allow_rules:");
    lines.push("    - mcp_symphony_*");
  }

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
    // Verify nano binary is available, with a timeout so a hung process does not
    // block symphony startup.
    const proc = Bun.spawn(["nano", "--version"], { stdout: "ignore", stderr: "ignore" });
    const timeout = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    try {
      const ok = await proc.exited;
      if (ok !== 0) {
        console.warn("[nano-adapter] nano binary not found or not executable");
      }
    } catch {
      console.warn("[nano-adapter] nano --version check failed");
    } finally {
      clearTimeout(timeout);
    }
  },

  renderWorkspaceFiles(ctx: SpawnContext): WorkspaceFile[] {
    const files: WorkspaceFile[] = [
      { path: ".nano/nano.yaml", contents: renderNanoYaml(ctx), mode: 0o644 },
    ];
    if (isMcpTransport(ctx.config)) {
      files.push({ path: ".mcp.json", contents: renderMcpJson(ctx), mode: 0o600 });
    } else {
      // CLI mode: hide MCP credentials from the agent process by writing them to
      // .symphony/env. The global `symphony` wrapper searches upward from $PWD
      // to load this file; no workspace-local wrapper binary is needed.
      files.push({ path: ".symphony/env", contents: renderEnvFile(ctx), mode: 0o600 });
    }
    return files;
  },

  buildSpawnInvocation(ctx: SpawnContext): SpawnInvocation {
    const configPath = path.join(ctx.workspace, ".nano", "nano.yaml");
    const argv = [
      "binary", "exec",
      "--config", configPath,
      "--output-dir", ctx.outputDir,
      "--stream",
      ...(isMcpTransport(ctx.config) ? ["--mcp-config", path.join(ctx.workspace, ".mcp.json")] : []),
      "--permission-mode", ctx.config.permission_mode ?? "auto",
      ...(isMcpTransport(ctx.config) ? ["--allowedTools", "mcp_symphony_*"] : ["--disallowedTools", "mcp_symphony_*"]),
      ...(ctx.config.permissions?.allow ?? []).flatMap(r => ["--allowedTools", r]),
      ...(ctx.config.permissions?.deny ?? []).flatMap(r => ["--disallowedTools", r]),
      ...(ctx.config.sandbox?.extra_writable_paths ?? []).flatMap(p => ["--add-dir", p]),
    ];

    return {
      argv,
      env: {
        SYMPHONY_ISSUE_UUID: ctx.issueUuid,
        SYMPHONY_WORKSPACE: ctx.workspace,
        // CLI mode: hide the MCP endpoint credentials from the agent process so
        // nano cannot auto-discover the symphony MCP server. The `symphony`
        // wrapper reads them from .symphony/env instead.
        ...(isMcpTransport(ctx.config) ? {} : { SYMPHONY_MCP_URL: "", SYMPHONY_TOKEN: "" }),
        SYMPHONY_TRANSPORT: ctx.config.transport ?? "cli",
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
