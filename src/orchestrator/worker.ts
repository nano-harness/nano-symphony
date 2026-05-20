import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";
import { ensureWorkspace, runHook } from "../workspace/manager.ts";
import { renderPrompt } from "../prompt/renderer.ts";
import { issueToken, revokeToken } from "../mcp/auth.ts";
import { spawnAgent, NANO_EXIT } from "../spawner/index.ts";
import type { SpawnResult } from "../spawner/index.ts";
import { calculateBackoff } from "./backoff.ts";
import { collectWorkspaceDiff } from "./diff.ts";
import { appendRunLog } from "./run_log.ts";
import { config } from "../config.ts";
import type { Logger } from "pino";

export interface WorkerContext {
  tracker: Tracker;
  workflow: { workflow: Workflow; template: string };
  logger: Logger;
  mcpUrl: string;
}

/**
 * Normalizes a blocker reason string into a stable fingerprint by removing dynamic parts.
 * Truncates to 80 characters and strips timestamps, PIDs, ports, and other variable data.
 */
function normalizeBlockerString(reason?: string): string {
  if (!reason) return "unknown_blocker";

  let normalized = reason
    // Remove timestamps (ISO 8601, Unix epoch, common date formats)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<timestamp>")
    .replace(/\d{10,13}/g, "<timestamp>")
    // Remove PIDs and numeric IDs
    .replace(/\bpid[:\s]+\d+/gi, "pid:<id>")
    .replace(/\b(P|p)rocess\s+\d+/g, "Process <id>")
    // Remove port numbers
    .replace(/:\d{2,5}\b/g, ":<port>")
    // Remove file paths with dynamic segments (keep structure)
    .replace(/\/tmp\/[\w-]+/g, "/tmp/<id>")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();

  // Truncate to 80 chars
  return normalized.slice(0, 80);
}

/**
 * Three-tier completion signal:
 *   1. MCP `symphony.session_completed` — agent's stated intent (only signal that
 *      can express `handoff`, since nano-agent's sentinel has no such status).
 *   2. nano-agent stdout sentinel — binary-mode outcome (success/needs_retry/abandoned/timeout).
 *   3. Process exit code — last-resort fallback when neither signal landed.
 */
export function deriveCompletion(
  completionEvent: { payload_json: string | null } | null,
  spawnResult: SpawnResult | null
): {
  semantics: string;
  handoffState?: string;
  summary?: string;
  blockerFingerprint?: string;
  terminationCause?: string;
} {
  // Tier 1: MCP session_completed event (only way to express handoff)
  if (completionEvent?.payload_json) {
    try {
      const payload = JSON.parse(completionEvent.payload_json) as {
        semantics?: string;
        summary?: string;
        handoff_state?: string;
        blocker_fingerprint?: string;
        termination_cause?: string;
      };
      if (payload.semantics === "success" || payload.semantics === "needs_retry"
        || payload.semantics === "handoff" || payload.semantics === "abandoned") {
        return {
          semantics: payload.semantics,
          handoffState: payload.handoff_state,
          summary: payload.summary,
          blockerFingerprint: payload.blocker_fingerprint,
          terminationCause: payload.termination_cause,
        };
      }
    } catch {
      // fall through to sentinel
    }
  }

  // Tier 2: nano-agent stdout sentinel
  const sentinel = spawnResult?.sentinel;
  if (sentinel) {
    const gs = sentinel.goal_state;

    // Extract fingerprint and termination_cause from sentinel if present
    const blockerFingerprint = sentinel.blocker_fingerprint
      || (sentinel.status !== "success" && gs?.last_reason
          ? normalizeBlockerString(gs.last_reason)
          : undefined);
    const terminationCause = sentinel.termination_cause;

    if (gs?.achieved_at) {
      return {
        semantics: "success",
        summary: gs.last_reason,
        blockerFingerprint: undefined,
        terminationCause,
      };
    }
    if (sentinel.status === "success") {
      return {
        semantics: "success",
        summary: gs?.last_reason,
        blockerFingerprint: undefined,
        terminationCause,
      };
    }
    if (sentinel.status === "needs_retry") {
      return {
        semantics: "needs_retry",
        summary: gs?.last_reason,
        blockerFingerprint,
        terminationCause,
      };
    }
    if (sentinel.status === "abandoned") {
      return {
        semantics: "abandoned",
        summary: gs?.last_reason,
        blockerFingerprint,
        terminationCause,
      };
    }
    if (sentinel.status === "timeout") {
      return {
        semantics: "needs_retry",
        summary: gs?.last_reason,
        blockerFingerprint: blockerFingerprint || "timeout",
        terminationCause: terminationCause || "timeout",
      };
    }
  }

  // Tier 3: Process exit code fallback
  if (spawnResult?.exitCode === NANO_EXIT.RETRY) {
    return {
      semantics: "needs_retry",
      blockerFingerprint: `exit_${NANO_EXIT.RETRY}`,
      terminationCause: "exit_only",
    };
  }
  if (spawnResult?.exitCode === NANO_EXIT.ABANDONED) {
    return {
      semantics: "abandoned",
      blockerFingerprint: `exit_${NANO_EXIT.ABANDONED}`,
      terminationCause: "exit_only",
    };
  }
  if (spawnResult?.exitCode === NANO_EXIT.TIMEOUT) {
    return {
      semantics: "needs_retry",
      blockerFingerprint: `exit_${NANO_EXIT.TIMEOUT}`,
      terminationCause: "exit_only",
    };
  }
  if (spawnResult?.exitCode === NANO_EXIT.SUCCESS) {
    return { semantics: "handoff" };
  }
  if (spawnResult?.killedByTimeout) {
    return {
      semantics: "needs_retry",
      blockerFingerprint: "killed_by_timeout",
      terminationCause: "timeout",
    };
  }

  // Agent completely silent or unclassified exit
  return {
    semantics: "abandoned",
    summary: "Agent exited without explicit completion signal",
    blockerFingerprint: "agent_terminated_silently",
    terminationCause: "no_signal",
  };
}

