import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";
import { ensureWorkspace, runHook } from "../workspace/manager.ts";
import { renderPrompt } from "../prompt/renderer.ts";
import { issueToken, revokeToken } from "../mcp/auth.ts";
import { spawnAgent } from "../spawner/index.ts";
import type { SpawnResult } from "../spawner/index.ts";
import { getAdapter } from "../spawner/agent-adapter.ts";
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
 * Resolves sandbox config and permission mode from workflow + per-issue overrides.
 * Exported for unit testing. Called internally by runWorker.
 */
export function resolveSandboxAndPermission(
  agentKind: "nano" | "claude-code",
  issue: {
    sandbox_mode?: "default" | "off" | null;
    sandbox_extra_writable_paths?: string[];
    sandbox_extra_read_only_paths?: string[];
    sandbox_extra_denied_paths?: string[];
    permission_mode_override?: string | null;
  },
  agentConfig: Workflow["agent"] | undefined,
): {
  sandboxConfig: {
    backend: "native" | "docker" | "none";
    network_access: boolean;
    extra_read_only_paths: string[];
    extra_writable_paths: string[];
    extra_denied_paths: string[];
    docker_image?: string;
    docker_runtime?: string;
  };
  permissionMode: string | undefined;
  permissionFloored: { from: string; to: string } | null;
} {
  const perIssueOff = issue.sandbox_mode === "off";
  const perIssueWritable = issue.sandbox_extra_writable_paths ?? [];
  const perIssueReadOnly = issue.sandbox_extra_read_only_paths ?? [];
  const perIssueDenied = issue.sandbox_extra_denied_paths ?? [];

  const wfSandbox = agentConfig?.sandbox ?? {
    backend: "native" as const,
    network_access: true,
    extra_read_only_paths: [] as string[],
    extra_writable_paths: [] as string[],
    extra_denied_paths: [] as string[],
    docker_image: undefined as string | undefined,
    docker_runtime: undefined as string | undefined,
  };

  const sandboxConfig = {
    backend: perIssueOff ? ("none" as const) : wfSandbox.backend,
    network_access: wfSandbox.network_access,
    extra_read_only_paths: [
      ...(wfSandbox.extra_read_only_paths ?? []),
      ...perIssueReadOnly,
    ],
    extra_writable_paths: [
      ...(wfSandbox.extra_writable_paths ?? []),
      ...perIssueWritable,
    ],
    extra_denied_paths: [
      ...(wfSandbox.extra_denied_paths ?? []),
      ...perIssueDenied,
    ],
    docker_image: wfSandbox.docker_image,
    docker_runtime: wfSandbox.docker_runtime,
  };

  // Resolve permission mode: per-issue override takes precedence over workflow config
  const adapter = getAdapter(agentKind);
  let resolvedPermissionMode: string | undefined = issue.permission_mode_override
    ? issue.permission_mode_override
    : (adapter.resolvePermissionMode
        ? adapter.resolvePermissionMode(agentConfig)
        : agentConfig?.permission_mode);

  // Apply permission-mode floor via adapter hook (if available)
  const sandboxOff = sandboxConfig.backend === "none";
  let permissionFloored: { from: string; to: string } | null = null;

  if (adapter.applyPermissionFloor) {
    const result = adapter.applyPermissionFloor({ resolvedPermissionMode, sandboxOff, agentConfig });
    resolvedPermissionMode = result.resolvedPermissionMode;
    permissionFloored = result.floored;
  }

  return { sandboxConfig, permissionMode: resolvedPermissionMode, permissionFloored };
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
    const result = await renderPrompt(workflow.template, { issue, attempt }, {
      goal: workflow.workflow.goal,
      tracker,
      issueId,
    });
    prompt = result.text;

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

  const token = issueToken(issueId, attempt);

  // Mark current attempt before spawning agent so frontend can subscribe to correct log
  tracker.markCurrentAttempt(issueId, attempt);

  // Record prompt summary for debugging
  tracker.recordEvent(issueId, "prompt_rendered", `Prompt rendered (${prompt.length} chars): ${prompt.slice(0, 200)}…`, {
    attempt,
    prompt_length: prompt.length,
  });

  const agentConfig = workflow.workflow.agent;
  const timeoutMs = agentConfig?.timeout_ms ?? 3_600_000;
  const agentKind: "nano" | "claude-code" =
    issue.agent_kind ?? agentConfig?.kind ?? "nano";
  const kindDefault = agentKind === "claude-code" ? "claude" : "nano";
  const binary =
    issue.agent_binary ?? (issue.agent_kind === null || issue.agent_kind === undefined ? agentConfig?.binary : undefined) ?? kindDefault;

  tracker.recordEvent(issueId, "started", `Attempt ${attempt} started`, {
    attempt,
    agent_kind: agentKind,
    agent_binary: binary,
    agent_overridden: issue.agent_kind != null || issue.agent_binary != null,
  });

  // Per-issue overrides (sandbox_mode + sandbox_extra_writable_paths) are
  // scoped to nano. Claude-code's per-issue UX is intentionally not in v0.7.
  const { sandboxConfig, permissionMode: resolvedPermissionMode, permissionFloored } =
    resolveSandboxAndPermission(agentKind, issue, agentConfig);

  if (permissionFloored) {
    tracker.recordEvent(issueId, "sandbox_permission_floor",
      `sandbox=off forced permission_mode ${permissionFloored.from} -> ${permissionFloored.to}`,
      { from: permissionFloored.from, to: permissionFloored.to });
    logger.warn({ issueId, from: permissionFloored.from, to: permissionFloored.to },
      "sandbox off: floored permission_mode");
  }

  const permissionMode = resolvedPermissionMode;
  const permissionAuto = agentConfig?.permission_auto;

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
      sandboxConfig,
      permissionMode,
      permissionAuto,
      logger,
      onStreamEvent: (ev) => {
        tracker.recordEvent(issueId, ev.kind, ev.message, ev.payload);
      },
    });
  } catch (err) {
    logger.error({ err, issueId }, "Agent spawn error");
    tracker.recordEvent(issueId, "error", `Agent error: ${err instanceof Error ? err.message : String(err)}`);
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
  // This allows agents to express intent (e.g. "handoff") that isn't in the stdout schema.
  const sessionCompletedEvent = tracker.getEvents()
    .filter((e) => e.issue_id === issueId && e.kind === "session_completed")
    .pop();
  if (sessionCompletedEvent?.payload_json) {
    try {
      const scPayload = JSON.parse(sessionCompletedEvent.payload_json);
	      if (scPayload.semantics) {
	        semantics = scPayload.semantics;
	        if (scPayload.blocker_fingerprint) {
	          blockerFingerprint = scPayload.blocker_fingerprint;
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

	  // Suggest disabling sandbox if this run was blocked by policy and sandbox is still on
	  const blockerIndicatesSandbox = blockerFingerprint &&
	    (blockerFingerprint.includes("sandbox_denied") ||
	     blockerFingerprint.includes("blocked_by_policy") ||
	     blockerFingerprint.includes("policy"));
	  if (blockerIndicatesSandbox && issue.sandbox_mode !== "off") {
	    tracker.recordEvent(issueId, "retrigger_suggestion",
	      "Consider disabling sandbox for this issue (previous run was blocked by policy)",
	      { reason: blockerFingerprint, suggestion: "sandbox_off", attempt });
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
