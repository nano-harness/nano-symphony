import { spawn } from "bun";
import path from "path";
import fs from "fs/promises";

export interface WorkspaceDiff {
  base_ref: string;
  stat: string;
  changes: Array<{ path: string; status: "A" | "M" | "D" | "R"; additions: number; deletions: number }>;
  diff_unified: string;
  diff_truncated: boolean;
}

const MAX_DIFF_BYTES = 200 * 1024;
const GIT_TIMEOUT_MS = 5000;
const EXCLUDE_PATTERNS = [
  "logs/",
  ".nano.yaml",
  ".nano.yaml.bak",
  ".nano-agent/",
  ".claude/",
  ".mcp.json",
  ".nano/",
  ".nano-out/",
  "artifacts/",
];

export async function collectWorkspaceDiff(wsPath: string): Promise<WorkspaceDiff> {
  const isGit = await fs.stat(path.join(wsPath, ".git")).then(() => true).catch(() => false);
  if (!isGit) {
    return {
      base_ref: "(no git)",
      stat: "",
      changes: [],
      diff_unified: "",
      diff_truncated: false,
    };
  }

  const pathspecs = EXCLUDE_PATTERNS.map(p => `:!${p}`);
  const head = await runGit(wsPath, ["rev-parse", "HEAD"]).catch(() => "");
  const numstat = await runGit(wsPath, ["diff", "--numstat", "HEAD", "--", ...pathspecs]).catch(() => "");
  const namestatus = await runGit(wsPath, ["diff", "--name-status", "HEAD", "--", ...pathspecs]).catch(() => "");
  const stat = await runGit(wsPath, ["diff", "--stat", "HEAD", "--", ...pathspecs]).catch(() => "");
  const fullRaw = await runGit(wsPath, ["diff", "HEAD", "--", ...pathspecs]).catch(() => "");
  const truncated = fullRaw.length > MAX_DIFF_BYTES;
  const diff_unified = truncated ? fullRaw.slice(0, MAX_DIFF_BYTES) : fullRaw;

  const changes = parseChanges(numstat, namestatus);

  // Detect untracked files (created by the agent but not yet `git add`-ed)
  const untrackedRaw = await runGit(wsPath, ["ls-files", "--others", "--exclude-standard"]).catch(() => "");
  const trackedPaths = new Set(changes.map(c => c.path));
  for (const filePath of untrackedRaw.trim().split("\n").filter(Boolean)) {
    if (EXCLUDE_PATTERNS.some(p => filePath === p || filePath.startsWith(p))) continue;
    if (trackedPaths.has(filePath)) continue;
    changes.push({ path: filePath, status: "A", additions: 0, deletions: 0 });
  }

  return {
    base_ref: head.trim() || "HEAD",
    stat,
    changes,
    diff_unified,
    diff_truncated: truncated,
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const timeoutHandle = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  // Read both stdout and stderr concurrently to prevent pipe-buffer deadlocks,
  // then check the exit code.
  const [out, errOut] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timeoutHandle);
  // A5: Check the exit code so callers get an observable error on git failure
  // (e.g. timeout, non-existent ref, corrupt repo) rather than silently returning
  // partial or empty output that the caller would misread as "no changes".
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args[0]} exited ${code}: ${errOut.slice(0, 200)}`);
  }
  return out;
}

function parseChanges(
  numstat: string,
  namestatus: string
): Array<{ path: string; status: "A" | "M" | "D" | "R"; additions: number; deletions: number }> {
  const numstatLines = numstat.trim().split("\n").filter(Boolean);
  const namestatusLines = namestatus.trim().split("\n").filter(Boolean);

  const pathToStats = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstatLines) {
    const [addStr, delStr, ...pathParts] = line.split(/\s+/);
    const filePath = pathParts.join(" ");
    const additions = addStr === "-" ? 0 : Number.parseInt(addStr, 10);
    const deletions = delStr === "-" ? 0 : Number.parseInt(delStr, 10);
    pathToStats.set(filePath, { additions, deletions });
  }

  const changes: Array<{ path: string; status: "A" | "M" | "D" | "R"; additions: number; deletions: number }> = [];
  for (const line of namestatusLines) {
    const [status, ...pathParts] = line.split(/\s+/);
    const filePath = pathParts.join(" ");
    const stats = pathToStats.get(filePath) || { additions: 0, deletions: 0 };
    if (status === "A" || status === "M" || status === "D" || status === "R") {
      changes.push({ path: filePath, status, ...stats });
    }
  }

  return changes;
}
