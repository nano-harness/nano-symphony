/**
 * Plan journal: append-only JSONL log per plan run.
 * Stored at ${SYMPHONY_DATA}/plan-runs/<id>/journal.jsonl
 * Used for crash-resume (skip already-completed issues) and observability.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JournalEntry } from "./sdk.ts";

function getPlanDir(runId: string): string {
  const dataDir = process.env.SYMPHONY_DATA ?? ".symphony";
  return join(dataDir, "plan-runs", runId);
}

function getJournalPath(runId: string): string {
  return join(getPlanDir(runId), "journal.jsonl");
}

export function appendJournalEntry(runId: string, entry: JournalEntry): void {
  const dir = getPlanDir(runId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(getJournalPath(runId), JSON.stringify(entry) + "\n", "utf8");
}

export function readJournal(runId: string): JournalEntry[] {
  const path = getJournalPath(runId);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const entries: JournalEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/** Returns a map from issue key to result payload for issues already completed. */
export function getCompletedIssueResults(runId: string): Map<string, Record<string, unknown>> {
  const entries = readJournal(runId);
  const results = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    if (e.type === "issue_done" && typeof e.payload.key === "string") {
      results.set(e.payload.key, e.payload);
    }
  }
  return results;
}

/** Stable key for an issue invocation: phase + prompt prefix */
export function issueKey(phase: string, promptPrefix: string): string {
  return `${phase}::${promptPrefix}`;
}
