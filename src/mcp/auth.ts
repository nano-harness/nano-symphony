interface TokenEntry {
  issueId: string;
  attempt: number;
  expiresAt: number;
}

const tokenStore = new Map<string, TokenEntry>();
let tokenTtl = 3_600_000;

export function setTokenTtl(ms: number): void {
  tokenTtl = ms;
}

export function issueToken(issueId: string, attempt: number): string {
  const token = crypto.randomUUID();
  tokenStore.set(token, { issueId, attempt, expiresAt: Date.now() + tokenTtl });
  return token;
}

export function verifyToken(token: string): { issueId: string; attempt: number } | null {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokenStore.delete(token);
    return null;
  }
  return { issueId: entry.issueId, attempt: entry.attempt };
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
