# 成本与可靠性度量

[English](./metrics-cost-and-reliability.md)

本文档说明 nano-symphony 如何度量循环工程需要负责的两个维度：**成本**与**多次运行之间的可靠性**。

## 成本作为一阶指标

Agent 评估实践通常只报告准确率，把成本当作副产品；但准确率相近的系统，token 开销可能相差一个数量级甚至更多。对于一个反复、无人值守地运行 Agent 的编排器来说，成本是一阶运维指标，而不是附属数据。

nano-symphony 目前的记录：

- **按 attempt**：每次 worker attempt 写入一行 `llm_calls`，包含输入/输出 token、`cost_usd`（Agent 上报时）以及 wall/API 耗时（`src/db/tracker-llm-calls.ts`，由 `src/orchestrator/worker.ts` 写入）。
- **按 Issue**：`symphony_runs.token_*` 保存最近一次 attempt 的 token 计数；`issue_metrics` 在 Issue 到达 `done` / `cancelled` / `blocked` 时持久化终态快照（attempts、sessions、token、成本、耗时）。
- **预算是强制手段而非仅遥测**：Issue 上的 `cost_budget_usd` 与 `token_budget`、plan run 元数据中的 `max_budget_tokens`，会在超支时中止工作；plan 执行器在每次调度决策时重新计算所有子 Issue 的累计开销。
- **导出接口**：`GET /api/v1/issues/:id/llm-calls[/summary]`、`GET /api/v1/issues/summary`、`GET /api/v1/metrics/export`，以及 Prometheus 计数器（`symphony_tokens_total`、`symphony_agent_attempts_total`、`symphony_agent_duration_milliseconds`）。

### 按 plan run 的用量汇总

`GET /api/v1/plan-runs/:id/usage` 汇总某个 plan run 所有子 Issue 的 `llm_calls`（`tracker.getPlanRunUsage`）：

```json
{
  "id": "RUN-…",
  "issue_count": 3,
  "total": { "attempts": 4, "input_tokens": 12000, "output_tokens": 3000, "cost_usd": 0.42 },
  "consistency": {
    "terminal_issues": 3,
    "done_issues": 2,
    "first_attempt_successes": 2,
    "first_attempt_success_rate": 0.67
  },
  "issues": [ { "issue_uuid": "…", "identifier": "TASK-1", "state": "done",
                "attempts": 1, "input_tokens": 4000, "output_tokens": 1000, "cost_usd": 0.14 } ]
}
```

控制台在 Issue 详情页的每个 plan run 卡片上以 **Usage & consistency** 面板展示这些数据。无需 schema 迁移：聚合直接 join 现有的 `issues.plan_run_id` 与 `llm_calls` 表。

已知限制：`cost_usd` 的完整度取决于 Agent 是否上报。nano 适配器会上报；不上报成本的适配器会留下 null，导致汇总偏低。token 计数始终记录（优先使用结果负载，流式累计作为回退）。

## 可靠性：pass@k 与 pass^k

对同一任务重复采样时，有两个互补指标：

- **pass@k**：k 次独立运行中*至少一次*成功的概率。退避重试利用的正是这一点：即使 Agent 不可靠，只要重试足够多次也能收敛到成功。
- **pass^k**：k 次运行*全部*成功的概率。它度量一致性：当没有重试兜底时（例如无法简单重来的无人值守副作用），这个循环是否值得信任。

编排器应当致力于缩小两者的差距。差距大（pass@k 高、pass^k 低）意味着循环在用重试为不可靠的马具兜底——昂贵且缓慢，而这正是"先建马具"的顺序所警告的失败倍增。

nano-symphony 目前暴露的数据：

- 每次 attempt 都有记录（按 attempt 的 `llm_calls`、带语义信息的 `session_completed` 事件），因此每个 Issue 的 attempt 次数与结果都可以从数据库重建。
- 上述 plan run 用量端点提供 pass@1 风格的一致性信号：`first_attempt_success_rate` 是到达终态的子 Issue 中首次 attempt 即 `done`（无重试）的比例。
- `issue_metrics.attempts` 为终态 Issue 持久化 attempt 计数，支持在整个 Issue 语料上离线估算 pass@k。

尚未实现的部分：一个专门的端点，对同一任务运行 k 次并计算经验 pass@k / pass^k。数据模型已经支持（attempt 与语义按 Issue 记录、append-only）；但要忠实地计算它，需要有目的地为同一工作调度 k 个独立样本，这是产品决策，而不只是一个查询。
