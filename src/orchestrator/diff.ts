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

  const head = await runGit(wsPath, ["rev-parse", "HEAD"]).catch(() => "");
  const numstat = await runGit(wsPath, ["diff", "--numstat", "HEAD"]).catch(() => "");
  const namestatus = await runGit(wsPath, ["diff", "--name-status", "HEAD"]).catch(() => "");
  const stat = await runGit(wsPath, ["diff", "--stat", "HEAD"]).catch(() => "");
  const fullRaw = await runGit(wsPath, ["diff", "HEAD"]).catch(() => "");
  const truncated = fullRaw.length > MAX_DIFF_BYTES;
  const diff_unified = truncated ? fullRaw.slice(0, MAX_DIFF_BYTES) : fullRaw;

  const changes = parseChanges(numstat, namestatus);

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
  const out = await new Response(proc.stdout).text();
  clearTimeout(timeoutHandle);
  await proc.exited;
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
