---
name: nano-symphony
description: Use this skill when operating inside a nano-symphony orchestrated workspace. Default to the symphony CLI; use MCP tools only when the runtime cannot execute shell commands.
---

# nano-symphony

[English](./SKILL.md)

你正在一个由 nano-symphony 编排的工作区内操作。本 skill 说明了预期的 agent 工作流程。**默认使用 `symphony` CLI**；MCP 工具仅作为无法派生 shell 进程的运行时的备选方案。

## 安装

使用一行安装脚本安装 nano-symphony：

```bash
curl -sSL https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh | bash
```

前置条件：必须已安装 [Bun](https://bun.sh/)。

安装完成后，启动服务：

```bash
symphony start
```

如需手动安装，请从以下地址下载最新归档：
- 归档：`https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/latest/nano-symphony.tar.gz`
- 安装脚本：`https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh`

## 何时使用本 skill

当工作区已由 nano-symphony 准备好，且你需要处理当前的编排 issue 时，使用本 skill。在 CLI 模式下，agent 环境仅暴露：

- `SYMPHONY_ISSUE_UUID` — 当前 issue 的 UUID。
- `SYMPHONY_WORKSPACE` — 本次运行的工作区路径。

MCP 端点和 token 被写入 `.symphony/env`，并由 `symphony` 包装器加载，因此 agent 不会意外直接连接到 MCP 服务器。

## CLI 优先的集成方式（默认）

**始终优先使用 `symphony` CLI。** 全局包装器会从当前目录向上搜索 `.symphony/env`，加载每个 issue 的凭据，并将命令转发到本地 Symphony MCP 端点。agent 进程本身在其环境中**不会**看到 `SYMPHONY_MCP_URL` 或 `SYMPHONY_TOKEN`，这可以防止意外的 MCP 自动发现。

**仅在以下情况**使用 MCP JSON-RPC 工具：
- 运行时无法派生 shell 进程，**并且**
- 有可用的原生 MCP 客户端。

默认的 `agent.transport` 是 `cli`；设置了 `agent.transport: mcp` 的工作流仍然接受 CLI 命令，但 `mcp` 会指示 Symphony 向 agent 暴露 MCP 配置。如有疑问，运行 `symphony <command>`。

## Agent 类型

Symphony 通过适配器模式支持两种 agent 类型：

- **nano**（默认）— 基于 Go 的编码 agent。结果从 stdout 的 JSON 行解析。在 `--output-dir` 中生成 `solution.patch`。
- **claude-code** — Claude Code CLI（`claude -p`）。结果从 stream-json 信封中解析。Token 用量从信封的 `usage` 字段提取。

agent 类型由工作流配置中的 `agent.kind` 决定，或通过 issue 的 `agent_kind` 字段按 issue 单独指定。

## 快速开始（CLI）

1. **必须首先执行的操作：** `symphony fetch-issue`（如果 `symphony` 不在 PATH 上，则用 `./.symphony/symphony fetch-issue`）。在此之前不要调用任何其他工具。
2. 查看 issue 详情并规划你的方案。
3. 完成 issue 中要求的工作。
4. 提交结果：`symphony emit-result --data-json '<JSON>'`（或 `--data-json='<JSON>'`）。合法的 JSON 对象/数组会作为结构化数据发送；纯文本必须包装为 JSON 字符串，例如 `"summary"`。
5. 结束会话：`symphony session-completed --semantics success --summary "<summary>"`

**不要运行管理命令，例如 `symphony issue list` 或 `symphony issue get`。** 它们需要 `API_TOKEN`，在 agent 会话内会返回 401。agent 命令（`fetch-issue`、`emit-result`、`session-completed`、`report-event`）使用由包装器自动加载的 agent 级 token。

## 可用命令

以下所有命令**首先以 CLI 形式**展示；MCP 等价形式仅作为备选列出。

### 必需（每个会话）

- **CLI：** `symphony fetch-issue`
  - MCP：`symphony.fetch_issue`
  - 获取当前 issue 详情和编排上下文。**在会话开始时调用一次。**
- **CLI：** `symphony emit-result --data-json 'Created hello.txt and verified content.'`
  - MCP：`symphony.emit_result`
  - 在完成前提交结构化结果。**必须在 `session_completed` 之前调用。** 参见下文“使用 emit_result 提交结果”。
- **CLI：** `symphony session-completed --semantics success --summary "Task completed"`
  - MCP：`symphony.session_completed`
  - 标记会话完成。**退出前必须调用。** 完整 schema 见下文。

### session_completed 完整 schema

```
{
  semantics: "success" | "needs_retry" | "handoff" | "abandoned",
  summary?: string,             // Optional: what happened (markdown OK)
  handoff_state?: string,       // Target state if semantics=handoff (e.g. "in_review")
  blocker_fingerprint?: string, // Stable identifier of the blocker (e.g. "sandbox_denied:/path")
  termination_cause?: string,   // Why session ended: task_done | error_threshold | context_done | ...
  artifacts?: Artifact[],       // Typed artifacts for the reviewer (max 50)
  follow_ups?: string[],        // Plain-text follow-up items (max 20)
}
```

`blocker_fingerprint` 字段启用了 symphony 的同因短路机制：如果连续尝试中出现相同的指纹，symphony 会跳过后续重试，并将该 issue 标记为 blocked。

### Artifacts

`artifacts` 数组支持以下可判别类型：

| kind | 字段 | 使用场景 |
|------|------|----------|
| `file_diff` | path, diff?, additions?, deletions? | 已修改文件的摘要 |
| `file_added` | path, bytes?, preview? | 新建的文件 |
| `file_removed` | path | 已删除的文件 |
| `file_renamed` | from, to | 已重命名/移动的文件 |
| `screenshot` | path, caption? | 可视化证据 |
| `log_excerpt` | label, content | 相关的日志片段 |
| `url` | label, href | 外部引用 |
| `command_output` | label, cmd, exit_code?, output | 命令执行结果 |
| `note` | label, markdown | 自由格式的备注 |

### 推荐（适用时）

- **CLI：** `symphony report-event --kind progress --message "Implemented user login endpoint"`
  - MCP：`symphony.report_event`
  - 报告有意义的进展、决策、阻塞和验证结果。常用的 `kind` 值：`progress`、`tool_call`、`validation`、`error`、`blocker`。
  - `--kind progress` 和 `--kind=progress` 两种写法均可。
- **CLI：** `symphony report-goal-state --last-reason "hello.txt created and verified"`
  - MCP：`symphony.report_goal_state`
  - 报告你对 `/goal` 评估器状态的看法。
- **CLI：** `symphony suggest-state-transition --state in_review --reason "Ready for human review"`
  - MCP：`symphony.suggest_state_transition`
  - 提议一个目标状态。仅供参考 — symphony 会根据 `state_transitions` 配置进行路由。
- **CLI：** `symphony request-workflow-section --section "Testing guidelines"`
  - MCP：`symphony.request_workflow_section`
  - 按名称获取工作流 Markdown 的特定小节。
- **CLI：** `symphony get-artifact --artifact-id <id> --mode tail --lines 50`
  - MCP：`symphony.get_artifact`
  - 读取已存储的 artifact。模式：`full` | `head` | `tail` | `search`。
- **CLI：** `symphony update-issue-scratchpad --text "Continue from module B refactor"`
  - MCP：`symphony.update_issue_scratchpad`
  - 为下一次调用持久化一条简短备忘（≤4 KB）。

### Plan 运行

- **CLI：** `symphony spawn-plan-run --script plan.js --meta-json '{"name":"Refactor auth","max_issues":5}'`
  - MCP：`symphony.spawn_plan_run`
  - 分发一个 JS plan 脚本并各自独立继续执行。返回 `run_id`。即发即忘。
- **CLI：** `symphony spawn-plan-run-and-handoff --script plan.js --meta-json '{"name":"Refactor auth","max_issues":5}'`
  - MCP：`symphony.spawn_plan_run_and_handoff`
  - 分发一个 JS plan 脚本，并暂停当前 issue 直到 plan 完成。

## 使用 emit_result 提交结果

每个 issue **必须**在 `session_completed` 之前调用 `symphony.emit_result`。这是 Symphony 为调用方、评审者和下游 plan 运行捕获结构化输出的方式。

- 如果 issue 的 prompt 中包含 `<output_schema>` 块，`emit_result.data` 必须符合该 JSON Schema。Symphony 会在接收时进行校验。
  - 如果校验失败，你可以在同一会话中重试：用修正后的 `data` 再次调用 `emit_result`。
- 如果没有 `<output_schema>`，则传入一个概括结果的纯字符串（≤ 32 KB）。

```bash
# CLI: string result (wrap plain text as a JSON string)
symphony emit-result --data-json '"Refactored authentication module. Tests pass."'

# CLI: structured JSON result (sent as-is, preferred when an output_schema is present)
symphony emit-result --data-json '{"summary":"...","files_changed":3}'

# MCP fallback: with schema
symphony.emit_result({ data: { summary: "...", files_changed: 3 } })

# MCP fallback: without schema
symphony.emit_result({ data: "Refactored authentication module. Tests pass." })
```

始终在 `session_completed` **之前**调用 `emit_result`。

## 强制性 plan 要求

如果 issue 设置了 `require_plan: true`，你**必须**在实现任何内容之前派生一个 plan 运行。prompt 中会包含 `## Plan First` 指令。未派生 plan 将触发重试。

使用 `symphony spawn-plan-run-and-handoff` 分发 plan 脚本，并暂停当前 issue 直到 plan 完成。plan 完成后，你将带着注入到 prompt 中的结果被重新调度。

## 使用 plan 分解任务

当某个 issue 需要协调大量子任务时，编写一个内联 JavaScript plan 脚本，并用 `spawn_plan_run_and_handoff` 分发它。Symphony 会先试运行（dry-run）该脚本，向人工展示摘要以待批准，然后执行它并带着结果重新调度你。

### Plan 脚本 SDK

以下全局变量会被注入到 plan 脚本中（无需 `require`/`import`）：

| 全局变量 | 说明 |
|----------|------|
| `args` | 通过 `spawn_plan_run{…, args}` 传入的参数 |
| `issue(prompt, opts?)` | 分发一个子 issue。返回该 issue 的 `emit_result.data`（schema 类型化）或字符串摘要。 |
| `parallel(thunks)` | 并发运行多个 thunk。按顺序返回结果数组。 |
| `pipeline(items, ...stages)` | 将每个 item 依次通过每个 stage 处理。 |
| `dag(nodes, edges)` | 逐层运行子 issue 的依赖图。prompt 可通过 `{{nodeId}}` 引用前驱节点的结果。 |
| `phase(title)` | 标记当前阶段（在 dry_run_summary 中可见）。 |
| `log(msg)` | 向 plan 日志追加一条消息。 |
| `budget` | `{ total, spent(), remaining() }` — token 预算跟踪。 |
| `list_artifacts(issue_id)` | 列出已完成子 issue 产出的 artifacts。 |
| `get_artifact(artifact_id)` | 获取 artifact 内容。 |

`issue()` 的 `IssueOpts`：

```ts
{
  schema?: object,        // JSON Schema for emit_result.data validation
  agent_kind?: string,    // "nano" | "claude-code"
  prompt?: string,        // Override prompt (default: first arg to issue())
}
```

### 示例：先调研再实现

```js
phase("Research");
const analysis = await issue(
  "Analyse the current auth module and summarise its pain points",
  { schema: { type: "object", properties: { pain_points: { type: "array", items: { type: "string" } } }, required: ["pain_points"] } }
);

phase("Implement");
await parallel(analysis.pain_points.map(point =>
  () => issue(`Fix: ${point}`)
));
```

### 约束

- `meta` 必须是脚本中的**字面量对象**（不能动态构造）：`{ name: "...", max_issues: N }`。
- **禁止使用的全局变量：** `Date`、`Date.now()`、`new Date()`、`Math.random()`、`require`、`import`、`process`、`globalThis`。这些在 plan 沙箱中不存在 — 通过省略来强制确定性。
- Plan **不能**嵌套。由 plan 运行创建的子 issue 自身不能再派生 plan 运行。使用 `emit_result` 返回结构化数据；调用方 issue 可以在再次进入时派生更多 plan。
- 脚本大小限制：64 KB。

## 评论与修订

Symphony 支持在 agent 运行期间进行操作员交互：

- **评论：** 操作员可通过 API（`POST /api/v1/issues/:id/comments`）添加评论。在下一次尝试时，所有评论会自动作为 `## Operator comments` 小节注入到 agent 的 prompt 中（最多 50 条评论，16KiB）。
- **修订请求：** 当评审者调用 `POST /api/v1/issues/:id/request-changes` 并附带 `note` 时，issue 状态会回退为 `todo`，且该 note 会作为 "Reviewer requested changes: ..." 注入到下一次尝试的 prompt 中。请在你的回复中处理这些 note。
- **重新触发：** 操作员可通过 `POST /api/v1/issues/:id/retrigger` 重新触发已完成/已放弃的 issue。这会重置状态和 blocker 指纹，使 orchestrator 重新分发。

## 沙箱限制

你的 `run_shell_command` 被进程沙箱包裹。你可以：

- 在 `$SYMPHONY_WORKSPACE` 内读写文件（这是你的工作区）。
- 读取 `/usr`、`/bin`、`/etc` 中的系统命令。
- 在 `/tmp` 下写临时文件（注意：tmpfs，退出后即消失）。
- 网络访问（HTTP / DNS — `git clone`、`pip` 等需要用到）。

你**不可以**：

- 写入 `$SYMPHONY_WORKSPACE` 之外的位置（不能写 `~/`、`/etc` 或其他路径）。
- 读取敏感路径：`~/.ssh/`、`~/Library/Keychains`、`~/.aws/` 等。
- 看到 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`AWS_*`、`GITHUB_TOKEN` 等环境变量。
  （这些被有意从你的 shell 环境中剥离 — 它们属于 nano-agent 本身，
  而不属于你运行的命令。）

如果你需要访问一个无法触及的挂载路径，请**通过
`symphony.report_event` 报告阻塞**，并请用户在工作流 YAML 的
`agent.sandbox.extra_read_only_paths` 下添加该路径。

如果某个命令意外以 `Operation not permitted` 失败，**不要循环重试**
— 这是沙箱限制，而非临时性错误。报告该阻塞，然后要么在沙箱内
想办法绕过，要么提议修改工作流配置。

## 必需的工作流程

1. **必须首先执行的操作 — `symphony fetch-issue`**：在做任何改动之前获取当前 issue。在此步骤之前不要调用 `discover_skills` 或任何其他工具。
2. 检查仓库，找出能满足该 issue 的最小安全改动。
3. 当你完成一个有意义的工作单元、遇到阻塞或完成验证时，报告进展。
4. 在适用时，使用仓库现有的测试、lint 或构建命令验证改动。
5. 在退出前，调用 `symphony.emit_result` 提交结果数据（或摘要字符串）。
6. 在退出前，调用 `symphony.session_completed`，即使任务无法完成。

## 报告指南

报告简洁、可操作的事件。包括：

- 改动了什么或发现了什么。
- 运行过的任何验证命令及其结果。
- 影响最终结果的阻塞或假设。
- 调用 `symphony.session_completed` 时的最终状态。

不要报告环境中的密钥、token 或其他敏感值。

## 完成检查清单

在结束会话之前：

- 确认所请求的 issue 已得到处理，或清楚解释为何无法处理。
- 确认相关验证已通过、因改动仅涉及文档而跳过，或解释任何失败原因。
- 调用 `symphony.emit_result` 提交结构化结果或纯字符串摘要。
- 调用 `symphony.session_completed` 并附上结果的语义。
- 如需移交给评审者，请附带 `artifacts` 和 `follow_ups`，以尽量减少上下文切换的成本。
