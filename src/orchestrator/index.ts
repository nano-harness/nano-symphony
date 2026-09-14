import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";
import { runWorker, type WorkerContext } from "./worker.ts";
import { cancelAgent } from "../spawner/index.ts";
import { config } from "../config.ts";
import type { Logger } from "pino";
import { tickPendingPlans, tickApprovedPlans, tickFinalizedPlans, tickExpiredPlans } from "./plan-tick.ts";
import { syncParentPlanRunProgress } from "./plan-progress.ts";
import { resolveWorkspacePath } from "../workspace/manager.ts";

export class Semaphore {
  private max: number;
  private count: number;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
    this.count = max;
  }

  available(): number {
    return this.count;
  }

  active(): number {
    return this.max - this.count;
  }

  status(): { limit: number; available: number; active: number } {
    return { limit: this.max, available: this.count, active: this.active() };
  }

  setMax(newMax: number): void {
    if (newMax < 1) newMax = 1;
    const active = this.active();
    this.max = newMax;
    // Preserve currently-active slots; never make more available than the new limit allows.
    this.count = Math.max(0, newMax - active);
  }

  acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.count++;
    }
  }
}

export interface Orchestrator {
  start(): void;
  stop(): Promise<void>;
  kick(): void;
  getConcurrencyStatus(): { limit: number; available: number; active: number };
}

export interface WorkspaceConflict {
  workspace_path: string;
  conflicting_issue_uuid: string;
}

/**
 * Cross-issue mutual exclusion for external workspaces: returns the active
 * (non-released) run occupying the workspace the candidate issue points at,
 * or null when the workspace is free. The active set mirrors the run
 * lifecycle used by getActiveRuns — claimed and retry_queued runs hold their
 * workspace; released runs (normal completion, cancellation, stale release)
 * free it. Path comparison uses the same resolution as ensureWorkspace, so
 * absolute, relative, and ~/ forms of the same directory all conflict.
 */
export function findWorkspaceConflict(
  tracker: Tracker,
  issueUuid: string,
  workspaceOverride: string,
  workspaceRoot?: string,
): WorkspaceConflict | null {
  const target = resolveWorkspacePath(workspaceOverride, workspaceRoot);
  for (const active of tracker.getActiveWorkspacePaths()) {
    if (active.issue_uuid === issueUuid) continue;
    const activePath = active.run_workspace_path
      ?? (active.issue_workspace_path?.trim()
        ? resolveWorkspacePath(active.issue_workspace_path, workspaceRoot)
        : null);
    if (activePath !== null && activePath === target) {
      return { workspace_path: target, conflicting_issue_uuid: active.issue_uuid };
    }
  }
  return null;
}

// Throttle workspace_conflict_skipped events so an issue waiting on a busy
// workspace does not append a new event on every tick.
const WORKSPACE_CONFLICT_EVENT_INTERVAL_MS = 60_000;

export function recordWorkspaceConflictSkipped(tracker: Tracker, issueUuid: string, conflict: WorkspaceConflict): void {
  const last = tracker.getLatestEventByKind(issueUuid, "workspace_conflict_skipped");
  if (last && Date.now() - last.ts < WORKSPACE_CONFLICT_EVENT_INTERVAL_MS) {
    try {
      const payload = JSON.parse(last.payload_json ?? "{}") as { conflicting_issue_uuid?: string };
      if (payload.conflicting_issue_uuid === conflict.conflicting_issue_uuid) return;
    } catch {
      // Unparseable payload — fall through and record a fresh event.
    }
  }
  tracker.recordEvent(
    issueUuid,
    "workspace_conflict_skipped",
    `Dispatch deferred: workspace ${conflict.workspace_path} is in use by issue ${conflict.conflicting_issue_uuid}`,
    { workspace_path: conflict.workspace_path, conflicting_issue_uuid: conflict.conflicting_issue_uuid },
  );
}

