# Changelog

[中文](./CHANGELOG.zh-CN.md)

All notable changes to nano-symphony will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.6] - 2026-06-23

### Added
- **Structured event timeline**: `frontend/src/EventTimeline.tsx` groups `tool_call`/`tool_result` pairs, shows attempt separators, and highlights deltas >10s (warm) and >30s (hot).
- **Claude Code tool_result events**: `src/spawner/adapters/claude-code.ts` now parses `tool_result` stream-json lines so the dashboard shows complete tool call pairs.
- **Regression tests**: `tests/unit/install-wrapper.test.ts`, `tests/unit/claude-code-adapter.test.ts`, and `frontend/src/__tests__/EventTimeline.vitest.tsx`.

### Fixed
- **Wrapper `report-event --kind`**: the generated `symphony` wrapper now accepts both `--kind progress` and `--kind=progress` (and the same for `--message`, `--payload-json`).
- **`emit-result` structured data**: `--data-json` values that are already valid JSON are embedded directly instead of being double-stringified; plain text still falls back to JSON-string wrapping.
- **`Abort trap: 6` stderr noise**: `print_json` now uses `python3 -m json.tool` instead of a `node -e` pipeline that produced SIGABRT chatter.
- **`emit_result` server error handling**: malformed stored `expected_schema` no longer triggers a raw 500; the handler returns a clear validation error.
- **IssueDetail live refresh**: SSE now refreshes issue/run state for all substantive events, not just `retrigger_requested`.

### Changed
- **WORKFLOW template**: `templates/WORKFLOW.example.md` and `WORKFLOW.md` now include a `## Mandatory startup sequence` that requires `symphony fetch-issue` as the first action.
- **Skill docs**: `skills/nano-symphony/SKILL.md` documents the fixed `report-event` syntax, `emit-result` JSON-object support, and the mandatory startup sequence.

## [0.9.5] - 2026-06-16

### Added
- **Community files**: `AGENTS.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md`.
- **Regression tests**: `tests/unit/config.test.ts` covers empty `API_TOKEN`, non-loopback `HOST` without token, and empty `apiToken` option in `createHttpServer`.

### Fixed
- **HTTP auth**: `createHttpServer` now rejects an empty `apiToken` option; requests with an empty token are treated as unauthenticated instead of bypassing auth.
- **Issue identifiers**: `insertIssue` persists a generated `TASK-N` identifier to the database, and `updateIssue` preserves the existing identifier when not provided.

### Changed
- **Documentation**: `docs/WORKFLOW-INTERNALS.md`, `docs/WORKFLOW-reference.md`, and `docs/adr/001-multi-agent-roles-and-shared-contract.md` updated to reflect git-diff artifact collection and the generic nano-agent orchestrator contract.

### Breaking Changes — Schema Redesign (requires manual DB wipe before upgrade)

> ⚠️ **Action required before merging**: Run `rm ~/.local/share/nano-symphony/symphony.db` to wipe the existing database. The new schema is incompatible with the old one and no migration is provided. All subsequent server starts will initialize a clean database from the new schema.

- **`issues.id` is now `INTEGER PRIMARY KEY AUTOINCREMENT`** (was `TEXT` nanoid). The auto-increment integer is stable, race-free, and O(1).
- **`issues.uuid`** (new column): holds the former nanoid string (was `issues.id`).
- **`issues.identifier` column dropped**: computed on-the-fly as `TASK-${id}` at the application layer; never stored in the database.
- **FK columns renamed across 7 tables**: `issue_id` → `issue_uuid`, `blocker_id` → `blocker_uuid`, `caller_issue_id` → `caller_issue_uuid` (affected tables: `issue_labels`, `issue_blockers`, `symphony_runs`, `symphony_events`, `issue_comments`, `symphony_artifacts`, `issue_results`, `plan_runs`).
- **`idx_issues_identifier` index dropped** (column no longer exists).
- **HTTP API — `POST /api/v1/issues`**: Sending `id`, `identifier`, or `uuid` fields now returns `400` with an explicit error message.
- **HTTP API — URL params**: All `/api/v1/issues/:id` path parameters renamed to `/api/v1/issues/:uuid`.
- **HTTP API — GET response**: Issues now include `id` (integer) and `uuid` (nanoid string). The `identifier` field (`TASK-N`) is still present but computed.
- **Environment variable**: `SYMPHONY_ISSUE_ID` renamed to `SYMPHONY_ISSUE_UUID` in worker subprocess environments.
- **Frontend sort**: Issue list now sorts by `id` (integer) instead of `identifier` string, fixing lexicographic ordering (e.g., TASK-10 no longer sorts before TASK-2).
- **Wrapper**: `next_identifier()` function removed from `install.sh`; `symphony issue create` no longer sends an `identifier` field.

