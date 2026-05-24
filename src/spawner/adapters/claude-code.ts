import { z } from "zod";
import path from "path";
import os from "os";
import { AgentResultSummarySchema } from "../agent-result-payload.ts";
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
});

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
    const argv = [binary, "-p", "--output-format", "json"];
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

    // Claude Code with --output-format json emits an envelope:
    // { type, subtype, is_error, session_id, result, ... }
    // where .result is the final assistant message text.
    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { return null; }

    const envelope = EnvelopeSchema.safeParse(raw);
    if (!envelope.success) return null;

    // If is_error is set, result may still contain structured output — try parsing.
    const resultText = envelope.data.result;

    // The system prompt instructs the model to make .result a JSON line
    // of AgentResultSummary.
    const innerTrimmed = resultText.trim();
    // Try parsing the entire result text first; if that fails, try last line.
    let json: unknown;
    try { json = JSON.parse(innerTrimmed); } catch {
      const lastLine = innerTrimmed.split("\n").pop()!.trim();
      try { json = JSON.parse(lastLine); } catch { return null; }
    }

    const parsed = AgentResultSummarySchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  },

  async collectArtifacts(_ctx: SpawnContext): Promise<AgentArtifacts> {
    // Claude Code doesn't produce a patch artifact yet.
    return {};
  },
};

registerAdapter(claudeCodeAdapter);
