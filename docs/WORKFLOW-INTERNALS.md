# WORKFLOW.md 内部机制

> 本文件说明 nano-symphony 在加载、解析与运行 `WORKFLOW.md` 时的内部约定。运行时配置文件
> 本身位于仓库根 `WORKFLOW.md`，由 `scripts/init-project.sh` 从 `templates/WORKFLOW.example.md`
> 兜底生成；如需自定义，请直接编辑根目录的 `WORKFLOW.md`。

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
2. Calls `adapter.collectArtifacts(ctx)` — the nano adapter reads
   `<workspace>/.nano-out/solution.patch` from disk and returns
   `{ patch }` (or `{}` if the file is absent).

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

## 4. Sandbox hardening: read_only_paths injection

For the `native` sandbox backend, the spawner injects `~/.config/nano` into
`.nano.yaml.sandbox.read_only_paths` so agents cannot mutate the user's
nano-agent configuration during a run. For `docker` and `none` backends, no
injection happens.

This is implemented in `src/spawner/adapters/nano.ts` via
`mandatoryReadOnlyPaths(sandboxBackend)` and rendered into the YAML's
`read_only_paths` list (not `denied_write_paths`).

## 5. WORKFLOW 文件生命周期与热重载

- `init-project.sh` 在仓库根不存在 `WORKFLOW.md` 时从 `templates/WORKFLOW.example.md` 拷贝。
- 运行时 chokidar 监听 `WORKFLOW.md` 变化触发热重载（macOS 默认启用 polling 兜底；可通过 `SYMPHONY_WATCH_USE_POLLING=0` 显式关闭）。
- `PUT /api/v1/workflow` 写入后会同步触发重载，watcher 仅作兜底。
- 重载成功/失败事件通过 `/api/v1/events/stream` 推送（kind: `workflow_reloaded` / `workflow_reload_failed`）。

### Troubleshooting: 改了 WORKFLOW.md 没生效

1. 检查日志是否出现 `workflow reloaded` 或 `workflow reload failed`。
2. 若两者都没出现，说明 watcher 未感知到文件变化。macOS 上默认已启用 polling（v0.8+）；如仍不生效，确认 `SYMPHONY_WATCH_USE_POLLING=1` 已设置，或通过 `PUT /api/v1/workflow` 接口写入（该接口会同步触发重载）。
3. 若出现 `workflow reload failed`，检查 YAML front matter 语法是否合法。
