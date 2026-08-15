# Agent 退出契约 v1

[English](./agent-exit-contract.md)

本文档定义了 agent 向 nano-symphony 传达完成状态的标准契约。所有 agent 适配器（adapter）都必须遵循该契约。

## 信号优先级（高 → 低）

### 1. MCP `symphony.session_completed` 工具调用

- **权威性的语义声明**（semantics、summary、artifacts、follow_ups）。
- agent 在执行过程中主动调用，用于表达意图（例如 "handoff"）。
- 支持仅凭 stdout 无法表达的复杂语义。
- 如果 agent 在调用该工具之前崩溃，则该信号不存在。

### 2. stdout 中的 AgentResultSummary JSON（最后一行）

- 在 agent 退出后**被动收集**；由适配器的 `parseResult()` 解析。
- 必须是符合 `AgentResultSummarySchema` 的单行合法 JSON。
- token 字段对 nano-agent 具有权威性；对 claude-code 而言，以 envelope 中的 `usage` 为准。
- 从最后一行向上扫描，跳过空行和以 `[err]` 为前缀的行。

### 3. 退出码

- **进程级语义提示**：`0`=成功，`10`=重试，`20`=放弃，`30`=超时，`1`=未分类。
- **仅**用于交叉校验（exitCode ≠ 0 && payload.status == "success" → 降级为 needs_retry）。
- 不单独决定完成语义。

## 冲突解决规则

| 冲突 | 解决方式 |
|----------|-----------|
| MCP `session_completed.semantics` 与 stdout `payload.status` | MCP 优先（覆盖 stdout） |
| Envelope `usage`（claude-code）与 `payload.tokens` | Envelope 优先（token 的权威来源） |
| 退出码与 payload status | 退出码**不会**覆盖；仅触发不匹配检测 |

## AgentResultSummary Schema

```typescript
{
  status: "success" | "needs_retry" | "abandoned" | "timeout",
  reason?: string,
  goal_state?: {
    last_reason?: string,
    iterations?: number,
    // passthrough: additional fields accepted
  },
  tokens?: {
    input?: number,
    output?: number,
    cached?: number,
    // passthrough: additional fields accepted
  },
  blocked_commands_sample?: string[],  // max 20 items
  sandbox?: {
    backend?: string,
    network?: string,
    // passthrough: additional fields accepted
  },
  // passthrough: additional top-level fields accepted
}
```

## 适配器合规要求

新增 agent 适配器时，**必须**实现：

| 方法 | 是否必需 | 说明 |
|--------|----------|-------------|
| `parseResult(stdout)` | ✅ | 从 stdout 文本中提取 `AgentResultSummary` |
| `collectArtifacts(ctx)` | ✅ | 从 `outputDir` 收集 patch/文件 |
| `renderWorkspaceFiles(ctx)` | ✅ | 为 agent 生成 workspace 配置文件 |
| `buildSpawnInvocation(ctx)` | ✅ | 为 `Bun.spawn` 构建 argv 和 env |
| `parseStreamingLine(line)` | 可选 | 解析 stdout 中的实时流式事件 |
| `resolvePermissionMode(config)` | 可选 | 从 workflow 配置解析权限模式 |
| `applyPermissionFloor(opts)` | 可选 | sandbox 关闭时应用权限下限 |

## 退出码常量

```typescript
const NANO_EXIT = {
  SUCCESS: 0,
  RETRY: 10,
  ABANDONED: 20,
  TIMEOUT: 30,
  UNCLASSIFIED: 1,
} as const;
```

## 完成流程

```
Agent exits
    ↓
1. Check killedByTimeout → needs_retry (terminationCause: "timeout")
    ↓
2. Parse stdout → AgentResultSummary (adapter.parseResult)
    ↓
3. No payload? → abandoned (terminationCause: "no_result_payload")
    ↓
4. Exit code cross-validation:
   payload.status == "success" && exitCode ≠ 0 → needs_retry (terminationCause: "exitcode_mismatch")
    ↓
5. Use payload.status as semantics
    ↓
6. Check MCP session_completed event → override semantics if present
    ↓
7. Apply state_transitions from workflow config
```
