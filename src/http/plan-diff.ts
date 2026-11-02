export interface PlanStep {
  id: string;
  title: string;
  description?: string;
  after?: string[];
}

export interface PlanEstimates {
  files_touched?: number;
  complexity?: "low" | "medium" | "high";
  estimated_turns?: number;
}

export interface PlanPayload {
  markdown: string;
  revision: number;
  steps?: PlanStep[];
  estimates?: PlanEstimates;
}

export interface LineDiffHunk {
  oldStart: number;
  newStart: number;
  lines: Array<{ kind: "context" | "added" | "removed"; text: string }>;
}

export interface MarkdownDiff {
  hunks: LineDiffHunk[];
}

export interface StepsDiff {
  added: PlanStep[];
  removed: PlanStep[];
  changed: Array<{ from: PlanStep; to: PlanStep; changedFields: string[] }>;
}

export interface EstimateFieldChange {
  from: unknown;
  to: unknown;
}

export interface EstimatesDiff {
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, EstimateFieldChange>;
}

export interface PlanDiff {
  from_revision: number;
  to_revision: number;
  markdown: MarkdownDiff;
  steps: StepsDiff;
  estimates: EstimatesDiff;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * Compute a simple line-level diff using LCS.
 * Returns unified-style hunks with surrounding context.
 */
export function diffMarkdown(oldText: string, newText: string): MarkdownDiff {
  const oldLines = lines(oldText);
  const newLines = lines(newText);

  // LCS dynamic programming table.
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? 1 + dp[i + 1][j + 1]
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk backwards to produce diff entries.
  const diff: Array<{ kind: "context" | "added" | "removed"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      diff.push({ kind: "context", text: oldLines[i] });
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i][j] === dp[i][j + 1])) {
      diff.push({ kind: "added", text: newLines[j] });
      j++;
    } else if (i < m && (j >= n || dp[i][j] === dp[i + 1][j])) {
      diff.push({ kind: "removed", text: oldLines[i] });
      i++;
    } else {
      // Fallback: treat as removal + addition.
      if (i < m) {
        diff.push({ kind: "removed", text: oldLines[i] });
        i++;
      }
      if (j < n) {
        diff.push({ kind: "added", text: newLines[j] });
        j++;
      }
    }
  }

  // Split into hunks with 2 lines of context.
  const hunks: LineDiffHunk[] = [];
  const contextWindow = 2;
  let hunk: LineDiffHunk | null = null;

  for (let idx = 0; idx < diff.length; idx++) {
    const entry = diff[idx];
    if (entry.kind !== "context") {
      if (!hunk) {
        const start = Math.max(0, idx - contextWindow);
        hunk = {
          oldStart: countRange(diff, 0, start, "removed") + countRange(diff, 0, start, "context") + 1,
          newStart: countRange(diff, 0, start, "added") + countRange(diff, 0, start, "context") + 1,
          lines: diff.slice(start, idx),
        };
        // Patch start positions: only count lines that belong to the respective side.
        hunk.oldStart = countSideLines(hunk.lines, "old") + 1;
        hunk.newStart = countSideLines(hunk.lines, "new") + 1;
      }
      hunk.lines.push(entry);
    } else {
      if (hunk) {
        // Include up to contextWindow trailing context lines then close hunk.
        const remaining = diff.slice(idx);
        const trailing = remaining.slice(0, contextWindow + 1);
        hunk.lines.push(...trailing);
        hunks.push(hunk);
        hunk = null;
        // Skip ahead over the context lines we just consumed.
        idx += trailing.length - 1;
      }
    }
  }
  if (hunk) {
    hunks.push(hunk);
  }

  return { hunks };
}

function countRange(diff: Array<{ kind: string }>, start: number, end: number, kind: string): number {
  let count = 0;
  for (let k = start; k < end && k < diff.length; k++) {
    if (diff[k].kind === kind) count++;
  }
  return count;
}

function countSideLines(lines: Array<{ kind: string }>, side: "old" | "new"): number {
  return lines.filter((l) =>
    side === "old" ? (l.kind === "removed" || l.kind === "context") : (l.kind === "added" || l.kind === "context")
  ).length;
}

export function diffSteps(oldSteps: PlanStep[] = [], newSteps: PlanStep[] = []): StepsDiff {
  const oldMap = new Map(oldSteps.map((s) => [s.id, s]));
  const newMap = new Map(newSteps.map((s) => [s.id, s]));

  const added: PlanStep[] = [];
  const removed: PlanStep[] = [];
  const changed: StepsDiff["changed"] = [];

  for (const step of newSteps) {
    if (!oldMap.has(step.id)) added.push(step);
  }
  for (const step of oldSteps) {
    if (!newMap.has(step.id)) removed.push(step);
  }
  for (const step of newSteps) {
    const old = oldMap.get(step.id);
    if (!old) continue;
    const changedFields: string[] = [];
    if (old.title !== step.title) changedFields.push("title");
    if (old.description !== step.description) changedFields.push("description");
    if (changedFields.length > 0) changed.push({ from: old, to: step, changedFields });
  }

  return { added, removed, changed };
}

export function diffEstimates(
  oldEstimates: PlanEstimates | undefined,
  newEstimates: PlanEstimates | undefined,
): EstimatesDiff {
  const oldMap = oldEstimates ? (oldEstimates as Record<string, unknown>) : {};
  const newMap = newEstimates ? (newEstimates as Record<string, unknown>) : {};
  const allKeys = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);

  const added: Record<string, unknown> = {};
  const removed: Record<string, unknown> = {};
  const changed: Record<string, EstimateFieldChange> = {};

  for (const key of allKeys) {
    const hasOld = Object.prototype.hasOwnProperty.call(oldMap, key);
    const hasNew = Object.prototype.hasOwnProperty.call(newMap, key);
    if (!hasOld && hasNew) {
      added[key] = newMap[key];
    } else if (hasOld && !hasNew) {
      removed[key] = oldMap[key];
    } else if (JSON.stringify(oldMap[key]) !== JSON.stringify(newMap[key])) {
      changed[key] = { from: oldMap[key], to: newMap[key] };
    }
  }

  return { added, removed, changed };
}

export function computePlanDiff(fromPayload: PlanPayload, toPayload: PlanPayload): PlanDiff {
  return {
    from_revision: fromPayload.revision,
    to_revision: toPayload.revision,
    markdown: diffMarkdown(fromPayload.markdown, toPayload.markdown),
    steps: diffSteps(fromPayload.steps, toPayload.steps),
    estimates: diffEstimates(fromPayload.estimates, toPayload.estimates),
  };
}
