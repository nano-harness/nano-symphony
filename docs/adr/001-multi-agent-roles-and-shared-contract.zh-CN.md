# ADR 001: 多 Agent 角色与共享契约 Schema

[English](./001-multi-agent-roles-and-shared-contract.md)

## 状态

提议中（Proposed）

## 背景

`nano-symphony` 目前对每个 issue 只编排单个 agent。一次 plan run 可以
派生出许多子 issue，但每个子 issue 都由一个通用 agent 执行，其配置来自
workflow 的 `agent` 部分。目前没有一等公民的 agent 角色概念
（planner、executor、reviewer 等），而且 `nano-agent` 与
`nano-symphony` 之间的契约分散在多处：

- stdout JSON（`AgentResultSummary`）——由 adapter 专属代码解析
- 退出码（exit codes）——在两个项目中各自定义
- MCP 工具调用（`session_completed`、`report_event` 等）
- 环境变量（`SYMPHONY_ISSUE_UUID`、`SYMPHONY_WORKSPACE` 等）

随着系统规模增长，这种隐式契约使得以下事情变得困难：

1. 在不重复解析逻辑的情况下添加新的 agent adapter。
2. 推理出哪个 agent 最适合某个给定的子 issue。
3. 当某个 agent 角色在 workflow 中途崩溃时，从部分失败中恢复。
4. 在人工操作者与自动化 agent 之间共享 workflow 定义。

## 决策

在 `nano-symphony` 中引入 **agent 角色**，并将跨项目契约固化为
带版本号的 JSON Schema / OpenAPI 规范。

### 1. Agent 角色

每个 issue（以及 plan-run DAG 中的每个节点）都可以声明一个 `role`。
角色是映射到 workflow 中 agent profile 的名称：

```yaml
agent:
  default:
    kind: nano
    timeout_ms: 3600000
  roles:
    planner:
      kind: nano
      permission_mode: default
      allowed_tools: ["mcp_symphony_*", "ReadFile", "Glob"]
    executor:
      kind: nano
      permission_mode: auto
      timeout_ms: 7200000
    reviewer:
      kind: claude-code
      permission_mode: default
      max_retries: 1
```

当派发一个 issue 时，orchestrator 会将其角色解析为对应的 agent
profile。如果未指定角色，则使用 `default` profile。这保持了
向后兼容性。

### 2. 角色感知的 Plan Run

plan-runtime SDK 将允许为节点附加角色：

```js
dag({
  plan: {
    prompt: "Produce an implementation plan.",
    role: "planner",
  },
  implement: {
    prompt: "Implement the plan from {{plan}}.",
    role: "executor",
    after: ["plan"],
  },
  review: {
    prompt: "Review the implementation from {{implement}}.",
    role: "reviewer",
    after: ["implement"],
  },
});
```

每个节点都会派生一个带有 `agent_kind`/`agent_binary` 以及新增
`agent_role` 字段（存储在 `issues` 表中）的 issue。orchestrator 使用该
字段来选择正确的 agent profile。

### 3. 共享契约 Schema

将隐式契约迁移为显式的、带版本号的 schema。第一个版本（`v1`）涵盖：

- **AgentResultSummary** —— status、reason、goal_state、tokens、artifacts、
  blocker_fingerprint、termination_cause。
- **MCP 工具请求/响应载荷** —— `session_completed`、`report_event`、
  `submit_plan`、`emit_result`、`spawn_plan_run`。
- **环境变量** —— 必需与可选之分、类型、示例。
- **退出码** —— 规范名称与数值。

schema 存放在仓库的新目录中：

```
nano-symphony/contract/
  v1/
    agent-result-summary.schema.json
    mcp-tools.openapi.json
    env.schema.json
```

`nano-agent` 将在以下位置内嵌同一份 schema：

```
nano-agent/pkg/contract/
  v1/
    agent_result_summary.go   // generated or hand-written constants
```

两个项目都在可行的情况下于运行时依据 schema 进行校验：

- `nano-agent` 在写出其 stdout JSON 之前进行校验。
- `nano-symphony` 校验解析后的结果，并对格式错误的 MCP 载荷给出明确的
  错误提示并拒绝，而不是无限期重试。

### 4. 恢复身份标识（Resume Identity）

用稳定的身份标识替换脆弱的恢复键（`prompt 的前 80 个字符`）：

```
{issue_uuid}:{attempt}:{plan_run_id}:{node_id}
```

该身份标识通过 `SYMPHONY_ISSUE_ID` 传递给 agent，并存储在 agent 的
会话元数据中，从而使重试和 plan-run 恢复具有确定性。

### 5. 角色间通信

复用现有的 `issue_blockers` 表来实现跨角色依赖：

- reviewer issue 可以阻塞 executor issue，直到批准为止。
- planner issue 可以阻塞实现类 issue，直到计划获得批准为止。

这是一种轻量级的替代方案，无需重建邮箱（mailbox）语义，并且与
已落地的 blocker 可视化工作保持一致。

## 后果

### 正面

- 新的 agent adapter 只需产出合法的契约载荷；orchestrator 不再需要
  adapter 专属的解析调整。
- 操作者无需修改 orchestrator 代码，即可声明角色专属的权限和模型。
- plan 脚本能够自我说明"谁做什么"。
- 恢复与崩溃恢复变得具有确定性。

### 负面

- 增加了一次迁移：不含 `agent.roles` 的现有 workflow 仍可继续工作，
  但角色感知功能需要更新 schema。
- 当契约版本变更时，需要协调 `nano-agent` 与 `nano-symphony` 的发布。
- 在采用代码生成之前，JSON Schema 必须与 Go/TypeScript 代码保持同步。

## 实施阶段

1. **Schema 仓库搭建** —— 在两个项目中创建 `contract/v1/`。
2. **运行时校验** —— 依据 schema 校验 stdout JSON 和 MCP 载荷。
3. **数据库迁移** —— 在 `issues` 表中新增 `agent_role`，并在
   `plan_runs` 的节点元数据中持久化角色。
4. **Orchestrator 角色解析** —— 按角色选择 agent profile。
5. **Plan-runtime SDK 角色支持** —— 在 `issue()`/`dag()`/
   `parallel()` 节点中接受 `role`。
6. **稳定的恢复身份标识** —— 替换基于 prompt 前缀的恢复键。
7. **文档与示例** —— 更新 `WORKFLOW-reference.md` 并添加多角色
   workflow 示例。

## 相关文档

- `docs/standards/agent-exit-contract.md`
- `docs/WORKFLOW-reference.md`
- `nano-agent/docs/features/MULTI_AGENT.md`
