# Plan 编写指南

[English](./plan-authoring.md)

Plan 脚本让 agent 将一个任务分解为更小的子 issue，这些子 issue 可以按
顺序、并行或以 DAG 的形式运行。它们在一个确定性的 `node:vm` sandbox
中执行。

## 何时使用 plan

当单个 agent 会话会过长、过于分散，或需要在中间步骤获得人工批准时，
使用 plan：

- 研究 → 实现 → 验证流水线
- 包含多个独立子任务的多文件重构
- 任何在执行前需要人工批准设计的任务

## SDK 全局变量

sandbox 会注入以下全局变量：

| 全局变量 | 用途 |
|--------|---------|
| `args` | 启动 plan run 时传入的参数 |
| `issue(prompt, opts?)` | 分发一个子 issue |
| `parallel(thunks)` | 并发运行多个 thunk |
| `pipeline(items, ...stages)` | 让 items 依次经过多个阶段处理 |
| `dag(nodes, edges)` | 执行由子 issue 组成的依赖图 |
| `phase(title)` | 为当前阶段命名（在 dry-run 摘要中可见） |
| `log(msg)` | 向 plan 日志追加一条消息 |
| `list_artifacts(issue_uuid)` | 列出已完成子 issue 的 artifacts |
| `get_artifact(artifact_id)` | 获取单个 artifact |

## IDE 支持

要在 VS Code 中获得自动补全和内联文档，请在 plan 脚本顶部添加这两行：

```js
// @ts-check
/// <reference path="./plan-runtime-globals.d.ts" />
```

将 `templates/plan-runtime-globals.d.ts` 复制到你的脚本旁边，或直接从
nano-symphony 仓库引用它。

## 如何在原语之间选择

- **`issue()`** —— 一次性的子任务。用于顺序执行的工作。
- **`parallel()`** —— 可以同时运行的独立子任务。
- **`pipeline()`** —— 同一输入依次经过多个阶段处理。
- **`dag()`** —— 具有显式依赖关系的子任务。当后续步骤需要通过
  `{{nodeId}}` 插值获取前面步骤的结果时使用。

## Schema 与 gate

当下游逻辑依赖子 issue 的输出结构时，务必提供 `schema`：

```js
const result = await issue("Summarise findings", {
  schema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
  },
});
```

使用 `gate: true` 可暂停 plan 以等待人工批准：

```js
const design = await issue("Propose a design", { gate: true });
```

## 常见反模式

1. **嵌套 plan** —— 由 plan run 创建的子 issue 自身无法再启动 plan。
   应返回结构化数据，由调用方 issue 启动下一个 plan。
2. **非确定性** —— sandbox 中不提供 `Date`、`Math.random`、`require`、
   `import`、`process` 和 `globalThis`。
3. **过大的 prompt** —— 保持节点 prompt 聚焦。通过 `log()` 将共享上下文
   放入 plan 日志。
4. **动态 meta** —— plan 的 `meta` 对象必须是字面量，不能在运行时
   构造。

## 示例：评审 → 实现 → 测试的 DAG

```js
phase("Review");
const review = await issue("Review the auth module", {
  key: "review",
  role: "reviewer",
  gate: true,
});

phase("Implement");
const implementation = await issue("Implement the approved changes", {
  key: "implement",
});

phase("Test");
await issue("Run tests and report results", { key: "test" });
```

## 校验

在分发 plan 脚本之前先对其进行校验：

```bash
bun scripts/validate-plan.ts path/to/plan.js
```

（尚未实现 —— 目前你可以通过创建 plan run 并在 dashboard 中批准
dry-run 摘要来进行 dry-run。）

## 分发 plan

Plan 脚本通过 **Symphony CLI** 或 MCP 工具分发。

### CLI（推荐）

```bash
# Spawn a plan run and continue independently
symphony spawn-plan-run --script plan.js

# Spawn a plan run and pause the current issue until it completes
symphony spawn-plan-run-and-handoff --script plan.js
```

CLI 会自动读取 `SYMPHONY_MCP_URL` 和 `SYMPHONY_TOKEN`。

### MCP 工具

如果 agent 只支持 MCP 工具，请使用 `symphony.spawn_plan_run_and_handoff`：

```
symphony.spawn_plan_run_and_handoff({ script: `...plan source...` })
```

两种方式都会记录一条 `plan_run_spawned` 事件，并在 plan 运行时执行期间
将 issue 状态转换为 `awaiting_plan`。
