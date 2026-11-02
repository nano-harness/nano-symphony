# WORKFLOW.md Internals

[中文](./WORKFLOW-INTERNALS.zh-CN.md)

> This document describes nano-symphony's internal conventions for loading, parsing, and running
> `WORKFLOW.md`. The runtime configuration file itself lives at the repository root as `WORKFLOW.md`,
> generated as a fallback by `scripts/init-project.sh` from `templates/WORKFLOW.example.md`;
> to customize it, edit the root `WORKFLOW.md` directly.

## 1. `agent.permission_auto` (pass-through, strict)

When `agent.permission_mode: auto`, you can optionally configure:

```yaml
agent:
  permission_mode: auto
  permission_auto:
    backend: llm | fail_closed
    model: "..."                  # optional (also supported via env)
    confidence_threshold: 0.8
    timeout_seconds: 5
    cache_ttl_minutes: 30

    # Trust declaration (the ONLY mechanism symphony exposes).
    allow_rules: ["Bash(vwsd *)"]

    # Denial tracker thresholds; 0 means "use nano-agent defaults".
    denial_max_consecutive: 0
    denial_max_total: 0
```

Notes:
- `permission_auto` is validated with Zod `.strict()`. Unknown fields (including legacy keys like `trusted_binaries`, `extra_read_only_commands`, `soft_deny_rules`, `environment`) are rejected at load time.
- `allow_rules` is interpreted by nano-agent. nano-symphony does not parse or validate rule syntax.

## 2. Agent result delivery

nano-symphony spawns the agent (nano or claude-code) via an `AgentAdapter` in
`src/spawner/adapters/`. After the agent process exits, the orchestrator:

1. Calls `adapter.parseResult(stdout)` — for the nano adapter this takes the
   last non-empty line of stdout and `JSON.parse`s it into an
   `AgentResultSummary` (validated by `AgentResultSummarySchema`); for the
   claude-code adapter it parses the outer envelope `{type, is_error, result}`
   first, then JSON-parses the inner `result` string.
2. Collects artifacts via `collectAllArtifacts()` in the orchestrator, which
   computes a git diff of the workspace. Adapters may also return additional
   artifacts from `adapter.collectArtifacts(ctx)`, but the nano adapter currently
   returns `{}` because nano-agent no longer writes `solution.patch`.

There is no HTTP callback, no `result-hook.sh`, and no stdout sentinel.

If `parseResult` returns `null`, the run is classified
`semantics=abandoned` with `termination_cause=no_result_payload`.

## 3. Short-circuit: `shortcircuit_same_cause`

If the same `blocker_fingerprint` repeats on consecutive retry attempts (current
fingerprint matches `last_blocker_fingerprint` stored on the issue), the worker
short-circuits to the `blocked` or `abandoned` target state without scheduling
another retry. This prevents wasting agent cycles on an identical obstruction.

The worker records a `shortcircuit_same_cause` event with both the fingerprint
and the attempt numbers.

## 4. Sandbox configuration

Sandbox paths are controlled by `workflow.agent.sandbox.extra_writable_paths` and
forwarded to the agent via `--add-dir`. The orchestrator no longer injects
`~/.config/nano` or other mandatory read-only paths into `.nano.yaml`; the agent
is responsible for its own sandbox defaults.

## 5. WORKFLOW file lifecycle and hot reload

- `init-project.sh` copies `templates/WORKFLOW.example.md` to `WORKFLOW.md` when none exists at the repository root.
- At runtime, chokidar watches `WORKFLOW.md` for changes and triggers a hot reload (on macOS, polling is enabled by default as a fallback; it can be explicitly disabled via `SYMPHONY_WATCH_USE_POLLING=0`).
- Writes through `PUT /api/v1/workflow` trigger a reload synchronously; the watcher is only a fallback.
- Reload success/failure events are pushed via `/api/v1/events/stream` (kind: `workflow_reloaded` / `workflow_reload_failed`).

### Troubleshooting: changes to WORKFLOW.md not taking effect

1. Check the logs for `workflow reloaded` or `workflow reload failed`.
2. If neither appears, the watcher did not detect the file change. On macOS, polling is enabled by default (v0.8+); if it still does not work, confirm `SYMPHONY_WATCH_USE_POLLING=1` is set, or write via the `PUT /api/v1/workflow` endpoint (which triggers a reload synchronously).
3. If you see `workflow reload failed`, check that the YAML front matter syntax is valid.