### Added
- **Bundle distribution**: `scripts/build-bundle.sh` produces a single minified `index.js` (~484 KB) bundled with `bun build --minify --target=bun`, packaged alongside `share/frontend/dist/`, `share/skills/`, `share/templates/`, and `share/VERSION` in a ~5 MB tarball.
- **`src/paths.ts`**: Centralised asset-root resolution. Reads `SYMPHONY_SHARE_ROOT` env var (set by wrapper at runtime), with a CWD fallback for bundle-layout directories, and fails hard if neither is found.
- **Global skill install**: `install.sh` now copies `share/skills/nano-symphony/` to `~/.nano/skills/nano-symphony/` and, if `~/.claude/` exists, to `~/.claude/skills/nano-symphony/` on every install/update — no per-workspace sync needed.
- **CI smoke test**: Release workflow runs `curl /api/v1/health` against the extracted bundle before publishing.

### Changed
- **`install.sh`** rewritten for bundle distribution: no more `bun install`, source-mode leftovers (`src/`, `node_modules/`, `package.json`, etc.) are cleaned up on upgrade, WORKFLOW template sourced from `share/templates/`, version read from `share/VERSION`.
- **Wrapper `start`** now runs `exec bun ${INSTALL_DIR}/index.js` with `SYMPHONY_SHARE_ROOT` set; `version` reads `share/VERSION`.
- **Release CI** pins Bun to `1.2.x` across all jobs; `build` job replaced with `scripts/build-bundle.sh`; `meta.json` gains `built_with` field.
- **`src/http/server.ts`**: static root resolved from `FRONTEND_DIST` (via `paths.ts`) instead of `SYMPHONY_STATIC_ROOT` env var.

### Removed
- **`syncSkillsIfMissing`** function removed from `src/workspace/manager.ts`; skill distribution is now handled exclusively by `install.sh` into agent-global directories.

### Breaking
- **`symphony dev | build | test | lint`** subcommands in bundle installs now exit 64 with a clear error. Source-mode development requires `SYMPHONY_SHARE_ROOT=$(pwd) bun --watch src/index.ts`.
- **`symphony version`** reads `share/VERSION` instead of `package.json`. Source installs that lack `share/VERSION` should set `SYMPHONY_SHARE_ROOT`.

### Added
- **Plan Runs**: New `plan_runs` table — agents write inline JS scripts that orchestrate sub-issue fan-out with dry-run, human approval, and structured result emission. Supports `pending → dry_running → awaiting_approval → running → done/failed/cancelled` lifecycle.
- **Issue Results**: New `issue_results` table with versioned upsert; `emit_result` stores structured output per `(issue_id, attempt, version)`.
- **MCP Tools — New**: `symphony.emit_result`, `symphony.spawn_plan_run`, `symphony.spawn_plan_run_and_handoff`, `symphony.get_artifact`, `symphony.update_issue_scratchpad`.
- **MCP Tools — session_completed**: `summary` is now optional; `metrics` field deprecated (no longer consumed).
- **Issues — New Columns**: `plan_run_id`, `expected_schema`, `scratchpad` (auto-migrated).
- **Wait States**: `awaiting_plan` wait state added; `getCandidatesStmt` excludes it from scheduling so plan-paused issues are not re-dispatched.
- **Orchestrator — Plan Sub-loops**: Four new idempotent tick loops: `tickPendingPlans` (dry-run), `tickApprovedPlans` (start execution), `tickFinalizedPlans` (resume caller), `tickExpiredPlans` (wall-time enforcement, 7-day default).
- **Plan Runtime — Sandbox**: `node:vm` sandbox with minimal injection (no `Date`, `Math.random`, `require`, `import`, `process`, `globalThis`). Deterministic globals only: `issue()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`, `list_artifacts()`, `get_artifact()`.
- **Plan Runtime — Dry-run**: Symbolic execution with `dryRunStub` generating schema-based stubs; records estimated issue count, phases, token range.
- **Plan Runtime — Crash Resume**: JSONL journal at `${SYMPHONY_DATA}/plan-runs/<id>/journal.jsonl` enables resume after process restart.
- **HTTP API — Plan Runs**: `POST /plan-runs`, `GET /plan-runs`, `GET /plan-runs/:id`, `GET /plan-runs/:id/result` (long-poll), `POST /plan-runs/:id/approve`, `POST /plan-runs/:id/reject`, `POST /plan-runs/:id/request-changes`, `DELETE /plan-runs/:id`.
- **Worker — Re-entry Prompt**: When a caller issue resumes after a plan run, the prompt injects `<previous_invocations>` (script excerpt, result, artifact index, scratchpad) and `<output_schema>`.
- **SKILL.md**: New sections "Decomposing tasks with plans" and "Submitting results with emit_result"; updated tool list; troubleshooting for plan-run issues added to local-loop SKILL.md.

### Removed
- **MCP Tools — Retired**: `symphony.create_issue`, `symphony.activate_issue`, `symphony.submit_plan`. Issue creation is now via HTTP or plan executor only. Calling these tools returns a scope error.
- **Planning Mode**: Issue `planning` and `plan_review` states removed. `agent.planning` config key deprecated (ignored). `POST /issues/:id/approve-plan` and `/revise-plan` routes removed. Slash commands `/revise` and `/skip-plan` removed.
- **Worker**: `planningPrefix` and `plan_revision` prompt injection removed.

