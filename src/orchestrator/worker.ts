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
import { resolveAgent } from "../agent-resolution.ts";
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

export async function runWorker(issueUuid: string, attempt: number, ctx: WorkerContext): Promise<void> {
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
    const existingRun = tracker.getRun(issueUuid);
    if (!existingRun || existingRun.last_state !== "claimed") {
      const claimed = tracker.claimIssue(issueUuid, attempt);
      if (!claimed) {
        logger.debug({ issueUuid }, "Failed to claim issue");
        return;
      }
    }

    const issue = tracker.getIssue(issueUuid);
    if (!issue) {
      tracker.releaseIssue(issueUuid, "released");
      return;
    }

  const { path: wsPath, managed } = await ensureWorkspace(
    issue.identifier,
    issue.workspace_path,
    workflow.workflow.workspace?.root,
    workflow.workflow.workspace?.git_baseline ?? true,
  );
  tracker.updateWorkspacePath(issueUuid, wsPath, managed);

  const hooks = workflow.workflow.workspace?.hooks;
  const hookEnv: Record<string, string> = {
    SYMPHONY_ISSUE_UUID: issueUuid,
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
    logger.error({ err, issueUuid }, "Hook failed");
    tracker.recordEvent(issueUuid, "error", `Hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let prompt: string;
  try {
    const result = await renderPrompt(workflow.template, { issue, attempt }, {
      goal: workflow.workflow.goal,
      tracker,
      issueUuid,
    });
    prompt = result.text;

    // Inject previous_invocations context for re-scheduled issues (plan handoff resume)
    const resumeEvent = tracker.getLatestEventByKind(issueUuid, "caller_resumed");
    if (resumeEvent) {
      const planRunsByCaller = tracker.listPlanRunsByCaller(issueUuid);
      if (planRunsByCaller.length > 0) {
        const MAX_INVOCATIONS_BYTES = 32_768;
        let xmlBlocks = planRunsByCaller.map((run, idx) => {
          const scriptExcerpt = run.script.slice(0, 200 * 80);
          return `<plan_run index="${idx}" id="${run.id}" state="${run.state}">\n` +
            `<script_excerpt><![CDATA[${scriptExcerpt}]]></script_excerpt>\n` +
            (run.result ? `<result><![CDATA[${run.result}]]></result>\n` : "") +
            `</plan_run>`;
        });

        // Truncate oldest if total size exceeds limit
        let totalBytes = xmlBlocks.reduce((s, b) => s + b.length, 0);
        let elided = 0;
        while (totalBytes > MAX_INVOCATIONS_BYTES && xmlBlocks.length > 1) {
          xmlBlocks.shift();
          elided++;
          totalBytes = xmlBlocks.reduce((s, b) => s + b.length, 0);
        }

        const elidedNote = elided > 0 ? `<elided_older_invocations count="${elided}" />\n` : "";
        const invocationsXml =
          `\n<previous_invocations>\n${elidedNote}${xmlBlocks.join("\n")}\n</previous_invocations>` +
          `\n<current_invocation>This issue was re-scheduled after a plan run completed. ` +
          `Review the plan results above and continue or emit your final result.</current_invocation>`;

        prompt = prompt + invocationsXml;
      }
    }

    // Inject output schema hint if the issue has an expected_schema
    if (issue.expected_schema) {
      const schemaHint =
        `\n<output_schema>\nCall symphony.emit_result({ data }) before symphony.session_completed. ` +
        `Your data must conform to this JSON Schema:\n${issue.expected_schema}\n</output_schema>`;
      prompt = prompt + schemaHint;
    } else {
      const resultHint =
        `\n<output_schema>\nCall symphony.emit_result({ data: "your summary here" }) ` +
        `before symphony.session_completed. Provide a concise string summary of what you accomplished (≤32KB).\n</output_schema>`;
      prompt = prompt + resultHint;
    }

    // Inject scratchpad if present
    if (issue.scratchpad) {
      prompt = prompt + `\n<scratchpad>\n${issue.scratchpad}\n</scratchpad>`;
    }

    // Record comments_injected event if comments were included
    if (result.meta.commentIds.length > 0) {
      tracker.recordEvent(issueUuid, "comments_injected", `${result.meta.commentIds.length} comments injected into prompt`, {
        attempt,
        comment_ids: result.meta.commentIds,
        count: result.meta.commentIds.length,
        truncated: result.meta.truncated,
      });
    }
  } catch (err) {
    logger.error({ err, issueUuid }, "Failed to render prompt");
    // Permanent failure (likely template typo). Record so operators see it in
    // /api/v1/events instead of only pino logs.
    const message = err instanceof Error ? err.message : String(err);
    tracker.recordEvent(issueUuid, "error", `Failed to render prompt: ${message}`, {
      stage: "render_prompt",
      error: message,
    });
    tracker.releaseIssue(issueUuid, "released");
    // Sync last_issue_state so the candidate SQL doesn't re-pick this issue
    // every tick. Operator must change issues.state to retry.
    tracker.updateLastIssueState(issueUuid, issue.state);
    return;
  }

  // Resolve agent config before token TTL calculation
  const agentConfig = workflow.workflow.agent;
  const resolved = resolveAgent(
    { kind: issue.agent_kind ?? undefined, binary: issue.agent_binary ?? undefined },
    { kind: agentConfig?.kind, binary: agentConfig?.binary, timeoutMs: agentConfig?.timeout_ms, maxRetries: agentConfig?.max_retries }
  );
  const agentKind = resolved.kind;
  const binary = resolved.binary;
  const baseTimeoutMs = resolved.timeoutMs;
  const maxRetries = resolved.maxRetries;

  // S6: Issue agent token scoped to reporting-only tools (AGENT_TOOL_SCOPE).
  // S7: Extend TTL to cover the full agent timeout plus a 10-minute buffer so
  //     tokens don't expire mid-session. Use config timeout as a fallback.
  const tokenTtlMs = baseTimeoutMs + 10 * 60 * 1000; // timeout + 10min buffer
  const token = issueToken(issueUuid, attempt, AGENT_TOOL_SCOPE, tokenTtlMs);

  // Mark current attempt before spawning agent so frontend can subscribe to correct log
  tracker.markCurrentAttempt(issueUuid, attempt);

  // Record prompt summary for debugging
  tracker.recordEvent(issueUuid, "prompt_rendered", `Prompt rendered (${prompt.length} chars): ${prompt.slice(0, 200)}…`, {
    attempt,
    prompt_length: prompt.length,
  });

  tracker.recordEvent(issueUuid, "started", `Attempt ${attempt} started`, {
    attempt,
    agent_kind: agentKind,
    agent_binary: binary,
    agent_overridden: issue.agent_kind != null,
  });

  let spawnResult: SpawnResult | null = null;
  let accTokenInput = 0;
  let accTokenOutput = 0;
  try {
    spawnResult = await spawn({
      issueUuid,
      attempt,
      workspace: wsPath,
      prompt,
      token,
      mcpUrl,
      binary,
      timeoutMs: baseTimeoutMs,
      agentKind,
      extraEnv: agentConfig?.extra_env,
      agentConfig: {
        permission_mode: agentConfig?.permission_mode,
        permissions: agentConfig?.permissions,
        sandbox: agentConfig?.sandbox,
        trusted_binaries: agentConfig?.trusted_binaries,
        hooks: agentConfig?.hooks,
      },
      logger,
      onStreamEvent: (ev) => {
        if (ev.kind === "token_stats") {
          if (ev.payload) {
            const p = ev.payload as Record<string, unknown>;
            accTokenInput += Number(p.input ?? 0);
            accTokenOutput += Number(p.output ?? 0);
          }
          return; // 不写入 DB
        }
        if (ev.kind === "assistant_chunk") return; // 不写入 DB
        tracker.recordEvent(issueUuid, ev.kind, ev.message, ev.payload);
      },
      // S9: Persist the agent PID so crash-restart can kill orphaned processes.
      onPidAssigned: (pid) => {
        tracker.updateAgentPid(issueUuid, pid);
      },
    });
  } catch (err) {
    logger.error({ err, issueUuid }, "Agent spawn error");
    tracker.recordEvent(issueUuid, "error", `Agent error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // S9: Clear persisted PID — process has exited (or failed to start).
    tracker.updateAgentPid(issueUuid, null);
  }

  const resultPayload: AgentResultSummary | null = spawnResult?.agentResult ?? null;

  const patch = spawnResult?.artifacts?.patch ?? null;
  if (patch) {
    tracker.recordPatch(issueUuid, attempt, patch);
    tracker.recordEvent(issueUuid, "patch_collected", `patch length: ${patch.length}`, {
      bytes: patch.length,
    });
  }

  try {
    if (hooks?.after_run) {
      await runHook(hooks.after_run, hookEnv);
    }
  } catch (err) {
    logger.warn({ err, issueUuid }, "after_run hook failed");
  }

  // Non-blocking artifact collection
  try {
    const { collectAllArtifacts } = await import("./artifact-collector.ts");
    const collected = await collectAllArtifacts({ issueUuid, attempt, workspacePath: wsPath, tracker });
    if (collected > 0) {
      tracker.recordEvent(issueUuid, "artifacts_collected", `Collected ${collected} artifact(s)`, { count: collected, attempt });
    }
  } catch (err) {
    logger.warn({ err, issueUuid }, "Artifact collection failed (non-fatal)");
  }

  const { semantics: derivedSemantics, summary: derivedSummary, blockerFingerprint: derivedFingerprint, terminationCause } =
    deriveCompletion(spawnResult, resultPayload);

  let semantics = derivedSemantics;
  let blockerFingerprint = derivedFingerprint;
  let summary = derivedSummary;

  // Override semantics from session_completed MCP tool call if present.
  // S4: Before accepting the override, validate that it is consistent with the
  // process outcome to prevent agents from claiming success after a non-zero exit.
  // Neutral intents (handoff, needs_retry) are accepted unconditionally.
  // Reporting success requires either a zero exit code or an absent exit code.
  const sessionCompletedEvent = tracker.getLatestEventByKind(issueUuid, "session_completed");
  if (sessionCompletedEvent?.payload_json) {
    try {
      const scPayload = JSON.parse(sessionCompletedEvent.payload_json);
      if (scPayload.semantics) {
        const proposedSemantics: string = scPayload.semantics;
        const exitCode = spawnResult?.exitCode ?? null;
        const isNonZeroExit = exitCode !== null && exitCode !== 0;

        // Reject "success" claim when process exited non-zero (agent crash/error).
        if (proposedSemantics === "success" && isNonZeroExit) {
          tracker.recordEvent(issueUuid, "semantics_override_rejected",
            `session_completed claimed success but process exited with code ${exitCode}; using derived semantics`,
            { proposed: proposedSemantics, derived: semantics, exit_code: exitCode, attempt }
          );
          // Keep derived semantics — do not apply the override.
        } else {
          semantics = proposedSemantics;
          if (scPayload.summary) {
            summary = scPayload.summary;
          } else if (terminationCause === "no_result_payload") {
            summary = undefined;
          }
          if (scPayload.blocker_fingerprint) {
            blockerFingerprint = scPayload.blocker_fingerprint;
          }
        }
      }
    } catch {
      // ignore malformed payload
    }
  }

  // Fallback: if agent called emit_result (validated=1) but never called session_completed,
  // treat as success to avoid abandoned → cancelled waste.
  if (semantics === "abandoned" && terminationCause === "no_result_payload" && !sessionCompletedEvent) {
    const resultEmittedEvent = tracker.getLatestEventByKind(issueUuid, "result_emitted");
    if (resultEmittedEvent?.payload_json) {
      try {
        const rePayload = JSON.parse(resultEmittedEvent.payload_json);
        if (rePayload.validated === 1 || rePayload.validated === true) {
          semantics = "success";
          summary = undefined;
          tracker.recordEvent(issueUuid, "semantics_fallback_result_emitted",
            "No session_completed but result_emitted with validated=1; treating as success",
            { attempt });
        }
      } catch { /* ignore */ }
    }
  }

	  if (terminationCause === "no_result_payload" && semantics !== "success") {
	    tracker.recordEvent(issueUuid, "no_result_payload", summary ?? "no result payload", { attempt });
	  }

	  // Capture for run log
	  finalSemantics = semantics;
	  finalBlockerFingerprint = blockerFingerprint ?? null;
	  finalTerminationCause = terminationCause ?? null;

	  // Record goal_state_observed event if payload contains goal_state
	  if (resultPayload?.goal_state) {
	    tracker.recordEvent(issueUuid, "goal_state_observed",
	      resultPayload.goal_state.last_reason ?? "(no reason)",
	      resultPayload.goal_state);
	  }

	  // Record token stats from agent's authoritative counter (payload.tokens).
	  if (resultPayload?.tokens) {
	    const { input, output } = resultPayload.tokens;
	    if (input != null && output != null) {
	      tracker.updateTokenStats(issueUuid, input, output, input + output);
	      finalTokens = { input, output, total: input + output };
	    }
	  }

	  // Fallback: if payload has no tokens but streaming accumulated them, use accumulator.
	  if (!finalTokens && (accTokenInput > 0 || accTokenOutput > 0)) {
	    tracker.updateTokenStats(issueUuid, accTokenInput, accTokenOutput, accTokenInput + accTokenOutput);
	    finalTokens = { input: accTokenInput, output: accTokenOutput, total: accTokenInput + accTokenOutput };
	  }

	  // Record sandbox_observed event if payload contains sandbox metadata
	  if (resultPayload?.sandbox) {
	    const sandboxInfo = resultPayload.sandbox;
	    tracker.recordEvent(
	      issueUuid,
	      "sandbox_observed",
	      `${sandboxInfo.backend ?? "unknown"}`,
	      sandboxInfo
	    );
	  }

	  // Record blocked_commands_sample event if agent reported blocked commands
	  if (resultPayload?.blocked_commands_sample?.length) {
	    tracker.recordEvent(issueUuid, "agent_blocked_commands",
	      `Agent blocked on ${resultPayload.blocked_commands_sample.length} command(s): ${resultPayload.blocked_commands_sample.slice(0, 3).join(", ")}`,
	      { commands: resultPayload.blocked_commands_sample, attempt });
	  }

	  const retryConfig = workflow.workflow.retry;
  const base = retryConfig?.base_delay_ms ?? 5_000;
  const maxBackoff = retryConfig?.max_delay_ms ?? 300_000;

  // State transition logic
  const transitions = workflow.workflow.state_transitions ?? {};
  let targetState: string | null = (transitions as Record<string, string | null>)[semantics] ?? null;

  // Planning guard: if issue was in planning state but agent never submitted a plan,
  // override semantics to needs_retry so the issue gets re-scheduled for planning.
  if (issue.state === "planning") {
    const planSubmitted = tracker.getLatestEventByKind(issueUuid, "plan_submitted");
    if (!planSubmitted && semantics === "success") {
      semantics = "needs_retry";
      summary = "Agent completed without submitting a plan — retrying planning";
      blockerFingerprint = "planning_no_plan_submitted";
      targetState = null; // Keep in planning state for retry
      tracker.recordEvent(issueUuid, "planning_guard", summary, { attempt });
    }
  }

  // Plan review guard: if agent submitted a plan during this run, the state is now plan_review.
  // Do not transition away from plan_review — let the UI control it.
  const currentIssue = tracker.getIssue(issueUuid);
  if (currentIssue && currentIssue.state === "plan_review") {
    semantics = "handoff";
    targetState = "plan_review";
    summary = summary ?? "Plan submitted for review";
  }

  // Wrap all state transition writes in a transaction to ensure atomicity.
  // If any write fails, all are rolled back — prevents partial state (e.g.
  // state=done but no corresponding released run row).
  tracker.withTransaction(() => {
	  // 关键顺序：先 updateIssueState（改 issues.state），再 updateLastIssueState（同步到新值）
	  // 否则 last_issue_state(旧) != issues.state(新)，会被 candidate SQL 重新拾起
	  if (targetState && targetState !== issue.state) {
	    tracker.updateIssueState(issueUuid, targetState);
    }
    const finalState = targetState ?? issue.state;

    if (semantics === "success") {
      tracker.updateLastBlockerFingerprint(issueUuid, null);
      tracker.releaseIssue(issueUuid, "released");
      tracker.updateLastIssueState(issueUuid, finalState);
      finalTargetState = finalState;
      tracker.recordEvent(issueUuid, "completed", summary ?? "Agent completed successfully", { target_state: finalState });
	  } else if (semantics === "handoff") {
	    tracker.updateLastBlockerFingerprint(issueUuid, null);
	    tracker.releaseIssue(issueUuid, finalState);
	    tracker.updateLastIssueState(issueUuid, finalState);
	    finalTargetState = finalState;
	    tracker.recordEvent(issueUuid, "handoff", summary ?? "Agent handed off", { target_state: finalState });
	  } else if (semantics === "needs_retry" && attempt < maxRetries) {
	    // Same-cause short-circuit: if same fingerprint repeats and we've seen it before, skip retry
	    const currentFingerprint = blockerFingerprint ?? "";
	    const prevFingerprint = tracker.getLastBlockerFingerprint(issueUuid);

      if (currentFingerprint && currentFingerprint === prevFingerprint && attempt >= 1) {
        // Short-circuit to blocked state
        const blockedState = transitions.blocked
          ?? transitions.abandoned
          ?? "blocked";

        if (blockedState !== issue.state) {
          tracker.updateIssueState(issueUuid, blockedState);
        }

        tracker.releaseIssue(issueUuid, "released");
        tracker.updateLastIssueState(issueUuid, blockedState);
        finalTargetState = blockedState;
        finalSemantics = "abandoned"; // Short-circuit is effectively abandoned
        finalTerminationCause = "shortcircuit_same_cause";
        tracker.recordEvent(issueUuid, "shortcircuit_same_cause",
          `Same blocker repeated across attempts ${attempt} and ${attempt + 1}: ${currentFingerprint}`,
          { fingerprint: currentFingerprint, attempt, prev_attempt: attempt });
      } else {
        // Normal retry path
        const delay = calculateBackoff(attempt, base, maxBackoff);
        const nextDue = Date.now() + delay;

        // Persist fingerprint for next attempt comparison
        if (currentFingerprint) {
          tracker.updateLastBlockerFingerprint(issueUuid, currentFingerprint);
        }

        tracker.scheduleRetry(issueUuid, nextDue, attempt + 1);
        finalTargetState = issue.state; // State doesn't change on retry
        tracker.recordEvent(issueUuid, "retry_scheduled", `Retry scheduled in ${delay}ms`, { delay, attempt: attempt + 1 });
      }
	  } else {
	    // Abandoned or max retries exceeded
	    // Fallback: if needs_retry but no transition defined, map to abandoned → cancelled
	    if (!targetState && semantics === "needs_retry") {
	      targetState = (transitions as Record<string, string | null>)["abandoned"] ?? "cancelled";
	      if (targetState !== issue.state) {
	        tracker.updateIssueState(issueUuid, targetState);
	      }
	    }
	    tracker.releaseIssue(issueUuid, "released");
	    tracker.updateLastIssueState(issueUuid, finalState);
	    finalTargetState = finalState;
	    tracker.recordEvent(issueUuid, "abandoned", summary ?? "Agent abandoned or max retries exceeded", { target_state: finalState });
	  }
  });

  revokeToken(token);

  logger.info({ issueUuid, semantics, attempt, agent_kind: agentKind }, "Worker completed");
  } finally {
    // Ensure issue is released if worker throws unexpectedly.
    // Normal completion paths already call releaseIssue inside the transaction.
    const currentRun = tracker.getRun(issueUuid);
    if (currentRun && currentRun.last_state === "claimed") {
      tracker.releaseIssue(issueUuid, "released");
    }

    // Always write run log, even if worker throws
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;
    const issue = tracker.getIssue(issueUuid);

    if (issue) {
      const success = finalSemantics === "success" || finalSemantics === "handoff";
      const eventsUrl = `/api/v1/issues/${issueUuid}/events`;

      await appendRunLog({
        schema_version: 1,
        issue_uuid: issueUuid,
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