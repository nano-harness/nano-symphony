import { z } from "zod";
import path from "path";
import os from "os";
import { AgentResultSummarySchema, parseLastJsonLine } from "../agent-result-payload.ts";
import type { AgentResultSummary, AgentArtifacts } from "../agent-result-payload.ts";
import { registerAdapter, type AgentAdapter, type WorkspaceFile, type SpawnInvocation } from "../agent-adapter.ts";
import type { SpawnContext } from "../types.ts";

// Design decisions (per plan §4.3):
// - Envelope: validated with zod schema (detects claude output format changes early).
// - System prompt: delivered via stdin (`claude -p`), not --append-system-prompt-file
//   (stdin is the documented prompt channel; the file flag is for project-level context).

const EnvelopeSchema = z.object({
  type: z.string(),
  is_error: z.boolean().optional(),
  result: z.string(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  }).passthrough().optional(),
  cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  num_turns: z.number().optional(),
}).passthrough();

const MAX_ASSISTANT_CHUNK_LENGTH = 4096;

const SYSTEM_PROMPT_SUFFIX = `
When you have completed the task, output your final result as a SINGLE LINE of valid JSON with this exact schema:
{"status":"success"|"needs_retry"|"abandoned"|"timeout","reason":"<brief explanation>","goal_state":{"last_reason":"<reason>","iterations":<n>},"tokens":{"input":<n>,"output":<n>,"cached":<n>}}

Only include fields you have values for. The JSON must be on one line with no surrounding text.
`;

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

// Mirrors nano-agent SBPL's hard-deny list — keep both sides in sync.
const CRITICAL_HOME_PATHS = [
  ".ssh", ".aws", ".gnupg", ".kube",
  ".config/gh", ".docker/config.json",
];

function renderClaudeSettings(ctx: SpawnContext): string {
  const sb = ctx.sandboxConfig;
  if (!sb || sb.backend === "none") {
    return JSON.stringify({ sandbox: { enabled: false } }, null, 2);
  }
  const home = os.homedir();
  const criticalAbs = CRITICAL_HOME_PATHS.map((p) => path.join(home, p));
  // network_access: false → empty allowedDomains disables network.
  // true → omit so claude-code's host default applies.
  const networkBlock = sb.network_access
    ? undefined
    : { allowedDomains: [] as string[] };
  return JSON.stringify({
    sandbox: {
      enabled: true,
      ...(networkBlock ? { network: networkBlock } : {}),
      filesystem: {
        allowWrite: [...(sb.extra_writable_paths ?? [])],
        denyWrite: [...criticalAbs, ...(sb.extra_denied_paths ?? [])],
        denyRead: [...criticalAbs, ...(sb.extra_denied_paths ?? [])],
        allowRead: sb.extra_read_only_paths ?? [],
      },
    },
  }, null, 2);
}

function renderSystemPromptAppend(): string {
  return SYSTEM_PROMPT_SUFFIX.trim() + "\n";
}

export const claudeCodeAdapter: AgentAdapter = {
  kind: "claude-code",

  renderWorkspaceFiles(ctx: SpawnContext): WorkspaceFile[] {
    return [
      {
        path: ".mcp.json",
        contents: renderMcpJson(ctx),
        mode: 0o644,
      },
      {
        path: ".claude/append-system-prompt.md",
        contents: renderSystemPromptAppend(),
        mode: 0o644,
      },
      {
        path: ".claude/settings.local.json",
        contents: renderClaudeSettings(ctx),
        mode: 0o644,
      },
    ];
  },

  buildSpawnInvocation(ctx: SpawnContext): SpawnInvocation {
    const binary = ctx.binary ?? "claude";
    const argv = [
      binary, "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--append-system-prompt-file", path.join(ctx.workspace, ".claude", "append-system-prompt.md"),
      "--mcp-config", path.join(ctx.workspace, ".mcp.json"),
      "--allowedTools", "mcp__symphony__*",
      "--permission-mode", (!ctx.sandboxConfig || ctx.sandboxConfig.backend === "none") ? "auto" : "acceptEdits",
    ];
    const env: Record<string, string> = {
      SYMPHONY_TOKEN: ctx.token,
      SYMPHONY_ISSUE_ID: ctx.issueId,
      SYMPHONY_WORKSPACE: ctx.workspace,
      SYMPHONY_MCP_URL: ctx.mcpUrl,
    };
    return { argv, env };
  },

  parseResult(stdout: string): AgentResultSummary | null {
    const trimmed = stdout.trim();
    if (!trimmed) return null;

    const lines = trimmed.split("\n");
    let envelope: z.infer<typeof EnvelopeSchema> | null = null;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        const check = EnvelopeSchema.safeParse(parsed);
        if (check.success && (check.data.type === "result" || check.data.type === "error")) {
          envelope = check.data;
          break;
        }
      } catch { continue; }
    }

    if (!envelope) return null;

    let result = parseLastJsonLine(envelope.result, AgentResultSummarySchema);

    if (!result) {
      result = {
        status: envelope.is_error ? "abandoned" : "needs_retry",
        reason: envelope.result.slice(0, 200),
      };
    }

    // Envelope-level usage is authoritative (from Claude Code runtime, not model self-report).
    const envelopeUsage = envelope.usage;
    if (envelopeUsage && (envelopeUsage.input_tokens || envelopeUsage.output_tokens)) {
      const tokens = {
        input: envelopeUsage.input_tokens ?? 0,
        output: envelopeUsage.output_tokens ?? 0,
        cached: (envelopeUsage.cache_read_input_tokens ?? 0) + (envelopeUsage.cache_creation_input_tokens ?? 0),
      };

      result = { ...result, tokens };
    }

    if (result && (envelope.cost_usd != null || envelope.num_turns != null)) {
      (result as Record<string, unknown>).cost_usd = envelope.cost_usd;
      (result as Record<string, unknown>).num_turns = envelope.num_turns;
      (result as Record<string, unknown>).duration_api_ms = envelope.duration_api_ms;
    }
    return result;
  },

  async collectArtifacts(_ctx: SpawnContext): Promise<AgentArtifacts> {
    // Claude Code doesn't produce a patch artifact yet.
    return {};
  },

  parseStreamingLine(line: string): { kind: string; message: string; payload?: Record<string, unknown> } | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const type = obj.type as string | undefined;
      if (!type) return null;

      // Emit events for tool use (MCP calls)
      if (type === "tool_use") {
        const name = (obj.name as string) ?? "unknown_tool";
        return {
          kind: "tool_call",
          message: `Tool: ${name}`,
          payload: { tool: name, input: obj.input },
        };
      }

      // Emit events for assistant text chunks
      if (type === "assistant" && obj.message) {
        const msg = obj.message as Record<string, unknown>;
        const content = msg.content;
        if (Array.isArray(content) && content.length > 0) {
          const text = content.map((c: Record<string, unknown>) => c.text ?? "").join("").slice(0, MAX_ASSISTANT_CHUNK_LENGTH);
          if (text) {
            return { kind: "assistant_chunk", message: text };
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  },
};

registerAdapter(claudeCodeAdapter);
