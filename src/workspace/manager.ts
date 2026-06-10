import path from "path";
import fs from "fs/promises";
import os from "os";
import { spawn } from "bun";
import { config } from "../config.ts";

export function sanitizeIdentifier(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}

const GIT_INIT_TIMEOUT_MS = 3000;

async function isGitRepo(wsPath: string): Promise<boolean> {
  return fs.stat(path.join(wsPath, ".git")).then(() => true).catch(() => false);
}

async function ensureGitBaseline(wsPath: string): Promise<void> {
  if (await isGitRepo(wsPath)) return;
  // Configure committer locally so `git commit` doesn't depend on global user config.
  const steps: string[][] = [
    ["init", "-q"],
    ["config", "user.email", "symphony@local"],
    ["config", "user.name", "nano-symphony"],
    ["add", "-A"],
    ["commit", "-q", "-m", "symphony baseline", "--allow-empty"],
  ];
  for (const args of steps) {
    const proc = spawn(["git", "-C", wsPath, ...args], { stdout: "pipe", stderr: "pipe" });
    const t = setTimeout(() => proc.kill(), GIT_INIT_TIMEOUT_MS);
    const exitCode = await proc.exited;
    clearTimeout(t);
    if (exitCode !== 0) {
      // Best-effort. collectWorkspaceDiff will simply report "(no git)" as before
      // (no regression vs current behavior). Log and move on; do not throw.
      const stderr = await new Response(proc.stderr).text().catch(() => "");
      console.warn(`[workspace] git baseline failed at '${args[0]}': exit ${exitCode}: ${stderr.trim()}`);
      return;
    }
  }
}

export function assertContained(root: string, target: string): void {
  const realRoot = path.resolve(root);
  const realTarget = path.resolve(target);
  if (!realTarget.startsWith(realRoot + path.sep) && realTarget !== realRoot) {
    throw new Error(`Path traversal detected: ${target} is not inside ${root}`);
  }
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface EnsureResult {
  path: string;
  managed: boolean;
}

export async function ensureWorkspace(
  identifier: string,
  overridePath?: string | null,
  rootOverride?: string,
  gitBaseline: boolean = true,
): Promise<EnsureResult> {
  const root = rootOverride?.trim() || config.WORKSPACE_ROOT;
  const override = overridePath?.trim();
  if (override) {
    // User-provided path
    const expanded = expandHome(override);
    const wsPath = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(root, expanded);
    // Create if missing (mkdir -p fallback for user convenience)
    await fs.mkdir(wsPath, { recursive: true });
    return { path: wsPath, managed: false };   // external: do NOT init git
  }

  // Default managed path
  // sanitizeIdentifier already strips path-traversal chars, no need for assertContained
  const safe = sanitizeIdentifier(identifier);
  const wsPath = path.resolve(root, safe);
  await fs.mkdir(wsPath, { recursive: true });
  if (gitBaseline) {
    await ensureGitBaseline(wsPath);
  }
  return { path: wsPath, managed: true };
}

// S1: Minimal env allowlist for hook execution — mirrors spawner's ENV_ALLOWLIST.
// Never forward symphony's full process.env (which may contain API keys, tokens, etc.)
// into hook subprocesses. Callers pass in the explicit vars they need via `env`.
const HOOK_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM",
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_COLLATE", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
  "TMPDIR", "TEMP", "TMP",
  "TZ",
];

export async function runHook(hook: string, env: Record<string, string>, timeoutMs = 30000): Promise<void> {
  if (!hook.trim()) return;
  const parentEnv = Object.fromEntries(
    HOOK_ENV_ALLOWLIST.flatMap((key) => {
      const val = process.env[key];
      return val != null ? [[key, val]] : [];
    })
  );
  const proc = Bun.spawn(["sh", "-c", hook], {
    env: { ...parentEnv, ...env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timeout);
  if (exitCode !== 0) {
    throw new Error(`Hook failed with exit code ${exitCode}`);
  }
}

export async function removeWorkspace(
  wsPath: string,
  managed: boolean,
  hooks?: { before_remove?: string },
  hookEnv?: Record<string, string>,
): Promise<{ removed: boolean; reason?: string }> {
  // Unmanaged workspaces (user-provided paths) are never deleted by symphony
  if (!managed) {
    return { removed: false, reason: "unmanaged workspace, skipped" };
  }

  // Path safety check — prevent traversal outside WORKSPACE_ROOT
  try {
    assertContained(config.WORKSPACE_ROOT, wsPath);
  } catch {
    return { removed: false, reason: "path outside workspace root" };
  }

  // Check directory exists before attempting removal
  try {
    await fs.stat(wsPath);
  } catch {
    return { removed: false, reason: "not found" };
  }

  // Trigger before_remove hook if configured
  if (hooks?.before_remove) {
    try {
      await runHook(hooks.before_remove, hookEnv ?? {});
    } catch (err) {
      console.warn(`[workspace] before_remove hook failed: ${err}`);
    }
  }

  try {
    await fs.rm(wsPath, { recursive: true, force: true });
  } catch (err) {
    return { removed: false, reason: `deletion failed: ${err}` };
  }
  return { removed: true };
}