export async function runWorker(issueId: string, attempt: number, ctx: WorkerContext): Promise<void> {
  const { tracker, workflow, logger, mcpUrl } = ctx;
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  // Track completion variables for run log
  let finalSemantics = "abandoned";
  let finalTargetState: string | null = null;
  let finalBlockerFingerprint: string | null = null;
  let finalTerminationCause: string | null = null;
  let finalTokens: { input: number; output: number; total: number } | null = null;

  try {
    const claimed = tracker.claimIssue(issueId, attempt);
    if (!claimed) {
      logger.debug({ issueId }, "Failed to claim issue");
      return;
    }

    const issue = tracker.getIssue(issueId);
    if (!issue) {
      tracker.releaseIssue(issueId, "released");
      return;
    }

  const { path: wsPath, managed } = await ensureWorkspace(
    issue.identifier,
    issue.workspace_path,
    workflow.workflow.workspace?.root,
    workflow.workflow.workspace?.git_baseline ?? true,
  );
  tracker.updateWorkspacePath(issueId, wsPath, managed);

  const hooks = workflow.workflow.workspace?.hooks;
  const hookEnv: Record<string, string> = {
    SYMPHONY_ISSUE_ID: issueId,
    SYMPHONY_WORKSPACE: wsPath,
    SYMPHONY_WORKSPACE_MANAGED: managed ? "1" : "0",
    SYMPHONY_IDENTIFIER: issue.identifier,
  };

  try {
    if (hooks?.after_create) {
      await runHook(hooks.after_create, hookEnv);
    }
    if (hooks?.before_run) {
      await runHook(hooks.before_run, hookEnv);
    }
  } catch (err) {
    logger.error({ err, issueId }, "Hook failed");
    tracker.recordEvent(issueId, "error", `Hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let prompt: string;
  try {
    prompt = await renderPrompt(workflow.template, { issue, attempt }, {
      goal: workflow.workflow.goal,
      tracker,
      issueId,
    });
  } catch (err) {
    logger.error({ err, issueId }, "Failed to render prompt");
    // Permanent failure (likely template typo). Record so operators see it in
    // /api/v1/events instead of only pino logs.
    const message = err instanceof Error ? err.message : String(err);
    tracker.recordEvent(issueId, "error", `Failed to render prompt: ${message}`, {
      stage: "render_prompt",
      error: message,
    });
    tracker.releaseIssue(issueId, "released");
    // Sync last_issue_state so the candidate SQL doesn't re-pick this issue
    // every tick. Operator must change issues.state to retry.
    tracker.updateLastIssueState(issueId, issue.state);
    return;
  }

  const token = issueToken(issueId, attempt);

  tracker.recordEvent(issueId, "started", `Attempt ${attempt} started`, { attempt });

  const agentConfig = workflow.workflow.agent;
  const timeoutMs = agentConfig?.timeout_ms ?? 3_600_000;
  const binary = agentConfig?.binary ?? "nano";
  const sandboxConfig = agentConfig?.sandbox ?? {
    backend: "native" as const,
    network_access: true,
    extra_read_only_paths: [],
    extra_writable_paths: [],
  };

  let spawnResult: SpawnResult | null = null;
  try {
    spawnResult = await spawnAgent({
      issueId,
      attempt,
      workspace: wsPath,
      prompt,
      token,
      mcpUrl,
      binary,
      timeoutMs,
      sandboxConfig,
    });
  } catch (err) {
    logger.error({ err, issueId }, "Agent spawn error");
    tracker.recordEvent(issueId, "error", `Agent error: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    if (hooks?.after_run) {
      await runHook(hooks.after_run, hookEnv);
    }
  } catch (err) {
    logger.warn({ err, issueId }, "after_run hook failed");
  }

  const completionEvent = tracker.getLatestEventByKind(issueId, "session_completed");
  const { semantics, handoffState, summary, blockerFingerprint, terminationCause } = deriveCompletion(completionEvent, spawnResult);

  // Capture for run log
  finalSemantics = semantics;
  finalBlockerFingerprint = blockerFingerprint ?? null;
  finalTerminationCause = terminationCause ?? null;

  // Synthesize session_completed_synthetic event if agent didn't call MCP
  if (!completionEvent) {
    tracker.recordEvent(issueId, "session_completed_synthetic",
      summary ?? "(agent silent)",
      {
        semantics,
        handoff_state: handoffState,
        blocker_fingerprint: blockerFingerprint,
        termination_cause: terminationCause,
        source: "synthetic",
      });
  }

  // Record goal_state_observed event if sentinel contains goal_state
  if (spawnResult?.sentinel?.goal_state) {
    tracker.recordEvent(issueId, "goal_state_observed",
      spawnResult.sentinel.goal_state.last_reason ?? "(no reason)",
      spawnResult.sentinel.goal_state);
  }

  // Record token stats from nano-agent's authoritative counter (sentinel.tokens).
  // The LLM cannot see its own token usage, so we record from the sentinel
  // rather than expecting agent self-report.
  if (spawnResult?.sentinel?.tokens) {
    const { input, output } = spawnResult.sentinel.tokens;
    tracker.updateTokenStats(issueId, input, output, input + output);
    finalTokens = { input, output, total: input + output };
  }

  // Record sandbox_observed event if sentinel contains sandbox metadata
  if (spawnResult?.sentinel?.sandbox) {
    const sandboxInfo = spawnResult.sentinel.sandbox;
    tracker.recordEvent(
      issueId,
      "sandbox_observed",
      `${sandboxInfo.backend_detail ?? sandboxInfo.backend}`,
      sandboxInfo
    );
  }

  const retryConfig = workflow.workflow.retry;
  const base = retryConfig?.base_delay_ms ?? 5_000;
  const maxBackoff = retryConfig?.max_delay_ms ?? 300_000;
  const maxRetries = agentConfig?.max_retries ?? 3;

  // State transition logic
  const transitions = workflow.workflow.state_transitions ?? {};
  let targetState: string | null = (transitions as Record<string, string | null>)[semantics] ?? null;

  // Agent's explicit handoff_state overrides default workflow mapping
  if (semantics === "handoff" && handoffState) {
    targetState = handoffState;
  }

  // 关键顺序：先 updateIssueState（改 issues.state），再 updateLastIssueState（同步到新值）
  // 否则 last_issue_state(旧) != issues.state(新)，会被 candidate SQL 重新拾起
  if (targetState && targetState !== issue.state) {
    tracker.updateIssueState(issueId, targetState);
  }
  const finalState = targetState ?? issue.state;

  if (semantics === "success") {
    tracker.updateLastBlockerFingerprint(issueId, null);
    tracker.releaseIssue(issueId, "released");
    tracker.updateLastIssueState(issueId, finalState);
    finalTargetState = finalState;
    tracker.recordEvent(issueId, "completed", summary ?? "Agent completed successfully", { target_state: finalState });
  } else if (semantics === "needs_retry" && attempt < maxRetries) {
    // Same-cause short-circuit: if same fingerprint repeats and we've seen it before, skip retry
    const currentFingerprint = blockerFingerprint ?? "";
    const prevFingerprint = tracker.getLastBlockerFingerprint(issueId);

    if (currentFingerprint && currentFingerprint === prevFingerprint && attempt >= 1) {
      // Short-circuit to blocked state
      const blockedState = (transitions as Record<string, string | null>)["blocked"]
        ?? (transitions as Record<string, string | null>)["abandoned"]
        ?? "blocked";

      if (blockedState !== issue.state) {
        tracker.updateIssueState(issueId, blockedState);
      }

      tracker.releaseIssue(issueId, "released");
      tracker.updateLastIssueState(issueId, blockedState);
      finalTargetState = blockedState;
      finalSemantics = "abandoned"; // Short-circuit is effectively abandoned
      tracker.recordEvent(issueId, "shortcircuit_same_cause",
        `Same blocker repeated across attempts ${attempt} and ${attempt + 1}: ${currentFingerprint}`,
        { fingerprint: currentFingerprint, attempt, prev_attempt: attempt });
    } else {
      // Normal retry path
      const delay = calculateBackoff(attempt, base, maxBackoff);
      const nextDue = Date.now() + delay;

      // Persist fingerprint for next attempt comparison
      if (currentFingerprint) {
        tracker.updateLastBlockerFingerprint(issueId, currentFingerprint);
      }

      tracker.scheduleRetry(issueId, nextDue, attempt + 1);
      finalTargetState = issue.state; // State doesn't change on retry
      tracker.recordEvent(issueId, "retry_scheduled", `Retry scheduled in ${delay}ms`, { delay, attempt: attempt + 1 });
    }
  } else if (semantics === "handoff") {
    tracker.updateLastBlockerFingerprint(issueId, null);
    const finalHandoffState = handoffState ?? "in_review";
    const wsDiff = await collectWorkspaceDiff(wsPath);
    const completionPayload = JSON.parse(completionEvent?.payload_json ?? "{}") as Record<string, unknown>;

    tracker.releaseIssue(issueId, finalHandoffState);
    tracker.updateLastIssueState(issueId, targetState ?? finalHandoffState);
    finalTargetState = targetState ?? finalHandoffState;
    tracker.recordEvent(issueId, "handoff", summary ?? `Handed off to ${finalHandoffState}`, {
      target_state: targetState ?? finalHandoffState,
      summary: summary ?? "",
      artifacts: completionPayload.artifacts ?? [],
      follow_ups: completionPayload.follow_ups ?? [],
      metrics: completionPayload.metrics ?? {},
      workspace_diff: wsDiff,
    });
  } else {
    // Abandoned or max retries exceeded
    tracker.releaseIssue(issueId, "released");
    tracker.updateLastIssueState(issueId, finalState);
    finalTargetState = finalState;
    tracker.recordEvent(issueId, "abandoned", summary ?? "Agent abandoned or max retries exceeded", { target_state: finalState });
  }

  revokeToken(token);

  logger.info({ issueId, semantics, attempt }, "Worker completed");
  } finally {
    // Always write run log, even if worker throws
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;
    const issue = tracker.getIssue(issueId);

    if (issue) {
      const success = finalSemantics === "success" || finalSemantics === "handoff";
      const eventsUrl = `/api/v1/issues/${issueId}/events`;

      await appendRunLog({
        schema_version: 1,
        issue_id: issueId,
        identifier: issue.identifier,
        attempt,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: durationMs,
        semantics: finalSemantics,
        target_state: finalTargetState,
        success,
        blocker_fingerprint: finalBlockerFingerprint,
        termination_cause: finalTerminationCause,
        tokens: finalTokens,
        events_url: eventsUrl,
      });
    }
  }
}
