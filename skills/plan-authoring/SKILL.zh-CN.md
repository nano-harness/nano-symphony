---
name: plan-authoring
description: Use this skill when writing, reviewing, or debugging nano-symphony plan scripts.
---

# Plan 编写指南

[English](./SKILL.md)

你正在帮助编写或审查一份 **nano-symphony plan 脚本**。Plan 脚本运行在一个确定性的 `node:vm` sandbox 中，并通过 Symphony MCP 工具编排 sub-issue。

## 何时使用 plan

当单个 agent 会话过长、过于分散，或需要在某个中间步骤获得人工批准时，使用 plan：

- 研究 → 实现 → 验证的流水线
- 包含相互独立子任务的多文件重构
- 任何需要人类在执行前批准设计方案的任务

## 可用的原语

| 原语 | 适用场景 |
|-----------|----------|
| `issue(prompt, opts?)` | 单个必须先完成才能继续的子任务。 |
| `parallel(thunks)` | 多个可以并发运行的独立子任务。 |
| `pipeline(items, ...stages)` | 同一组 item 需要流经多个阶段。 |
| `dag(nodes, edges)` | 子任务之间有显式依赖关系；后续节点使用 `{{nodeId}}` 引用前面节点的结果。 |

## 最佳实践

1. **始终使用 `phase(title)`** 标注逻辑阶段。Phase 会出现在向运维人员展示以供审批的 dry-run 摘要中。
2. 当下游代码依赖某个 sub-issue 结果的结构时，**提供 `schema`**。这还能在 plan 脚本中实现类型安全的访问。
3. 对于设计审批或任何需要人工审查后才能继续的节点，**使用 `gate: true`**。
4. 在重要节点上（尤其是在 DAG 中）**使用 `key`**，以获得稳定的崩溃恢复身份标识。

## 应避免的反模式

- **不要嵌套 plan。** 由 plan run 创建的 sub-issue 不能自行再发起 plan run。应返回结构化数据，由调用方的 issue 来发起下一个 plan。
- **不要使用被禁止的全局对象。** `Date`、`Math.random`、`require`、`import`、`process` 和 `globalThis` 在 sandbox 中均不可用。
- **不要动态构造 `meta`。** plan 的 `meta` 对象必须是脚本中的字面量对象。
- **不要在 prompt 中塞入超大上下文。** 保持 prompt 聚焦；对于人类可能需要在 journal 中阅读的共享上下文，使用 `log()`。

## 示例：先研究后实现

```js
phase("Research");
const analysis = await issue(
  "Analyse the current auth module and summarise its pain points",
  {
    schema: {
      type: "object",
      properties: { pain_points: { type: "array", items: { type: "string" } } },
      required: ["pain_points"],
    },
  }
);

phase("Implement");
await parallel(
  analysis.pain_points.map((point) => () => issue(`Fix: ${point}`))
);

phase("Validate");
const report = await issue(
  "Run the test suite and report the result",
  {
    schema: {
      type: "object",
      properties: { passed: { type: "boolean" }, summary: { type: "string" } },
      required: ["passed", "summary"],
    },
  }
);

log(`Validation passed: ${report.passed}`);
```

## 示例：审查 → 实现 → 测试的 DAG

```js
const result = await dag(
  [
    { id: "review", prompt: "Review the auth module for issues", role: "reviewer", gate: true },
    { id: "implement", prompt: "Implement the approved changes" },
    { id: "test", prompt: "Run tests and report results" },
  ],
  [
    { from: "review", to: "implement" },
    { from: "implement", to: "test" },
  ]
);
```

## 调试 plan

- 在 dashboard 中打开 plan run，展开 **Journal** 查看 phase 和 sub-issue 的状态流转。
- 展开 **Nodes** 查看哪些 DAG 节点正在运行、已完成或已失败。
- 查看 `/api/v1/plan-runs/:id/journal` 和 `/api/v1/plan-runs/:id/nodes` 以进行编程式访问。

## CLI 优先的派发方式

Plan 脚本应通过 **Symphony CLI** 派发。CLI 会自动读取 `SYMPHONY_MCP_URL` 和 `SYMPHONY_TOKEN`，并且在所有运行时中均可工作。仅当 agent 无法执行 shell 命令时，才使用 MCP JSON-RPC 工具。

### CLI：发起 plan run 并交接

```bash
# Write plan script to a file
cat > plan.js << 'EOF'
phase("Research");
const analysis = await issue("Analyse the auth module", {
  schema: { type: "object", properties: { issues: { type: "array", items: { type: "string" } } }, required: ["issues"] }
});

phase("Fix");
await parallel(analysis.issues.map(i => () => issue(`Fix: ${i}`)));
EOF

# Dispatch and handoff (pauses current issue until plan completes)
symphony spawn-plan-run-and-handoff --script plan.js --meta-json '{"name":"Auth refactor","max_issues":10}'
```

### MCP 回退方式

如果 agent 仅支持 MCP 工具，使用 `symphony.spawn_plan_run_and_handoff`：

```
symphony.spawn_plan_run_and_handoff({ script: `...plan source...`, meta: { name: "Auth refactor", max_issues: 10 } })
```

两种方式都会创建一个 `plan_run_spawned` 事件，并在 plan runtime 执行期间将该 issue 流转为 `awaiting_plan` 状态。
