// Symphony service's own internal variables — must never be leaked to agent subprocesses.
const SYMPHONY_INTERNAL_KEYS = new Set([
  'API_TOKEN',           // symphony server admin API token
  'SYMPHONY_API_TOKEN',  // same (prefixed form)
  'DATABASE_URL',        // DB connection string
  'SYMPHONY_DB_PATH',    // SQLite path
  'JWT_SECRET',          // JWT signing secret
]);

/**
 * Returns a copy of the given env stripped of symphony's own service credentials.
 * All other variables (ANTHROPIC_API_KEY, PATH, user dotfiles, etc.) are preserved.
 */
export function stripSymphonyInternals(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] != null && !SYMPHONY_INTERNAL_KEYS.has(entry[0])
    )
  );
}
