# Changelog

All notable changes to nano-symphony will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Observability**: Orchestrator attempt outputs to symphony-owned `./run_log.jsonl` (path configurable via `RUN_LOG_PATH`; toggle via `RUN_LOG_ENABLED`). Does not write to nano-agent's `~/.nano/task_log.jsonl`.
- **MCP**: `symphony.session_completed` accepts `blocker_fingerprint` and `termination_cause` parameters, enabling short-circuit logic and structured failure tracking.
- **Database**: `issues` table gains `last_blocker_fingerprint` column (auto-migrated).
- **SKILL**: SKILL.md documents `blocker_fingerprint` usage, updated sandbox default blocklist, and sentinel fallback mechanism.

### Fixed
- **Orchestrator**: Same blocker fingerprint ≥ 2 times auto-short-circuits to `blocked` state, avoiding wasted `max_retries` runs (LLM token savings ~50%).
- **Orchestrator**: Agent silent termination now synthesizes `session_completed_synthetic` event with structured `blocker_fingerprint` and `termination_cause`, preserving failure reasons when LLM doesn't call MCP.
- **Sentinel**: Enhanced `deriveCompletion` extracts `termination_cause` and `blocker_fingerprint` from nano-agent sentinel (when available), with `normalizeBlockerString` fallback for legacy agents.

### Changed
- **Workflow**: Fingerprint cleared on success/handoff to prevent cross-issue pollution.
- **Sentinel**: `NanoSentinel` interface extended with optional `termination_cause` and `blocker_fingerprint` fields (backward-compatible).
