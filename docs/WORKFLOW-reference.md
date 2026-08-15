# WORKFLOW.md

[中文](./WORKFLOW-reference.zh-CN.md)

`WORKFLOW.md` is a Markdown file with YAML front matter. The front matter configures how nano-symphony runs nano-agent; the Markdown body is rendered into the agent prompt.

This document highlights fields related to `permission_auto`, agent result delivery, and sandbox hardening.

## `agent.permission_auto` (pass-through, strict)

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

## Agent result delivery

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

## Short-circuit: `shortcircuit_same_cause`

If the same `blocker_fingerprint` repeats on consecutive retry attempts (current
fingerprint matches `last_blocker_fingerprint` stored on the issue), the worker
short-circuits to the `blocked` or `abandoned` target state without scheduling
another retry. This prevents wasting agent cycles on an identical obstruction.

The worker records a `shortcircuit_same_cause` event with both the fingerprint
and the attempt numbers.

## Sandbox configuration

Sandbox paths are controlled by `workflow.agent.sandbox.extra_writable_paths` and
forwarded to the agent via `--add-dir`. The orchestrator no longer injects
`~/.config/nano` or other mandatory read-only paths into `.nano.yaml`; the agent
is responsible for its own sandbox defaults.

