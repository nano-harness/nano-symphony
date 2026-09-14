# ADR 003：编排收敛审计——单写者派发与压缩子代理结果

[English](./003-orchestration-convergence-audit.md)

## 状态

已接受

## 背景

编码 Agent 的编排框架已收敛到一致的形态：编排器持有完整上下文与计划；子代理隔离运行、对共享状态多数只读、回传压缩摘要而非完整轨迹；对共享状态的写入保持单线程。本 ADR 记录了对 `src/orchestrator/` 与 `src/spawner/` 依据该形态所做的审计、两轮中发现并修复的缺口，以及仅记录、暂不处理的缺口。

nano-symphony 位于 Agent 马具之上的"循环工程"层（见 README"定位"一节）：按调度运行 Agent、投喂工作、检查结果、决定下一步。审计的问题是：

1. 两个 worker 是否可能并发写同一个 Issue 或工作区？
2. 子代理回传的是完整轨迹还是压缩摘要？

## 审计结论

### 符合项

- **数据库层保证单 Issue 单写者。** `symphony_runs` 每个 Issue 一行（`issue_uuid PRIMARY KEY`），`claimIssue`（`src/db/tracker-runs.ts`）是原子的 `INSERT ... ON CONFLICT ... WHERE last_state IN ('released', 'retry_queued')`。任何第二次认领——无论来自另一个 tick、手动重触发，还是共享同一数据库的第二个 symphony 进程——都影响零行并被拒绝。同一 tick 内重试任务与新候选之间也做了去重（`src/orchestrator/index.ts`）。
- **完成写库是原子的。** 终态流转、run 释放与事件记录包裹在 `src/orchestrator/worker.ts` 的同一个事务中；中途崩溃不会留下半截状态。
- **编排器持有上下文。** 提示词由 worker 从 Issue、评论、scratchpad、历史 plan 调用和工作流模板组装——而不是由 Agent 自己组装。Agent 通过受限 MCP 工具获取任务，不直接读数据库。
- **子代理隔离。** 每个 Issue 在独立工作区运行（`workspaces/<identifier>` 或显式 `workspace_path`），处于进程沙箱内（bubblewrap / sandbox-exec），Agent 令牌只授予上报类工具（`AGENT_TOOL_SCOPE`）。控制面凭据不会进入 Agent 环境。
- **压缩摘要而非完整轨迹。** 子代理上报 `AgentResultSummary`（`src/spawner/agent-result-payload.ts`）：状态（`success` / `needs_retry` / `abandoned` / `timeout`）、简短原因、goal 状态、token 计数和小型诊断样本。完整 stdout 写入按 attempt 划分的日志文件；数据库只记录离散事件。worker 会用进程退出码交叉校验 Agent 声称的成功，并拒绝不一致的上报。
- **plan run 不会并发重复执行。** `src/orchestrator/plan-tick.ts` 用进程内 `inFlight` 集合保证同一 plan run 不会被并发 dry-run 或执行两次；子 Issue 的 token 预算由 plan 执行器在整个 run 范围内强制执行。

### 本轮发现并修复的缺口

- **释放过期 run 时未杀死残留的 Agent 进程。** 当已认领的 run 停止心跳时，tick 会释放它以便重新派发——但如果 Agent 进程仍然存活（例如在 spawner 侧心跳计时器停止后卡死），重新认领可能向同一工作区派出*第二个* Agent，而第一个仍在运行：同一工作区出现两个并发写者。现在 tick 在释放过期 run 之前会调用 `cancelAgent(issueUuid)`（`src/orchestrator/index.ts`），并在 `stale_run_detected` 事件负载中记录 `agent_killed`。

### 后续轮次修复的缺口

