# WORKFLOW.md

[English](./WORKFLOW-reference.md)

`WORKFLOW.md` 是一个带有 YAML front matter 的 Markdown 文件。front matter 用于配置 nano-symphony 运行 nano-agent 的方式；Markdown 正文会被渲染到 agent 的 prompt 中。

本文档重点介绍与 `permission_auto`、agent 结果交付以及 sandbox 加固相关的字段。

## `agent.permission_auto`（透传，strict 模式）

当 `agent.permission_mode: auto` 时，你可以选择性地配置：

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

说明：
- `permission_auto` 使用 Zod `.strict()` 进行校验。未知字段（包括 `trusted_binaries`、`extra_read_only_commands`、`soft_deny_rules`、`environment` 等旧版键）会在加载时被拒绝。
- `allow_rules` 由 nano-agent 负责解释。nano-symphony 不解析也不校验规则语法。

## Agent 结果交付

nano-symphony 通过 `src/spawner/adapters/` 中的 `AgentAdapter` 启动 agent（nano 或 claude-code）。agent 进程退出后，orchestrator 会：

1. 调用 `adapter.parseResult(stdout)`——对于 nano adapter，它会取 stdout 的最后一个非空行，并将其 `JSON.parse` 为 `AgentResultSummary`（由 `AgentResultSummarySchema` 校验）；对于 claude-code adapter，它会先解析外层信封 `{type, is_error, result}`，然后再对内部的 `result` 字符串做 JSON 解析。
2. 通过 orchestrator 中的 `collectAllArtifacts()` 收集产物（artifacts），它会计算工作区的 git diff。adapter 也可以从 `adapter.collectArtifacts(ctx)` 返回额外的产物，但 nano adapter 目前返回 `{}`，因为 nano-agent 不再写入 `solution.patch`。

这里没有 HTTP 回调，没有 `result-hook.sh`，也没有 stdout 哨兵（sentinel）。

如果 `parseResult` 返回 `null`，该次运行会被归类为
`semantics=abandoned`，并带有 `termination_cause=no_result_payload`。

## 短路机制：`shortcircuit_same_cause`

如果在连续的重试尝试中重复出现相同的 `blocker_fingerprint`（当前指纹与存储在 issue 上的 `last_blocker_fingerprint` 一致），worker 会直接短路到 `blocked` 或 `abandoned` 目标状态，而不再安排下一次重试。这可以避免在完全相同的阻塞上浪费 agent 的运行周期。

worker 会记录一个 `shortcircuit_same_cause` 事件，其中包含指纹和尝试次数。

## Sandbox 配置

Sandbox 路径由 `workflow.agent.sandbox.extra_writable_paths` 控制，并通过 `--add-dir` 转发给 agent。orchestrator 不再向 `.nano.yaml` 注入 `~/.config/nano` 或其他强制的只读路径；agent 自行负责其 sandbox 的默认配置。
