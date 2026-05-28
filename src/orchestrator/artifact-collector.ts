import type { Tracker } from "../db/tracker.ts";
import type { ArtifactInput } from "../db/tracker-artifacts.ts";
import { collectWorkspaceDiff } from "./diff.ts";
import fs from "fs/promises";
import path from "path";

const INLINE_THRESHOLD = 64 * 1024; // 64KB

export interface CollectContext {
  issueId: string;
  attempt: number;
  workspacePath: string;
  tracker: Tracker;
}

async function persistGitDiff(ctx: CollectContext, diff: { base_ref: string; stat: string; changes: unknown[]; diff_unified: string; diff_truncated: boolean }): Promise<void> {
  const diffBytes = Buffer.byteLength(diff.diff_unified, "utf-8");
  const metadata = {
    base_ref: diff.base_ref,
    changes: diff.changes,
    stat: diff.stat,
    diff_truncated: diff.diff_truncated,
  };

  if (diffBytes > INLINE_THRESHOLD) {
    // Write to disk
    const artifactsDir = path.join(ctx.workspacePath, "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });
    const filename = `attempt-${ctx.attempt}.patch`;
    const storagePath = path.join(artifactsDir, filename);
    await fs.writeFile(storagePath, diff.diff_unified, "utf-8");

    ctx.tracker.insertArtifact({
      issue_id: ctx.issueId,
      attempt: ctx.attempt,
      source: "git_diff",
      kind: "file_diff",
      label: `Git diff (attempt ${ctx.attempt})`,
      content_size: diffBytes,
      storage_path: storagePath,
      metadata,
      mime_type: "text/x-patch",
    });
  } else {
    ctx.tracker.insertArtifact({
      issue_id: ctx.issueId,
      attempt: ctx.attempt,
      source: "git_diff",
      kind: "file_diff",
      label: `Git diff (attempt ${ctx.attempt})`,
      content: diff.diff_unified,
      metadata,
      mime_type: "text/x-patch",
    });
  }
}

async function persistFileArtifact(ctx: CollectContext, filePath: string, kind: string): Promise<boolean> {
  // Dedup: if MCP already persisted this path, skip
  if (ctx.tracker.artifactExistsByPath(ctx.issueId, ctx.attempt, filePath)) {
    return false;
  }

  const absPath = path.join(ctx.workspacePath, filePath);
  let content: string | undefined;
  let storagePath: string | undefined;
  let contentSize = 0;

  try {
    const stat = await fs.stat(absPath);
    contentSize = stat.size;
    if (stat.size <= INLINE_THRESHOLD) {
      content = await fs.readFile(absPath, "utf-8");
    } else {
      storagePath = absPath;
    }
  } catch {
    return false; // file doesn't exist, skip
  }

  ctx.tracker.insertArtifact({
    issue_id: ctx.issueId,
    attempt: ctx.attempt,
    source: "git_diff",
    kind,
    label: filePath,
    path: filePath,
    content,
    storage_path: storagePath,
    content_size: contentSize,
    mime_type: guessMimeType(kind, filePath),
  });
  return true;
}

/**
 * Unified entry point: collect all artifacts for a completed attempt.
 * Artifacts are derived entirely from workspace git state — no MCP dependency.
 */
export async function collectAllArtifacts(ctx: CollectContext): Promise<number> {
  let count = 0;

  // 1. Git diff snapshot (unified patch)
  const diff = await collectWorkspaceDiff(ctx.workspacePath);
  if (diff.diff_unified && diff.diff_unified.trim().length > 0) {
    await persistGitDiff(ctx, diff);
    count++;
  }

  // 2. Auto-generate file-level artifacts from git changes
  for (const change of diff.changes) {
    if (change.status === "A") {
      if (await persistFileArtifact(ctx, change.path, "file_added")) count++;
    } else if (change.status === "M" || change.status === "D" || change.status === "R") {
      // Skip if MCP already recorded an artifact for this path (MCP takes priority)
      if (ctx.tracker.artifactExistsByPath(ctx.issueId, ctx.attempt, change.path)) continue;
      const kindMap = { M: "file_modified", D: "file_removed", R: "file_renamed" } as const;
      ctx.tracker.insertArtifact({
        issue_id: ctx.issueId,
        attempt: ctx.attempt,
        source: "git_diff",
        kind: kindMap[change.status],
        label: change.path,
        path: change.path,
        mime_type: guessMimeType(kindMap[change.status], change.path),
      });
      count++;
    }
  }

  return count;
}

export function guessMimeType(kind: string, filePath?: string | null): string {
  // Priority: special kinds get fixed MIME types
  switch (kind) {
    case "file_diff":
      return "text/x-patch";
    case "screenshot":
      return "image/png";
    case "log_excerpt":
    case "command_output":
      return "text/plain";
  }
  // Infer from file extension
  if (filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
      ".html": "text/html",
      ".md": "text/markdown",
      ".json": "application/json",
      ".ts": "text/typescript",
      ".tsx": "text/typescript",
      ".js": "text/javascript",
      ".jsx": "text/javascript",
      ".css": "text/css",
      ".yaml": "text/yaml",
      ".yml": "text/yaml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".sh": "text/x-shellscript",
      ".py": "text/x-python",
      ".go": "text/x-go",
      ".rs": "text/x-rust",
    };
    if (map[ext]) return map[ext];
  }
  return "application/octet-stream";
}
