import path from "path";
import fs from "fs/promises";
import { config } from "../config.ts";

export function sanitizeIdentifier(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}

export function assertContained(root: string, target: string): void {
  const realRoot = path.resolve(root);
  const realTarget = path.resolve(target);
  if (!realTarget.startsWith(realRoot + path.sep) && realTarget !== realRoot) {
    throw new Error(`Path traversal detected: ${target} is not inside ${root}`);
  }
}

export async function ensureWorkspace(identifier: string): Promise<string> {
  const safe = sanitizeIdentifier(identifier);
  const wsPath = path.resolve(config.WORKSPACE_ROOT, safe);
  assertContained(config.WORKSPACE_ROOT, wsPath);
  await fs.mkdir(wsPath, { recursive: true });

  // Copy skills directory once per workspace (idempotent with marker file)
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

  return wsPath;
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

export async function cleanupWorkspace(wsPath: string): Promise<void> {
  assertContained(config.WORKSPACE_ROOT, wsPath);
  await fs.rm(wsPath, { recursive: true, force: true });
}
