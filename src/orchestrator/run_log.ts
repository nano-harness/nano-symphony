import fs from "fs/promises";
import path from "path";
import { config } from "../config.ts";

export interface RunLogEntry {
  schema_version: number;
  issue_id: string;
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
 * Appends a run log entry to the configured JSONL file.
 * Ensures the directory exists and truncates overly long lines to ≤ 8 KiB.
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

    // Serialize entry
    let line = JSON.stringify(entry);

    // Truncate to 8 KiB if necessary (defensive against long reason strings)
    const MAX_LINE_SIZE = 8 * 1024;
    if (line.length > MAX_LINE_SIZE) {
      const truncated = { ...entry, _truncated: true };
      line = JSON.stringify(truncated).slice(0, MAX_LINE_SIZE);
    }

    line += "\n";

    // Append to file (atomic on POSIX for lines ≤ PIPE_BUF ~4 KiB)
    await fs.appendFile(logPath, line, "utf-8");
  } catch (err) {
    // Log failure but don't throw - run log is observability, not critical path
    console.warn("Failed to write run log:", err instanceof Error ? err.message : String(err));
  }
}