- **共享外部工作区没有跨 Issue 互斥。** 两个 Issue 可以指向同一个 `workspace_path` 并被并行派发，导致同一目录出现两个写者。现在派发循环在认领事务内执行工作区冲突检查（`src/orchestrator/index.ts` 的 `findWorkspaceConflict`）：对于设置了外部 `workspace_path` 的候选 Issue，先按 `ensureWorkspace` 的解析规则解析路径（绝对、相对、`~` 写法均判定为相同），再与所有活跃 run 占用的工作区比对（`src/db/tracker-runs.ts` 的 `tracker.getActiveWorkspacePaths`）。活跃集合与 run 生命周期一致——`claimed` 与 `retry_queued` 状态的 run 持有其工作区（已认领但 worker 尚未启动的 run 通过 Issue 的 `workspace_path` 持有），`released` 后释放，因此过期释放路径会在下一个 tick 解除对等待 Issue 的阻塞。冲突时候选 Issue 在本 tick 被跳过——不认领、不报错——并记录一条节流的 `workspace_conflict_skipped` 事件（每个冲突 Issue 每分钟至多一条），负载包含工作区路径与冲突方 Issue UUID。无 schema 变更：该防护只是对 `symphony_runs` 与 `issues` 联表的只读查询。未设置 `workspace_path` 的 Issue 不受影响。

### 仅记录、暂不处理的缺口（高风险或改动面大）
- **过期释放后 worker 仍可能完成写库。** 被过期释放的 worker 若随后完成，其完成事务仍可能对已被重新认领的 Issue 应用状态流转。该窗口很窄（Agent 进程现在会在过期释放时被杀死），且流转源自真实的进程结果，因此本轮接受该行为，而不是为认领引入 fencing token。
- **plan 运行时的子 Issue 并行。** plan 执行器可以并行运行相互独立的子 Issue；每个子 Issue 仍经过同一个单写者认领路径，因此符合收敛形态，但跨*工作区*的全局写入串行化仍由操作者负责。

## 决定

1. 保留数据库强制实现的单写者认领作为唯一的派发互斥；不增加应用层锁。
2. 释放过期 run 时一并杀死 Agent 进程（本轮已实现）。
3. 保留压缩的 `AgentResultSummary` 契约作为子代理结果的唯一通道；轨迹留在日志文件，不进数据库。
4. 以认领事务内的查询式防护实现外部工作区的跨 Issue 互斥（后续轮次已实现）；不引入锁表、无 schema 变更。暂缓认领 fencing；如果共享工作区的多写者场景成为受支持特性，再重新评估。

## 影响

### 正面

- 单写者保证存活在 SQLite 而非内存中，因此重启后仍然成立，甚至对共享同一数据库的多个 symphony 进程也成立。
- 重新派发的 Issue 不会再遇到仍在写其工作区的僵尸 Agent。
- 配置相同外部 `workspace_path` 的两个 Issue 不会再并发运行；后到者等待，其延迟以 `workspace_conflict_skipped` 事件可见。
- 控制面状态保持小巧可查询；大体积输出留在磁盘。

### 负面

- `cancelAgent` 使用 SIGTERM 并在 3 秒后升级为 SIGKILL；对两种信号都无响应的进程（不可杀状态、NFS 挂起）仍可能比释放活得更久。这是尽力而为的缓解，不是硬保证。
- 工作区防护按解析后的路径字符串比对，无法识别通过符号链接或 bind mount 指向同一目录的别名；对不共享同一 SQLite 数据库的多个进程，该防护也只是尽力而为。

## 相关文档

- `src/orchestrator/index.ts`、`src/orchestrator/worker.ts`
- `src/db/tracker-runs.ts`
- `src/spawner/agent-result-payload.ts`
- `docs/standards/agent-exit-contract.zh-CN.md`
- `docs/metrics-cost-and-reliability.zh-CN.md`
- `tests/unit/heartbeat-stale.test.ts`、`tests/unit/concurrency.test.ts`
- `tests/unit/workspace-mutex.test.ts`、`tests/integration/dispatch.test.ts`
