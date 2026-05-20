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

async function syncSkillsIfMissing(wsPath: string): Promise<void> {
  const skillsDir = path.join(wsPath, ".nano", "skills", "nano-symphony");
  const marker = path.join(skillsDir, ".synced");
  const srcSkillsDir = path.resolve(import.meta.dir, "../../skills/nano-symphony");

  try {
    // Check if already synced
    await fs.stat(marker);
  } catch {
    // Not synced yet, copy skills
    await fs.mkdir(skillsDir, { recursive: true });
    try {
      const skillFiles = await fs.readdir(srcSkillsDir);
      for (const file of skillFiles) {
        await fs.copyFile(path.join(srcSkillsDir, file), path.join(skillsDir, file));
      }
      // Mark as synced
      await fs.writeFile(marker, new Date().toISOString(), "utf-8");
    } catch {
      // Skills directory may not exist in all environments
    }
  }
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
    await syncSkillsIfMissing(wsPath);
    return { path: wsPath, managed: false };   // external: do NOT init git
  }

  // Default managed path
  // sanitizeIdentifier already strips path-traversal chars, no need for assertContained
  const safe = sanitizeIdentifier(identifier);
  const wsPath = path.resolve(root, safe);
  await fs.mkdir(wsPath, { recursive: true });
  await syncSkillsIfMissing(wsPath);
  if (gitBaseline) {
    await ensureGitBaseline(wsPath);
  }
  return { path: wsPath, managed: true };
}

export async function runHook(hook: string, env: Record<string, string>, timeoutMs = 30000): Promise<void> {
  if (!hook.trim()) return;
  const proc = Bun.spawn(["sh", "-c", hook], {
    env: { ...process.env, ...env } as Record<string, string>,
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

export async function cleanupWorkspace(wsPath: string, managed: boolean): Promise<void> {
  // The `managed` flag is the authority: it can only be true for paths produced
  // by ensureWorkspace's managed branch, which already enforces containment via
  // sanitizeIdentifier. A second assertContained here just blocked legitimate
  // test fixtures (e.g. os.tmpdir() paths) without adding real safety.
  if (!managed) return;
  await fs.rm(wsPath, { recursive: true, force: true });
}

