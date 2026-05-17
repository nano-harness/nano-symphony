import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";
import { ensureWorkspace, runHook } from "../workspace/manager.ts";
import { renderPrompt } from "../prompt/renderer.ts";
import { issueToken, revokeToken } from "../mcp/auth.ts";
import { spawnAgent, NANO_EXIT } from "../spawner/index.ts";
import type { SpawnResult } from "../spawner/index.ts";
import { calculateBackoff } from "./backoff.ts";
import type { Logger } from "pino";

export interface WorkerContext {
  tracker: Tracker;
  workflow: { workflow: Workflow; template: string };
  logger: Logger;
  mcpUrl: string;
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
): { semantics: string; handoffState?: string; summary?: string } {
  // Tier 1: MCP session_completed event (only way to express handoff)
  if (completionEvent?.payload_json) {
    try {
      const payload = JSON.parse(completionEvent.payload_json) as {
        semantics?: string;
        summary?: string;
        handoff_state?: string;
      };
      if (payload.semantics === "success" || payload.semantics === "needs_retry"
        || payload.semantics === "handoff" || payload.semantics === "abandoned") {
        return {
          semantics: payload.semantics,
          handoffState: payload.handoff_state,
          summary: payload.summary,
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
    if (gs?.achieved_at) {
      return { semantics: "success", summary: gs.last_reason };
    }
    if (sentinel.status === "success") {
      return { semantics: "success", summary: gs?.last_reason };
    }
    if (sentinel.status === "needs_retry") {
      return { semantics: "needs_retry", summary: gs?.last_reason };
    }
    if (sentinel.status === "abandoned") {
      return { semantics: "abandoned", summary: gs?.last_reason };
    }
    // sentinel.status === "timeout" etc., fall through to exit code
  }

  // Tier 3: Process exit code fallback
  if (spawnResult?.exitCode === NANO_EXIT.RETRY) {
    return { semantics: "needs_retry" };
  }
  if (spawnResult?.exitCode === NANO_EXIT.ABANDONED) {
    return { semantics: "abandoned" };
  }
  if (spawnResult?.exitCode === NANO_EXIT.TIMEOUT) {
    return { semantics: "needs_retry" };
  }
  if (spawnResult?.exitCode === NANO_EXIT.SUCCESS) {
    return { semantics: "handoff" };
  }
  if (spawnResult?.killedByTimeout) {
    return { semantics: "needs_retry" };
  }
  return { semantics: "abandoned" };
}

export async function runWorker(issueId: string, attempt: number, ctx: WorkerContext): Promise<void> {
  const { tracker, workflow, logger, mcpUrl } = ctx;

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

  const wsPath = await ensureWorkspace(issue.identifier);
  tracker.updateWorkspacePath(issueId, wsPath);

  const hooks = workflow.workflow.workspace?.hooks;
  const hookEnv: Record<string, string> = {
    SYMPHONY_ISSUE_ID: issueId,
    SYMPHONY_WORKSPACE: wsPath,
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
    prompt = await renderPrompt(workflow.template, { issue, attempt }, { goal: workflow.workflow.goal });
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
  const timeoutMs = agentConfig?.timeout_ms ?? 300_000;
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
  const { semantics, handoffState, summary } = deriveCompletion(completionEvent, spawnResult);

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
    tracker.releaseIssue(issueId, "released");
    tracker.updateLastIssueState(issueId, finalState);
    tracker.recordEvent(issueId, "completed", summary ?? "Agent completed successfully", { target_state: finalState });
  } else if (semantics === "needs_retry" && attempt < maxRetries) {
    const delay = calculateBackoff(attempt, base, maxBackoff);
    const nextDue = Date.now() + delay;
    tracker.scheduleRetry(issueId, nextDue, attempt + 1);
    tracker.recordEvent(issueId, "retry_scheduled", `Retry scheduled in ${delay}ms`, { delay, attempt: attempt + 1 });
  } else if (semantics === "handoff") {
    const finalHandoffState = handoffState ?? "in_review";
    tracker.releaseIssue(issueId, finalHandoffState);
    tracker.updateLastIssueState(issueId, targetState ?? finalHandoffState);
    tracker.recordEvent(issueId, "handoff", `Handed off to ${finalHandoffState}`, { target_state: targetState ?? finalHandoffState });
  } else {
    tracker.releaseIssue(issueId, "released");
    tracker.updateLastIssueState(issueId, finalState);
    tracker.recordEvent(issueId, "abandoned", summary ?? "Agent abandoned or max retries exceeded", { target_state: finalState });
  }

  revokeToken(token);

  logger.info({ issueId, semantics, attempt }, "Worker completed");
}