export function createOrchestrator(
  tracker: Tracker,
  getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  logger: Logger,
): Orchestrator {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sem = new Semaphore(config.MAX_CONCURRENT_AGENTS);
  const mcpUrl = `http://localhost:${config.PORT}/mcp`;

  async function tick(): Promise<number> {
    const wf = getWorkflow();
    if (!wf) return 0;

    // Run plan sub-loops first (they update issue states that affect candidate queries)
    await tickPendingPlans(tracker, logger);
    await tickApprovedPlans(tracker, logger);
    await tickFinalizedPlans(tracker, logger);
    await tickExpiredPlans(tracker, logger);

    // Sync parent issue progress for active plan runs and complete parents when done.
    syncParentPlanRunProgress(tracker, logger);

    // Honor workflow-level concurrency limit, falling back to the env default.
    const maxConcurrent = wf.workflow.polling?.max_concurrent_agents ?? config.MAX_CONCURRENT_AGENTS;
    sem.setMax(maxConcurrent);

    const slots = sem.available();
    if (slots <= 0) return 0; // Already at capacity, skip this tick

    const now = Date.now();

    // Fetch retries first (highest priority)
    const retries = tracker.fetchDueRetries(now);

    // Calculate remaining slots after accounting for retries
    const remainingSlots = Math.max(0, slots - retries.length);

    // Only fetch candidates if we have remaining slots
    const candidates = remainingSlots > 0 ? tracker.getCandidates(remainingSlots) : [];

    const toDispatch = [
      ...retries.map((r) => ({ issueUuid: r.issue_uuid, attempt: r.next_attempt })),
      ...candidates
        .filter((c) => !retries.find((r) => r.issue_uuid === c.uuid))
        .map((c) => {
          const existingRun = tracker.getRun(c.uuid);
          const attempt = existingRun ? existingRun.next_attempt + 1 : 0;
          return { issueUuid: c.uuid, attempt };
        }),
    ].slice(0, slots);

    // Auto-release stale claimed runs before dispatching new work.
    // Use the configured heartbeat timeout so operators can tune liveness detection.
    const staleThreshold = Date.now() - config.AGENT_HEARTBEAT_TIMEOUT_MS;
    const staleRuns = tracker.fetchStaleRuns(staleThreshold);
    for (const staleRun of staleRuns) {
      // Kill any lingering agent process before releasing the run. Without this,
      // a re-claimed issue could spawn a second agent into the same workspace
      // while the original (unresponsive) process is still alive.
      const killed = cancelAgent(staleRun.issue_uuid);
      tracker.withTransaction(() => {
        tracker.releaseIssue(staleRun.issue_uuid, "released");
        tracker.recordEvent(staleRun.issue_uuid, "stale_run_detected", `Run claimed for ${staleRun.current_attempt} turns was abandoned (no heartbeat)`, { attempt: staleRun.current_attempt, agent_killed: killed });
        const issue = tracker.getIssue(staleRun.issue_uuid);
        if (issue && (issue.state === "in_progress" || issue.state === "awaiting_plan")) {
          tracker.updateIssueState(staleRun.issue_uuid, "todo");
        }
      });
      logger.warn(`Released stale run for ${staleRun.issue_uuid} (attempt ${staleRun.current_attempt}, no heartbeat)`);
    }

    for (const { issueUuid, attempt } of toDispatch) {
      const claimResult = tracker.withTransaction(() => {
        // Configure per-run heartbeat timeout so stale detection honors the env config.
        tracker.setHeartbeatTimeout(issueUuid, config.AGENT_HEARTBEAT_TIMEOUT_MS);
        // Cross-issue workspace mutual exclusion: skip candidates whose external
        // workspace_path collides with an active run. Checked inside the claim
        // transaction so it cannot race a concurrent claim on the same database.
        const wsOverride = tracker.getIssue(issueUuid)?.workspace_path?.trim();
        if (wsOverride) {
          const conflict = findWorkspaceConflict(tracker, issueUuid, wsOverride, wf.workflow.workspace?.root);
          if (conflict) return { claimed: false, conflict };
        }
        const claimed = tracker.claimIssue(issueUuid, attempt);
        // Seed heartbeat_at so the run is not considered stale before the first
        // process-level heartbeat fires (nano 30s / claude 60s).
        if (claimed) tracker.updateHeartbeat(issueUuid, Date.now());
        return { claimed, conflict: null };
      });
      if (claimResult.conflict) {
        recordWorkspaceConflictSkipped(tracker, issueUuid, claimResult.conflict);
        logger.warn(
          { issueUuid, workspacePath: claimResult.conflict.workspace_path, conflictingIssueUuid: claimResult.conflict.conflicting_issue_uuid },
          "Dispatch deferred: workspace in use by another active run",
        );
        continue;
      }
      if (!claimResult.claimed) continue; // Already claimed by another tick

      const ctx: WorkerContext = {
        tracker,
        workflow: wf,
        logger,
        mcpUrl,
      };

      void sem.acquire().then(() => {
        return runWorker(issueUuid, attempt, ctx)
          .catch((err: unknown) => {
            logger.error({ issueUuid, attempt, err }, "runWorker failed unexpectedly");
          })
          .finally(() => sem.release());
      });
    }

    return toDispatch.length;
  }

  function scheduleNext(hadWork: boolean): void {
    if (!running) return;
    // Adaptive polling: 1s if we dispatched work, ORCHESTRATOR_TICK_MS if idle
    const delay = hadWork ? 1_000 : config.ORCHESTRATOR_TICK_MS;
    timer = setTimeout(() => {
      tick().then((dispatched) => {
        scheduleNext(dispatched > 0);
      }).catch((err: unknown) => {
        logger.error({ err }, "Orchestrator tick error");
        scheduleNext(false);
      });
    }, delay);
  }

  return {
    getConcurrencyStatus() {
      return sem.status();
    },
    start() {
      running = true;
      logger.info("Orchestrator started");
      // Run first tick immediately instead of waiting ORCHESTRATOR_TICK_MS
      tick().then((dispatched) => {
        scheduleNext(dispatched > 0);
      }).catch((err: unknown) => {
        logger.error({ err }, "Orchestrator tick error");
        scheduleNext(false);
      });
    },
    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      logger.info("Orchestrator stopped");
    },
    kick() {
      if (!running) return;
      // Clear existing timer and run tick immediately
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      tick().then((dispatched) => {
        scheduleNext(dispatched > 0);
      }).catch((err: unknown) => {
        logger.error({ err }, "Orchestrator tick error");
        scheduleNext(false);
      });
    },
  };
}
