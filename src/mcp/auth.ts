interface TokenEntry {
  issueId: string;
  attempt: number;
  expiresAt: number;
  // S6: Scoped tools — the set of MCP tool names this token is permitted to call.
  // An empty set means "no tools allowed"; undefined means "legacy / all tools" (avoid).
  scope: ReadonlySet<string>;
}

const tokenStore = new Map<string, TokenEntry>();
let tokenTtl = 3_600_000;

export function setTokenTtl(ms: number): void {
  tokenTtl = ms;
}

// S6: Standard scope issued to agent tokens.
export const AGENT_TOOL_SCOPE = new Set([
  "symphony.session_completed",
  "symphony.report_event",
  "symphony.report_goal_state",
  "symphony.request_workflow_section",
  "symphony.suggest_state_transition",
  "symphony.fetch_issue",
  "symphony.create_issue",
  "symphony.activate_issue",
  "symphony.submit_plan",
]);

// S7: Accept optional ttlMs so worker can extend coverage beyond config default.
export function issueToken(
  issueId: string,
  attempt: number,
  scope: ReadonlySet<string> = AGENT_TOOL_SCOPE,
  ttlMs?: number,
): string {
  const token = crypto.randomUUID();
  tokenStore.set(token, {
    issueId,
    attempt,
    expiresAt: Date.now() + (ttlMs ?? tokenTtl),
    scope,
  });
  return token;
}

export function verifyToken(
  token: string,
): { issueId: string; attempt: number; scope: ReadonlySet<string> } | null {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokenStore.delete(token);
    return null;
  }
  return { issueId: entry.issueId, attempt: entry.attempt, scope: entry.scope };
}

export function revokeToken(token: string): void {
  tokenStore.delete(token);
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenStore) {
    if (now > entry.expiresAt) tokenStore.delete(token);
  }
}, 60_000).unref();