### Added (previous)
- **Permissions**: `agent.permission_auto` now supports `allow_rules`, `denial_max_consecutive`, and `denial_max_total` (strictly validated). `allow_rules` is the only trust declaration entrypoint exposed by symphony.
- **Binary Result Delivery**: nano-agent binary sessions report results via `.nano.yaml.hooks.Stop` to a workspace-scoped `result-hook.sh`, which POSTs to `POST /agent-result` (no stdout sentinel parsing).
- **Sandbox**: Spawner injects `sandbox.denied_write_paths: ["~/.config/nano"]` for native sandbox backends to prevent user config layer writes.
- **Observability**: Orchestrator attempt outputs to symphony-owned `./run_log.jsonl` (path configurable via `RUN_LOG_PATH`; toggle via `RUN_LOG_ENABLED`). Does not write to nano-agent's `~/.nano/task_log.jsonl`.
- **MCP**: `symphony.session_completed` accepts `blocker_fingerprint` and `termination_cause` parameters, enabling short-circuit logic and structured failure tracking.
- **Database**: `issues` table gains `last_blocker_fingerprint` column (auto-migrated).
- **Database**: `symphony_runs` table gains `current_attempt` column to track actively running attempt (auto-migrated).
- **Event Bus**: In-memory event bus for real-time state change notifications across SSE connections.
- **SKILL**: SKILL.md documents `blocker_fingerprint` usage and sandbox defaults.

### Fixed
- **Spawner (claude-code)**: `--allowedTools` pattern corrected from `mcp__symphony__*` to `symphony.*` so Claude Code can discover and call Symphony MCP tools (`symphony.fetch_issue`, `symphony.emit_result`, `symphony.session_completed`, etc.) directly instead of falling back to Bash/curl.
- **Orchestrator**: Freshly-claimed runs now seed `heartbeat_at` immediately, preventing false-positive stale detection before the first process-level heartbeat fires (nano 30s / claude-code 60s).
- **HTTP API**: `POST /issues` and `PUT /issues/:uuid` now accept `agent_binary`, completing the per-issue agent binary override chain from API → tracker → worker → spawner.
- **Spawner**: Agent result summary schema changed from `.strict()` to `.passthrough()` — previously `.strict()` rejected agent diagnostic fields (`termination_cause`, `cache_key`, etc.) causing valid runs to be misclassified as `no_result_payload`/`abandoned`.
- **Orchestrator**: Same blocker fingerprint ≥ 2 times auto-short-circuits to `blocked` state, avoiding wasted `max_retries` runs (LLM token savings ~50%).
- **Orchestrator**: Agent silent termination now synthesizes `session_completed_synthetic` event with structured `blocker_fingerprint` and `termination_cause`, preserving failure reasons when LLM doesn't call MCP.
- **Spawner**: Auto-inject platform default read-only paths so git/vwsd/pipx tools work under native sandbox by default (macOS and Linux). macOS adds `/opt/homebrew`, `/usr/local`, `/Library/Developer/CommandLineTools`, `/Applications/Xcode.app/Contents/Developer`, `~/.local`, `~/.bun`, `~/.cargo`, `~/.rustup`; Linux adds `/opt`, `~/.local`, `~/.bun`, `~/.cargo`, `~/.rustup`, `~/.nvm`, `~/.pyenv`.
- **Live Transcript**: Agent stdout/stderr now stream to log file as data arrives, enabling real-time transcript display during execution.
- **SSE Logs**: Removed 30-second timeout on log SSE endpoint; long-running tasks (≥5 minutes) now work correctly with graceful termination detection.
- **SSE Events**: Switched from 2-second polling to push model using event bus; P50 refresh latency reduced from ~2s to ~100ms.
- **State Refresh**: Score Sheet (state, attempt, tokens, workspace) updates immediately on cancel/pause/claim via run events over SSE.
- **SSE Reliability**: Frontend reconnects log SSE with exponential backoff (1s to 10s) on error; 10-second fallback poller ensures recovery after SSE disconnect.
- **Attempt Tracking**: Frontend subscribes to `current_attempt` instead of `next_attempt`, fixing stale log display after retry cycles.

### Changed
- **Workflow**: Fingerprint cleared on success to prevent cross-issue pollution.
- **Workflow Schema**: `agent.permission_auto` is now `.strict()`; unknown keys are rejected at load time.
- **Protocol**: Removed stdout sentinel parsing for binary sessions; Stop hook delivery is the only accepted completion signal. Missing payload is classified as `no_result_payload`.
- **Event Bus**: All tracker state mutations (releaseIssue, claimIssue, scheduleRetry, updateTokenStats, updateWorkspacePath, markCurrentAttempt) now emit bus events.
- **HTTP Routes**: `/events/stream` supports `Last-Event-ID` header for reconnection catch-up; `/logs/:issueId/:attempt` accepts "current" as attempt parameter.
- **Frontend**: Dashboard filters SSE events by visible issue IDs to reduce unnecessary reloads.
