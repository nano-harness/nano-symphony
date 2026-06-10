import fs from "fs/promises";
import path from "path";
import { config } from "../config.ts";

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MiB — rotate when exceeded
const MAX_ROTATED_FILES = 3; // Keep at most 3 rotated files

export interface RunLogEntry {
  schema_version: number;
  issue_uuid: string;
  identifier: string;
  attempt: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  semantics: string;
  target_state: string | null;
  success: boolean;
  blocker_fingerprint: string | null;
  termination_cause: string | null;
  tokens: { input: number; output: number; total: number } | null;
  events_url: string;
}

/**
 * Rotates the log file if it exceeds MAX_LOG_SIZE.
 * Renames current → .1, .1 → .2, etc., and removes files beyond MAX_ROTATED_FILES.
 */
async function rotateIfNeeded(logPath: string): Promise<void> {
  try {
    const stat = await fs.stat(logPath);
    if (stat.size < MAX_LOG_SIZE) return;
  } catch {
    return; // File doesn't exist yet, nothing to rotate
  }

  // Shift existing rotated files
  for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
    const src = i === 1 ? logPath : `${logPath}.${i - 1}`;
    const dst = `${logPath}.${i}`;
    try {
      if (i === MAX_ROTATED_FILES) {
        await fs.unlink(dst).catch(() => {});
      }
      await fs.rename(src, dst);
    } catch { /* source doesn't exist, skip */ }
  }
}

/**
 * Appends a run log entry to the configured JSONL file.
 * Ensures the directory exists and truncates overly long lines to ≤ 8 KiB.
 * Rotates the log file when it exceeds 10 MiB.
 */
export async function appendRunLog(entry: RunLogEntry): Promise<void> {
  if (!config.RUN_LOG_ENABLED) {
    return;
  }

  try {
    const logPath = config.RUN_LOG_PATH;
    const logDir = path.dirname(logPath);

    // Ensure directory exists
    await fs.mkdir(logDir, { recursive: true });

    // Rotate if file exceeds size limit
    await rotateIfNeeded(logPath);

    // Serialize entry
    let line = JSON.stringify(entry);

    // Truncate to 8 KiB if necessary (defensive against long reason strings)
    const MAX_LINE_SIZE = 8 * 1024;
    if (line.length > MAX_LINE_SIZE) {
      // Truncate long fields instead of slicing raw JSON (which produces invalid JSON)
      const truncated: Record<string, unknown> = { ...entry, _truncated: true };
      if (typeof truncated.blocker_fingerprint === "string" && (truncated.blocker_fingerprint as string).length > 200) {
        truncated.blocker_fingerprint = (truncated.blocker_fingerprint as string).slice(0, 200);
      }
      line = JSON.stringify(truncated);
      // If still over budget after field truncation, hard-truncate as valid empty-ish entry
      if (line.length > MAX_LINE_SIZE) {
        line = JSON.stringify({
          schema_version: entry.schema_version,
          issue_uuid: entry.issue_uuid,
          identifier: entry.identifier,
          attempt: entry.attempt,
          started_at: entry.started_at,
          finished_at: entry.finished_at,
          duration_ms: entry.duration_ms,
          semantics: entry.semantics,
          success: entry.success,
          _truncated: true,
        });
      }
    }

    line += "\n";

    // Append to file (atomic on POSIX for lines ≤ PIPE_BUF ~4 KiB)
    await fs.appendFile(logPath, line, "utf-8");
  } catch (err) {
    // Log failure but don't throw - run log is observability, not critical path
    console.warn("Failed to write run log:", err instanceof Error ? err.message : String(err));
  }
}
