import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";
import { ensureWorkspace, runHook } from "../workspace/manager.ts";
import { renderPrompt } from "../prompt/renderer.ts";
import { issueToken, revokeToken, AGENT_TOOL_SCOPE } from "../mcp/auth.ts";
import { spawnAgent } from "../spawner/index.ts";
import type { SpawnResult } from "../spawner/index.ts";
import { calculateBackoff } from "./backoff.ts";
import { appendRunLog } from "./run_log.ts";
import type { Logger } from "pino";
import type { AgentResultSummary } from "../spawner/agent-result-payload.ts";

export interface WorkerContext {
  tracker: Tracker;
  workflow: { workflow: Workflow; template: string };
  logger: Logger;
  mcpUrl: string;
  spawn?: typeof spawnAgent;
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
 *   1. nano-agent Stop hook payload — binary-mode outcome (success/needs_retry/abandoned/timeout).
 *   2. Process timeout kill — always treated as retryable timeout.
 *
 * Missing Stop hook payload is treated as a hard failure (`no_result_payload`).
 */
export function deriveCompletion(
  spawnResult: SpawnResult | null,
  payload: AgentResultSummary | null
): {
  semantics: string;
  summary?: string;
  blockerFingerprint?: string;
  terminationCause?: string;
} {
  if (spawnResult?.killedByTimeout) {
    return {
      semantics: "needs_retry",
      blockerFingerprint: "killed_by_timeout",
      terminationCause: "timeout",
    };
  }

  if (!payload) {
    return {
      semantics: "abandoned",
      summary: "agent exited without delivering a result summary",
      terminationCause: "no_result_payload",
    };
  }

  const gs = payload.goal_state;
  const blockerFingerprint = payload.status !== "success" && gs?.last_reason
    ? normalizeBlockerString(gs.last_reason)
    : undefined;

  if (payload.status === "success") {
    // Cross-validate: if exit code is non-zero, don't trust the success claim
    if (spawnResult && spawnResult.exitCode !== 0 && spawnResult.exitCode !== null) {
      return {
        semantics: "needs_retry",
        summary: `Agent reported success but exited with code ${spawnResult.exitCode}`,
        blockerFingerprint: `exitcode_mismatch:${spawnResult.exitCode}`,
        terminationCause: "exitcode_mismatch",
      };
    }
    return {
      semantics: "success",
      summary: gs?.last_reason ?? payload.reason,
      blockerFingerprint: undefined,
      terminationCause: undefined,
    };
  }
  if (payload.status === "needs_retry") {
    return {
      semantics: "needs_retry",
      summary: gs?.last_reason ?? payload.reason,
      blockerFingerprint,
      terminationCause: undefined,
    };
  }
  if (payload.status === "abandoned") {
    return {
      semantics: "abandoned",
      summary: gs?.last_reason ?? payload.reason,
      blockerFingerprint,
      terminationCause: undefined,
    };
  }
  if (payload.status === "timeout") {
    return {
      semantics: "needs_retry",
      summary: gs?.last_reason ?? payload.reason,
      blockerFingerprint: blockerFingerprint || "timeout",
      terminationCause: "timeout",
    };
  }

  return {
    semantics: "abandoned",
    summary: "Agent result payload contains unsupported status",
    terminationCause: "bad_result_payload",
  };
}

export async function runWorker(issueId: string, attempt: number, ctx: WorkerContext): Promise<void> {
  const { tracker, workflow, logger, mcpUrl } = ctx;
  const spawn = ctx.spawn ?? spawnAgent;
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  // Track completion variables for run log
  let finalSemantics = "abandoned";
  let finalTargetState: string | null = null;
  let finalBlockerFingerprint: string | null = null;
  let finalTerminationCause: string | null = null;
  let finalTokens: { input: number; output: number; total: number } | null = null;

  try {
    // Claim happens in orchestrator tick for race-condition safety.
    // If called directly (e.g. in tests), attempt claim here as fallback.
    const existingRun = tracker.getRun(issueId);
    if (!existingRun || existingRun.last_state !== "claimed") {
      const claimed = tracker.claimIssue(issueId, attempt);
      if (!claimed) {
        logger.debug({ issueId }, "Failed to claim issue");
        return;
      }
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
    // Determine if we're in planning phase
    const planningConfig = workflow.workflow.agent?.planning;
    const isInPlanningPhase = issue.state === "planning";

    // Choose template: use planning template if provided and in planning phase
    const templateToUse = isInPlanningPhase && planningConfig?.template
      ? planningConfig.template
      : workflow.template;

    const result = await renderPrompt(templateToUse, { issue, attempt }, {
      goal: isInPlanningPhase ? undefined : workflow.workflow.goal,
      tracker,
      issueId,
    });
    prompt = result.text;

    // Inject planning prompt prefix if in planning phase
    if (isInPlanningPhase) {
      const planningPrefix =
        `You are in PLANNING mode. Your task is to analyze the issue and produce an ` +
        `implementation plan. Do NOT write code or make changes.\n\n` +
        `Output your plan by calling the \`symphony.submit_plan\` MCP tool.\n\n` +
        `Your plan should include:\n` +
        `- What files need to be created/modified\n` +
        `- The approach and key design decisions\n` +
        `- Step-by-step breakdown\n` +
        `- Any risks or open questions\n\n`;
      prompt = planningPrefix + prompt;

      // Inject plan revision feedback if this is a revision
      const revisionEvent = tracker.getLatestEventByKind(issueId, "plan_revision_requested");
      const lastPlanEvent = tracker.getLatestEventByKind(issueId, "plan_submitted");
      if (revisionEvent && (!lastPlanEvent || revisionEvent.ts > lastPlanEvent.ts)) {
        const revPayload = JSON.parse(revisionEvent.payload_json ?? "{}") as { note?: string };
        if (revPayload.note) {
          prompt = `Operator requested plan revision:\n${revPayload.note}\n\nAddress this feedback in your revised plan.\n\n` + prompt;
        }
      }
    }

    // Inject approved plan into execution prompt if transitioning from plan_review
    if (!isInPlanningPhase) {
      const approvedPlanEvent = tracker.getLatestEventByKind(issueId, "plan_approved");
      const latestPlanEvent = tracker.getLatestEventByKind(issueId, "plan_submitted");
      if (approvedPlanEvent && latestPlanEvent) {
        try {
          const planPayload = JSON.parse(latestPlanEvent.payload_json ?? "{}") as { markdown?: string };
          if (planPayload.markdown) {
            const executionPrefix =
              `## Approved Implementation Plan\n\n${planPayload.markdown}\n\n---\n\n` +
              `Execute this plan. Follow the steps above. If you encounter issues that ` +
              `require deviating from the plan, document the deviation.\n\n`;
            prompt = executionPrefix + prompt;
          }
        } catch {
          // ignore malformed plan payload
        }
      }
    }

    // Record comments_injected event if comments were included
    if (result.meta.commentIds.length > 0) {
      tracker.recordEvent(issueId, "comments_injected", `${result.meta.commentIds.length} comments injected into prompt`, {
        attempt,
        comment_ids: result.meta.commentIds,
        count: result.meta.commentIds.length,
        truncated: result.meta.truncated,
      });
    }
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

  // S6: Issue agent token scoped to reporting-only tools (AGENT_TOOL_SCOPE).
  // S7: Extend TTL to cover the full agent timeout plus a 10-minute buffer so
  //     tokens don't expire mid-session. Use config timeout as a fallback.
  const isInPlanningPhase = issue.state === "planning";
  const planningConfig = workflow.workflow.agent?.planning;
  const DEFAULT_PLANNING_TIMEOUT_MS = 300_000; // 5 minutes for planning phase (shorter than execution)
  const baseTimeoutMs = (workflow.workflow.agent?.timeout_ms ?? 3_600_000);
  const timeoutMs = isInPlanningPhase
    ? (planningConfig?.planning_timeout_ms ?? DEFAULT_PLANNING_TIMEOUT_MS)
    : baseTimeoutMs;
  const tokenTtlMs = timeoutMs + 10 * 60 * 1000; // timeout + 10min buffer
  const token = issueToken(issueId, attempt, AGENT_TOOL_SCOPE, tokenTtlMs);

  // Mark current attempt before spawning agent so frontend can subscribe to correct log
  tracker.markCurrentAttempt(issueId, attempt);

  // Record prompt summary for debugging
  tracker.recordEvent(issueId, "prompt_rendered", `Prompt rendered (${prompt.length} chars): ${prompt.slice(0, 200)}…`, {
    attempt,
    prompt_length: prompt.length,
  });

  const agentConfig = workflow.workflow.agent;
  const agentKind: "nano" | "claude-code" =
    issue.agent_kind ?? agentConfig?.kind ?? "nano";
  const AGENT_KIND_BINARY_DEFAULTS: Record<string, string> = { "claude-code": "claude", "nano": "nano" };
  const binary = agentConfig?.binary ?? AGENT_KIND_BINARY_DEFAULTS[agentKind] ?? "nano";

  tracker.recordEvent(issueId, "started", `Attempt ${attempt} started`, {
    attempt,
    agent_kind: agentKind,
    agent_binary: binary,
    agent_overridden: issue.agent_kind != null,
  });

  let spawnResult: SpawnResult | null = null;
  try {
    spawnResult = await spawn({
      issueId,
      attempt,
      workspace: wsPath,
      prompt,
      token,
      mcpUrl,
      binary,
      timeoutMs,
      agentKind,
      extraEnv: agentConfig?.extra_env,
      logger,
      onStreamEvent: (ev) => {
        tracker.recordEvent(issueId, ev.kind, ev.message, ev.payload);
      },
      // S9: Persist the agent PID so crash-restart can kill orphaned processes.
      onPidAssigned: (pid) => {
        tracker.updateAgentPid(issueId, pid);
      },
    });
  } catch (err) {
    logger.error({ err, issueId }, "Agent spawn error");
    tracker.recordEvent(issueId, "error", `Agent error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // S9: Clear persisted PID — process has exited (or failed to start).
    tracker.updateAgentPid(issueId, null);
  }

  const resultPayload: AgentResultSummary | null = spawnResult?.agentResult ?? null;

  const patch = spawnResult?.artifacts?.patch ?? null;
  if (patch) {
    tracker.recordPatch(issueId, attempt, patch);
    tracker.recordEvent(issueId, "patch_collected", `patch length: ${patch.length}`, {
      bytes: patch.length,
    });
  }

  try {
    if (hooks?.after_run) {
      await runHook(hooks.after_run, hookEnv);
    }
  } catch (err) {
    logger.warn({ err, issueId }, "after_run hook failed");
  }

  // Non-blocking artifact collection
  try {
    const { collectAllArtifacts } = await import("./artifact-collector.ts");
    const collected = await collectAllArtifacts({ issueId, attempt, workspacePath: wsPath, tracker });
    if (collected > 0) {
      tracker.recordEvent(issueId, "artifacts_collected", `Collected ${collected} artifact(s)`, { count: collected, attempt });
    }
  } catch (err) {
    logger.warn({ err, issueId }, "Artifact collection failed (non-fatal)");
  }

  const { semantics: derivedSemantics, summary, blockerFingerprint: derivedFingerprint, terminationCause } =
    deriveCompletion(spawnResult, resultPayload);

  let semantics = derivedSemantics;
  let blockerFingerprint = derivedFingerprint;

  // Override semantics from session_completed MCP tool call if present.
  // S4: Before accepting the override, validate that it is consistent with the
  // process outcome to prevent agents from claiming success after a non-zero exit.
  // Neutral intents (handoff, needs_retry) are accepted unconditionally.
  // Reporting success requires either a zero exit code or an absent exit code.
  const sessionCompletedEvent = tracker.getLatestEventByKind(issueId, "session_completed");
  if (sessionCompletedEvent?.payload_json) {
    try {
      const scPayload = JSON.parse(sessionCompletedEvent.payload_json);
      if (scPayload.semantics) {
        const proposedSemantics: string = scPayload.semantics;
        const exitCode = spawnResult?.exitCode ?? null;
        const isNonZeroExit = exitCode !== null && exitCode !== 0;

        // Reject "success" claim when process exited non-zero (agent crash/error).
        if (proposedSemantics === "success" && isNonZeroExit) {
          tracker.recordEvent(issueId, "semantics_override_rejected",
            `session_completed claimed success but process exited with code ${exitCode}; using derived semantics`,
            { proposed: proposedSemantics, derived: semantics, exit_code: exitCode, attempt }
          );
          // Keep derived semantics — do not apply the override.
        } else {
          semantics = proposedSemantics;
          if (scPayload.blocker_fingerprint) {
            blockerFingerprint = scPayload.blocker_fingerprint;
          }
        }
      }
    } catch {
      // ignore malformed payload
    }
  }

	  if (terminationCause === "no_result_payload") {
	    tracker.recordEvent(issueId, "no_result_payload", summary ?? "no result payload", { attempt });
	  }

	  // Capture for run log
	  finalSemantics = semantics;
	  finalBlockerFingerprint = blockerFingerprint ?? null;
	  finalTerminationCause = terminationCause ?? null;

	  // Record goal_state_observed event if payload contains goal_state
	  if (resultPayload?.goal_state) {
	    tracker.recordEvent(issueId, "goal_state_observed",
	      resultPayload.goal_state.last_reason ?? "(no reason)",
	      resultPayload.goal_state);
	  }

	  // Record token stats from agent's authoritative counter (payload.tokens).
	  if (resultPayload?.tokens) {
	    const { input, output } = resultPayload.tokens;
	    if (input != null && output != null) {
	      tracker.updateTokenStats(issueId, input, output, input + output);
	      finalTokens = { input, output, total: input + output };
	    }
	  }

	  // Record sandbox_observed event if payload contains sandbox metadata
	  if (resultPayload?.sandbox) {
	    const sandboxInfo = resultPayload.sandbox;
	    tracker.recordEvent(
	      issueId,
	      "sandbox_observed",
	      `${sandboxInfo.backend ?? "unknown"}`,
	      sandboxInfo
	    );
	  }

	  // Record blocked_commands_sample event if agent reported blocked commands
	  if (resultPayload?.blocked_commands_sample?.length) {
	    tracker.recordEvent(issueId, "agent_blocked_commands",
	      `Agent blocked on ${resultPayload.blocked_commands_sample.length} command(s): ${resultPayload.blocked_commands_sample.slice(0, 3).join(", ")}`,
	      { commands: resultPayload.blocked_commands_sample, attempt });
	  }

	  const retryConfig = workflow.workflow.retry;
  const base = retryConfig?.base_delay_ms ?? 5_000;
  const maxBackoff = retryConfig?.max_delay_ms ?? 300_000;
  const maxRetries = agentConfig?.max_retries ?? 3;

  // State transition logic
  const transitions = workflow.workflow.state_transitions ?? {};
  let targetState: string | null = (transitions as Record<string, string | null>)[semantics] ?? null;

  // Wrap all state transition writes in a transaction to ensure atomicity.
  // If any write fails, all are rolled back — prevents partial state (e.g.
  // state=done but no corresponding released run row).
  tracker.withTransaction(() => {
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
	  } else if (semantics === "handoff") {
	    tracker.updateLastBlockerFingerprint(issueId, null);
	    tracker.releaseIssue(issueId, finalState);
	    tracker.updateLastIssueState(issueId, finalState);
	    finalTargetState = finalState;
	    tracker.recordEvent(issueId, "handoff", summary ?? "Agent handed off", { target_state: finalState });
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
	  } else {
	    // Abandoned or max retries exceeded
	    tracker.releaseIssue(issueId, "released");
	    tracker.updateLastIssueState(issueId, finalState);
	    finalTargetState = finalState;
	    tracker.recordEvent(issueId, "abandoned", summary ?? "Agent abandoned or max retries exceeded", { target_state: finalState });
	  }
  });

  revokeToken(token);

  logger.info({ issueId, semantics, attempt, agent_kind: agentKind }, "Worker completed");
  } finally {
    // Ensure issue is released if worker throws unexpectedly.
    // Normal completion paths already call releaseIssue inside the transaction.
    const currentRun = tracker.getRun(issueId);
    if (currentRun && currentRun.last_state === "claimed") {
      tracker.releaseIssue(issueId, "released");
    }

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
