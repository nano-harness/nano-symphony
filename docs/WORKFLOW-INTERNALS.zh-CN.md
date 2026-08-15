# WORKFLOW.md 内部机制

[English](./WORKFLOW-INTERNALS.md)

> 本文件说明 nano-symphony 在加载、解析与运行 `WORKFLOW.md` 时的内部约定。运行时配置文件
> 本身位于仓库根 `WORKFLOW.md`，由 `scripts/init-project.sh` 从 `templates/WORKFLOW.example.md`
> 兜底生成；如需自定义，请直接编辑根目录的 `WORKFLOW.md`。

## 1. `agent.permission_auto`（透传，严格校验）

当 `agent.permission_mode: auto` 时，可以可选地配置：

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
- `permission_auto` 使用 Zod `.strict()` 校验。未知字段（包括 `trusted_binaries`、`extra_read_only_commands`、`soft_deny_rules`、`environment` 等历史键）会在加载时被拒绝。
- `allow_rules` 由 nano-agent 解释。nano-symphony 不解析也不校验规则语法。

## 2. Agent 结果交付

nano-symphony 通过 `src/spawner/adapters/` 中的 `AgentAdapter` 启动 agent
（nano 或 claude-code）。agent 进程退出后，orchestrator 会：

1. 调用 `adapter.parseResult(stdout)` —— 对 nano 适配器而言，它取 stdout 的
   最后一个非空行，并将其 `JSON.parse` 为 `AgentResultSummary`
   （由 `AgentResultSummarySchema` 校验）；对 claude-code 适配器而言，它先解析
   外层信封 `{type, is_error, result}`，然后再 JSON 解析内层的 `result` 字符串。
2. 通过 orchestrator 中的 `collectAllArtifacts()` 收集产物，它会对工作区计算
   git diff。适配器也可以从 `adapter.collectArtifacts(ctx)` 返回额外的产物，
   但 nano 适配器目前返回 `{}`，因为 nano-agent 已不再写入 `solution.patch`。

没有 HTTP 回调，没有 `result-hook.sh`，也没有 stdout 哨兵标记。

如果 `parseResult` 返回 `null`，该次运行会被归类为
`semantics=abandoned`，并带有 `termination_cause=no_result_payload`。

## 3. 短路机制：`shortcircuit_same_cause`

如果同一个 `blocker_fingerprint` 在连续的重试尝试中重复出现（当前指纹与
issue 上存储的 `last_blocker_fingerprint` 匹配），worker 会短路直接进入
`blocked` 或 `abandoned` 目标状态，而不再安排新的重试。这避免了在完全相同的
阻塞上浪费 agent 运行次数。

worker 会记录一条 `shortcircuit_same_cause` 事件，其中包含指纹和尝试次数。

## 4. Sandbox 配置

Sandbox 路径由 `workflow.agent.sandbox.extra_writable_paths` 控制，并通过
`--add-dir` 转发给 agent。orchestrator 不再向 `.nano.yaml` 注入
`~/.config/nano` 或其他强制的只读路径；agent 自行负责其 sandbox 默认配置。

## 5. WORKFLOW 文件生命周期与热重载

- `init-project.sh` 在仓库根不存在 `WORKFLOW.md` 时从 `templates/WORKFLOW.example.md` 拷贝。
- 运行时 chokidar 监听 `WORKFLOW.md` 变化触发热重载（macOS 默认启用 polling 兜底；可通过 `SYMPHONY_WATCH_USE_POLLING=0` 显式关闭）。
- `PUT /api/v1/workflow` 写入后会同步触发重载，watcher 仅作兜底。
- 重载成功/失败事件通过 `/api/v1/events/stream` 推送（kind: `workflow_reloaded` / `workflow_reload_failed`）。

### Troubleshooting：改了 WORKFLOW.md 没生效

1. 检查日志是否出现 `workflow reloaded` 或 `workflow reload failed`。
2. 若两者都没出现，说明 watcher 未感知到文件变化。macOS 上默认已启用 polling（v0.8+）；如仍不生效，确认 `SYMPHONY_WATCH_USE_POLLING=1` 已设置，或通过 `PUT /api/v1/workflow` 接口写入（该接口会同步触发重载）。
3. 若出现 `workflow reload failed`，检查 YAML front matter 语法是否合法。
