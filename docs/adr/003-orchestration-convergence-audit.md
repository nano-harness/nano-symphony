# ADR 003: Orchestration Convergence Audit — Single-Writer Dispatch and Compressed Sub-Agent Results

[中文](./003-orchestration-convergence-audit.zh-CN.md)

## Status

Accepted

## Context

Orchestration frameworks for coding agents converged on a consistent shape:
the orchestrator holds the full context and the plan; sub-agents run in
isolation, are mostly read-only against shared state, and return compressed
summaries instead of full trajectories; writes to shared state stay
single-threaded. This ADR records an audit of `src/orchestrator/` and
`src/spawner/` against that shape, the gaps it found and fixed across two
rounds, and the gaps that are documented but deliberately not addressed.

nano-symphony sits in the "loop engineering" layer above the agent harness
(see README, "Positioning"): it schedules runs, feeds work, checks results,
and decides the next step. The audit questions were:

1. Can two workers write to the same issue or workspace concurrently?
2. Do sub-agents return full trajectories or compressed summaries?

## Audit findings

### Conformant behavior

- **Single-writer per issue, enforced in the database.** `symphony_runs` has
  one row per issue (`issue_uuid PRIMARY KEY`), and `claimIssue`
  (`src/db/tracker-runs.ts`) is an atomic `INSERT ... ON CONFLICT ... WHERE
  last_state IN ('released', 'retry_queued')`. A second claim — from another
  tick, a manual retrigger, or a second symphony process sharing the same
  database — affects zero rows and is rejected. Retries are deduplicated
  against fresh candidates inside the same tick (`src/orchestrator/index.ts`).
- **Atomic completion.** The terminal state transition, run release, and
  event record are wrapped in a single transaction in
  `src/orchestrator/worker.ts`; a crash mid-transition cannot leave an issue
  half-updated.
- **Orchestrator holds the context.** The prompt is assembled by the worker
  from the issue, its comments, scratchpad, prior plan invocations, and the
  workflow template — not by the agent. Agents fetch their assigned work
  through scoped MCP tools instead of reading the database.
- **Sub-agent isolation.** Each issue runs in its own workspace
  (`workspaces/<identifier>` or an explicit `workspace_path`), inside a
  process sandbox (bubblewrap / sandbox-exec), with an agent token scoped to
  reporting-only tools (`AGENT_TOOL_SCOPE`). Control-plane credentials are
  stripped from the agent environment.
- **Compressed summaries, not trajectories.** Sub-agents report an
  `AgentResultSummary` (`src/spawner/agent-result-payload.ts`): a status
  (`success` / `needs_retry` / `abandoned` / `timeout`), a short reason, goal
  state, token counts, and small diagnostic samples. Full stdout goes to a
  per-attempt log file; only discrete events are written to the database. The
  worker cross-validates claimed success against the process exit code and
  rejects inconsistent reports.
- **Plan runs are single-executed.** `src/orchestrator/plan-tick.ts` keeps an
  in-process `inFlight` set so a plan run is never dry-run or executed twice
  concurrently, and sub-issue token budgets are enforced by the plan executor
  across the whole run.

### Gap found and fixed in this round

- **Stale-run release did not kill the lingering agent process.** When a
  claimed run stopped heartbeating, the tick released it so the issue could
  be re-dispatched — but if the agent process was still alive (e.g. wedged
  after the spawner-side heartbeat timer stopped), the re-claim could spawn a
  *second* agent into the same workspace while the first was still running:
  two concurrent writers on one workspace. The tick now calls
  `cancelAgent(issueUuid)` before releasing a stale run
  (`src/orchestrator/index.ts`), and records `agent_killed` in the
  `stale_run_detected` event payload.

### Gap fixed in the follow-up round

- **Shared external workspaces had no cross-issue mutual exclusion.** Two
  issues could point at the same `workspace_path` and be dispatched in
  parallel, producing two writers on one directory. The dispatch loop now
  runs a workspace-conflict guard inside the claim transaction
  (`findWorkspaceConflict` in `src/orchestrator/index.ts`): before claiming a
  candidate whose issue sets an external `workspace_path`, the path is
  resolved exactly the way `ensureWorkspace` resolves it (absolute, relative,
  and `~` forms compare equal) and matched against the workspaces of all
  active runs (`tracker.getActiveWorkspacePaths` in `src/db/tracker-runs.ts`).
  The active set mirrors the run lifecycle — `claimed` and `retry_queued`
  runs hold their workspace (a run that has been claimed but whose worker has
  not started yet still holds it via the issue's `workspace_path`), while
  `released` runs free it, so the stale-release path unblocks waiting issues
  on the next tick. On conflict the candidate is skipped for this tick — no
  claim, no error — and a throttled `workspace_conflict_skipped` event
  (at most one per minute per conflicting issue) records the workspace and
  the conflicting issue UUID. No schema change: the guard is a read-only
  query over `symphony_runs` joined with `issues`. Issues without
  `workspace_path` are unaffected.

### Gaps documented but not addressed (high-risk or large changes)
- **Worker completion after a stale release.** If a stale-released worker
  later finishes, its completion transaction can still apply a state
  transition to an issue that has since been re-claimed. The window is narrow
  (the agent process is now killed on stale release) and the transition is
  derived from a real process outcome, so we accept it for now rather than
  introducing fencing tokens on claims.
- **Plan-runtime sub-issue parallelism.** The plan executor may run
  independent sub-issues in parallel batches; each still goes through the
  same single-writer claim path, so this is conformant, but global write
  serialization across *workspaces* remains the operator's responsibility.

## Decision

1. Keep the database-enforced single-writer claim as the sole dispatch
   mutex; do not add application-level locks.
2. Kill the agent process whenever a stale run is released (implemented in
   this round).
3. Keep the compressed `AgentResultSummary` contract as the only channel for
   sub-agent outcomes; trajectories stay in log files, not in the database.
4. Enforce cross-issue mutual exclusion on external workspaces with a
   query-based guard inside the claim transaction (implemented in the
   follow-up round); no lock table, no schema change. Defer claim fencing;
   revisit if multi-writer workspace sharing becomes a supported feature.

## Consequences

### Positive

- The single-writer guarantee survives restarts and even multiple symphony
  processes on one database, because it lives in SQLite, not in memory.
- A re-dispatched issue can no longer meet a zombie agent still writing to
  its workspace.
- Two issues configured with the same external `workspace_path` can no
  longer run concurrently; the later one waits and its deferral is visible
  as a `workspace_conflict_skipped` event.
- Control-plane state stays small and queryable; heavy output stays on disk.

### Negative

- `cancelAgent` uses SIGTERM with a 3-second SIGKILL escalation; a process
  that ignores both (unkillable state, NFS hang) can still outlive the
  release. This is a best-effort mitigation, not a hard guarantee.
- The workspace guard compares resolved path strings, so aliasing the same
  directory through symlinks or bind mounts is not detected; the guard is
  also advisory across processes that do not share the same SQLite
  database.

## Related Documents

- `src/orchestrator/index.ts`, `src/orchestrator/worker.ts`
- `src/db/tracker-runs.ts`
- `src/spawner/agent-result-payload.ts`
- `docs/standards/agent-exit-contract.md`
- `docs/metrics-cost-and-reliability.md`
- `tests/unit/heartbeat-stale.test.ts`, `tests/unit/concurrency.test.ts`
- `tests/unit/workspace-mutex.test.ts`, `tests/integration/dispatch.test.ts`
