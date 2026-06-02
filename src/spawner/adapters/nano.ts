import path from "path";
import { readFile } from "node:fs/promises";
import { AgentResultSummarySchema, parseLastJsonLine } from "../agent-result-payload.ts";
import type { AgentResultSummary, AgentArtifacts } from "../agent-result-payload.ts";
import { registerAdapter, type AgentAdapter, type WorkspaceFile, type SpawnInvocation } from "../agent-adapter.ts";
import type { SpawnContext } from "../types.ts";

export const nanoAdapter: AgentAdapter = {
  kind: "nano",

  renderWorkspaceFiles(_ctx: SpawnContext): WorkspaceFile[] {
    return [];
  },

  buildSpawnInvocation(ctx: SpawnContext): SpawnInvocation {
    const argv = [
      ctx.binary, "binary", "exec",
      "--output-dir", ctx.outputDir,
      // Required for headless/binary mode: without an explicit permission-mode,
      // nano-agent defaults to fail-closed. "auto" lets the agent's built-in LLM
      // classifier decide whether to approve each operation.
      "--permission-mode", "auto",
    ];

    if (ctx.timeoutMs) {
      argv.push(`--timeout-ms=${ctx.timeoutMs}`);
    }

    return {
      argv,
      env: {
        // The spawner applies stripSymphonyInternals as the base; adapter only adds MCP-specific vars.
        SYMPHONY_MCP_URL: ctx.mcpUrl,
        SYMPHONY_TOKEN: ctx.token,
      },
    };
  },

  parseResult(stdout: string): AgentResultSummary | null {
    return parseLastJsonLine(stdout, AgentResultSummarySchema);
  },

  async collectArtifacts(ctx: SpawnContext): Promise<AgentArtifacts> {
    try {
      const patch = await readFile(path.join(ctx.outputDir, "solution.patch"), "utf8");
      return { patch };
    } catch {
      return {};
    }
  },
};

registerAdapter(nanoAdapter);
