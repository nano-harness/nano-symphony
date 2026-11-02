import type { SpawnContext } from "./types.ts";

/** Render .mcp.json — Claude Code compatible format, shared with nano's --mcp-config parser. */
export function renderMcpJson(ctx: SpawnContext): string {
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

/** Local env file used by the global symphony CLI wrapper when global env vars are
 *  intentionally hidden from the agent to prevent MCP auto-discovery. The wrapper
 *  searches upward from the current directory to find this file. */
export function renderEnvFile(ctx: SpawnContext): string {
  return [
    `SYMPHONY_ISSUE_UUID=${ctx.issueUuid}`,
    `SYMPHONY_WORKSPACE=${ctx.workspace}`,
    `SYMPHONY_MCP_URL=${ctx.mcpUrl}`,
    `SYMPHONY_TOKEN=${ctx.token}`,
    "",
  ].join("\n");
}
