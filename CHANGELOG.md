# Changelog

All notable changes to nano-symphony will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
