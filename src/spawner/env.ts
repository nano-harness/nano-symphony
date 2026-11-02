// Symphony service's own internal variables — must never be leaked to agent subprocesses.
const SYMPHONY_INTERNAL_KEYS = new Set([
  'API_TOKEN',           // symphony server admin API token
  'SYMPHONY_API_TOKEN',  // same (prefixed form)
]);

// Parent Claude Code session variables — must not leak to child agent processes to avoid session identity conflicts.
const CLAUDE_SESSION_KEYS = new Set([
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDECODE',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
]);

/**
 * Returns a copy of the given env stripped of symphony's own service credentials
 * and parent Claude Code session variables.
 * All other variables (ANTHROPIC_API_KEY, PATH, user dotfiles, etc.) are preserved.
 */
export function stripSymphonyInternals(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] != null && !SYMPHONY_INTERNAL_KEYS.has(entry[0]) && !CLAUDE_SESSION_KEYS.has(entry[0])
    )
  );
}
