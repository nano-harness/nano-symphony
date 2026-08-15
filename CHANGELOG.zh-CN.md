# 更新日志

[English](./CHANGELOG.md)

nano-symphony 的所有重要变更都会记录在本文件中。

本文件格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)，
且本项目遵循 [语义化版本规范](https://semver.org/spec/v2.0.0.html)。

## [0.9.6] - 2026-06-23

### Added
- **结构化事件时间线**：`frontend/src/EventTimeline.tsx` 将 `tool_call`/`tool_result` 事件配对分组，显示尝试分隔符，并高亮 >10s（warm）与 >30s（hot）的时间差。
- **Claude Code tool_result 事件**：`src/spawner/adapters/claude-code.ts` 现在会解析 `tool_result` 的 stream-json 行，使仪表盘能显示完整的工具调用对。
- **回归测试**：`tests/unit/install-wrapper.test.ts`、`tests/unit/claude-code-adapter.test.ts` 以及 `frontend/src/__tests__/EventTimeline.vitest.tsx`。

### Fixed
- **Wrapper `report-event --kind`**：生成的 `symphony` wrapper 现在同时接受 `--kind progress` 和 `--kind=progress`（`--message`、`--payload-json` 同理）。
- **`emit-result` 结构化数据**：本身已是合法 JSON 的 `--data-json` 值会直接嵌入，不再被二次字符串化；纯文本仍会回退为 JSON 字符串包装。
- **`Abort trap: 6` stderr 噪音**：`print_json` 现在使用 `python3 -m json.tool`，取代会产生 SIGABRT 杂音的 `node -e` 管道。
- **`emit_result` 服务器错误处理**：存储的 `expected_schema` 格式错误时不再触发裸 500；处理器会返回清晰的校验错误。
- **IssueDetail 实时刷新**：SSE 现在会对所有实质性事件刷新 issue/run 状态，而不仅是 `retrigger_requested`。

### Changed
- **WORKFLOW 模板**：`templates/WORKFLOW.example.md` 与 `WORKFLOW.md` 现在包含 `## Mandatory startup sequence`，要求以 `symphony fetch-issue` 作为第一个动作。
- **Skill 文档**：`skills/nano-symphony/SKILL.md` 记录了修正后的 `report-event` 语法、`emit-result` 的 JSON 对象支持以及强制启动序列。

## [0.9.5] - 2026-06-16

### Added
- **社区文件**：`AGENTS.md`、`CONTRIBUTING.md` 与 `CODE_OF_CONDUCT.md`。
- **回归测试**：`tests/unit/config.test.ts` 覆盖了空 `API_TOKEN`、无 token 的非 loopback `HOST`，以及 `createHttpServer` 中的空 `apiToken` 选项。

### Fixed
- **HTTP 认证**：`createHttpServer` 现在会拒绝空的 `apiToken` 选项；携带空 token 的请求会被视为未认证，而不是绕过认证。
- **Issue 标识符**：`insertIssue` 会将生成的 `TASK-N` 标识符持久化到数据库，且 `updateIssue` 在未提供标识符时会保留已有标识符。

### Changed
- **文档**：`docs/WORKFLOW-INTERNALS.md`、`docs/WORKFLOW-reference.md` 以及 `docs/adr/001-multi-agent-roles-and-shared-contract.md` 已更新，以反映 git-diff 产物收集与通用的 nano-agent orchestrator 契约。

### Breaking Changes — Schema Redesign (requires manual DB wipe before upgrade)

> ⚠️ **合并前必须执行的操作**：运行 `rm ~/.local/share/nano-symphony/symphony.db` 清空现有数据库。新 schema 与旧 schema 不兼容，且不提供迁移。此后所有服务器启动都将基于新 schema 初始化一个干净的数据库。

- **`issues.id` 现在是 `INTEGER PRIMARY KEY AUTOINCREMENT`**（原为 `TEXT` nanoid）。自增整数稳定、无竞争且为 O(1)。
- **`issues.uuid`**（新列）：保存原来的 nanoid 字符串（原 `issues.id`）。
- **`issues.identifier` 列已删除**：改为在应用层即时计算为 `TASK-${id}`；不再存储于数据库。
- **7 张表中的外键列重命名**：`issue_id` → `issue_uuid`、`blocker_id` → `blocker_uuid`、`caller_issue_id` → `caller_issue_uuid`（受影响的表：`issue_labels`、`issue_blockers`、`symphony_runs`、`symphony_events`、`issue_comments`、`symphony_artifacts`、`issue_results`、`plan_runs`）。
- **`idx_issues_identifier` 索引已删除**（该列已不存在）。
- **HTTP API — `POST /api/v1/issues`**：发送 `id`、`identifier` 或 `uuid` 字段现在会返回 `400` 及明确的错误信息。
- **HTTP API — URL 参数**：所有 `/api/v1/issues/:id` 路径参数更名为 `/api/v1/issues/:uuid`。
- **HTTP API — GET 响应**：issue 现在包含 `id`（整数）和 `uuid`（nanoid 字符串）。`identifier` 字段（`TASK-N`）仍然存在，但为计算值。
- **环境变量**：worker 子进程环境中的 `SYMPHONY_ISSUE_ID` 更名为 `SYMPHONY_ISSUE_UUID`。
- **前端排序**：issue 列表现在按 `id`（整数）而非 `identifier` 字符串排序，修复了字典序问题（例如 TASK-10 不再排在 TASK-2 之前）。
- **Wrapper**：`install.sh` 中的 `next_identifier()` 函数已移除；`symphony issue create` 不再发送 `identifier` 字段。

### Added
- **Bundle 分发**：`scripts/build-bundle.sh` 使用 `bun build --minify --target=bun` 产出单个压缩的 `index.js`（约 484 KB），并与 `share/frontend/dist/`、`share/skills/`、`share/templates/` 及 `share/VERSION` 一起打包成约 5 MB 的 tarball。
- **`src/paths.ts`**：集中式的资源根目录解析。读取 `SYMPHONY_SHARE_ROOT` 环境变量（由 wrapper 在运行时设置），并为 bundle 布局目录提供 CWD 回退；两者都找不到时直接报错失败。
- **全局 skill 安装**：`install.sh` 现在会在每次安装/更新时将 `share/skills/nano-symphony/` 复制到 `~/.nano/skills/nano-symphony/`，若 `~/.claude/` 存在则同时复制到 `~/.claude/skills/nano-symphony/` —— 无需逐工作区同步。
- **CI 冒烟测试**：发布工作流在发布前会对解压后的 bundle 运行 `curl /api/v1/health`。

### Changed
- **`install.sh`** 已为 bundle 分发重写：不再执行 `bun install`；升级时会清理源码模式残留（`src/`、`node_modules/`、`package.json` 等）；WORKFLOW 模板取自 `share/templates/`；版本从 `share/VERSION` 读取。
- **Wrapper `start`** 现在以设置好 `SYMPHONY_SHARE_ROOT` 的方式运行 `exec bun ${INSTALL_DIR}/index.js`；`version` 读取 `share/VERSION`。
- **发布 CI** 在所有 job 中将 Bun 固定为 `1.2.x`；`build` job 由 `scripts/build-bundle.sh` 取代；`meta.json` 新增 `built_with` 字段。
- **`src/http/server.ts`**：静态根目录改为通过 `paths.ts` 从 `FRONTEND_DIST` 解析，不再使用 `SYMPHONY_STATIC_ROOT` 环境变量。

### Removed
- **`syncSkillsIfMissing`** 函数已从 `src/workspace/manager.ts` 移除；skill 分发现在完全由 `install.sh` 负责，写入 agent 全局目录。

### Breaking
- **bundle 安装中的 `symphony dev | build | test | lint`** 子命令现在会以退出码 64 退出并给出明确错误。源码模式开发需要 `SYMPHONY_SHARE_ROOT=$(pwd) bun --watch src/index.ts`。
- **`symphony version`** 读取 `share/VERSION` 而非 `package.json`。缺少 `share/VERSION` 的源码安装应设置 `SYMPHONY_SHARE_ROOT`。

### Added
- **Plan Runs**：新增 `plan_runs` 表 —— agent 编写内联 JS 脚本来编排子 issue 的扇出（fan-out），支持 dry-run、人工审批与结构化结果输出。支持 `pending → dry_running → awaiting_approval → running → done/failed/cancelled` 生命周期。
- **Issue Results**：新增支持版本化 upsert 的 `issue_results` 表；`emit_result` 按 `(issue_id, attempt, version)` 存储结构化输出。
- **MCP Tools — 新增**：`symphony.emit_result`、`symphony.spawn_plan_run`、`symphony.spawn_plan_run_and_handoff`、`symphony.get_artifact`、`symphony.update_issue_scratchpad`。
- **MCP Tools — session_completed**：`summary` 现在为可选；`metrics` 字段已废弃（不再被消费）。
- **Issues — 新列**：`plan_run_id`、`expected_schema`、`scratchpad`（自动迁移）。
- **Wait States**：新增 `awaiting_plan` 等待状态；`getCandidatesStmt` 会将其排除在调度之外，因此处于 plan 暂停状态的 issue 不会被重新派发。
- **Orchestrator — Plan 子循环**：四个新的幂等 tick 循环：`tickPendingPlans`（dry-run）、`tickApprovedPlans`（开始执行）、`tickFinalizedPlans`（恢复调用方）、`tickExpiredPlans`（墙钟时间强制，默认 7 天）。
- **Plan Runtime — Sandbox**：`node:vm` 沙箱，最小化注入（无 `Date`、`Math.random`、`require`、`import`、`process`、`globalThis`）。仅提供确定性全局对象：`issue()`、`parallel()`、`pipeline()`、`phase()`、`log()`、`args`、`budget`、`list_artifacts()`、`get_artifact()`。
- **Plan Runtime — Dry-run**：符号化执行，`dryRunStub` 生成基于 schema 的桩；记录预估的 issue 数量、阶段与 token 区间。
- **Plan Runtime — 崩溃恢复**：位于 `${SYMPHONY_DATA}/plan-runs/<id>/journal.jsonl` 的 JSONL 日志支持进程重启后的恢复。
- **HTTP API — Plan Runs**：`POST /plan-runs`、`GET /plan-runs`、`GET /plan-runs/:id`、`GET /plan-runs/:id/result`（长轮询）、`POST /plan-runs/:id/approve`、`POST /plan-runs/:id/reject`、`POST /plan-runs/:id/request-changes`、`DELETE /plan-runs/:id`。
- **Worker — 重入 Prompt**：当调用方 issue 在 plan run 之后恢复时，prompt 会注入 `<previous_invocations>`（脚本摘录、结果、产物索引、scratchpad）和 `<output_schema>`。
- **SKILL.md**：新增 "Decomposing tasks with plans" 与 "Submitting results with emit_result" 章节；更新了工具列表；本地循环 SKILL.md 增加了 plan-run 问题的故障排查内容。

### Removed
- **MCP Tools — 已退役**：`symphony.create_issue`、`symphony.activate_issue`、`symphony.submit_plan`。issue 创建现在仅通过 HTTP 或 plan 执行器进行。调用这些工具会返回作用域错误。
- **Planning Mode**：issue 的 `planning` 与 `plan_review` 状态已移除。`agent.planning` 配置键已废弃（被忽略）。`POST /issues/:id/approve-plan` 与 `/revise-plan` 路由已移除。斜杠命令 `/revise` 与 `/skip-plan` 已移除。
- **Worker**：`planningPrefix` 与 `plan_revision` 的 prompt 注入已移除。

### Added (previous)
- **Permissions**：`agent.permission_auto` 现在支持 `allow_rules`、`denial_max_consecutive` 与 `denial_max_total`（严格校验）。`allow_rules` 是 symphony 暴露的唯一信任声明入口。
- **二进制结果交付**：nano-agent 二进制会话通过 `.nano.yaml.hooks.Stop` 向工作区级 `result-hook.sh` 上报结果，后者再 POST 到 `POST /agent-result`（不再解析 stdout 哨兵）。
- **Sandbox**：Spawner 为原生沙箱后端注入 `sandbox.denied_write_paths: ["~/.config/nano"]`，以防止写入用户配置层。
- **Observability**：Orchestrator 的尝试输出写入 symphony 自有的 `./run_log.jsonl`（路径可通过 `RUN_LOG_PATH` 配置；通过 `RUN_LOG_ENABLED` 开关）。不写入 nano-agent 的 `~/.nano/task_log.jsonl`。
- **MCP**：`symphony.session_completed` 接受 `blocker_fingerprint` 与 `termination_cause` 参数，支持短路逻辑与结构化失败追踪。
- **Database**：`issues` 表新增 `last_blocker_fingerprint` 列（自动迁移）。
- **Database**：`symphony_runs` 表新增 `current_attempt` 列，用于追踪正在运行的尝试（自动迁移）。
- **Event Bus**：内存事件总线，用于跨 SSE 连接的实时状态变更通知。
- **SKILL**：SKILL.md 记录了 `blocker_fingerprint` 的用法与沙箱默认值。

### Fixed
- **Spawner (claude-code)**：`--allowedTools` 模式从 `mcp__symphony__*` 修正为 `symphony.*`，使 Claude Code 能直接发现并调用 Symphony MCP 工具（`symphony.fetch_issue`、`symphony.emit_result`、`symphony.session_completed` 等），而不再回退到 Bash/curl。
- **Orchestrator**：新认领的 run 现在会立即设置 `heartbeat_at`，避免首个进程级心跳触发前（nano 30s / claude-code 60s）的过期误判。
- **HTTP API**：`POST /issues` 与 `PUT /issues/:uuid` 现在接受 `agent_binary`，补全了从 API → tracker → worker → spawner 的逐 issue agent 二进制覆盖链。
- **Spawner**：agent 结果摘要 schema 从 `.strict()` 改为 `.passthrough()` —— 此前 `.strict()` 会拒绝 agent 诊断字段（`termination_cause`、`cache_key` 等），导致合法 run 被误分类为 `no_result_payload`/`abandoned`。
- **Orchestrator**：同一 blocker fingerprint 出现 ≥ 2 次时自动短路到 `blocked` 状态，避免浪费 `max_retries` 次运行（节省约 50% 的 LLM token）。
- **Orchestrator**：agent 静默终止现在会合成 `session_completed_synthetic` 事件，携带结构化的 `blocker_fingerprint` 与 `termination_cause`，在 LLM 未调用 MCP 时保留失败原因。
- **Spawner**：自动注入平台默认的只读路径，使 git/vwsd/pipx 等工具在原生沙箱下默认可用（macOS 和 Linux）。macOS 添加 `/opt/homebrew`、`/usr/local`、`/Library/Developer/CommandLineTools`、`/Applications/Xcode.app/Contents/Developer`、`~/.local`、`~/.bun`、`~/.cargo`、`~/.rustup`；Linux 添加 `/opt`、`~/.local`、`~/.bun`、`~/.cargo`、`~/.rustup`、`~/.nvm`、`~/.pyenv`。
- **Live Transcript**：agent 的 stdout/stderr 现在随数据到达即流式写入日志文件，支持执行过程中的实时 transcript 显示。
- **SSE Logs**：移除了日志 SSE 端点的 30 秒超时；长时间运行的任务（≥5 分钟）现在可以正常工作，并能优雅地检测终止。
- **SSE Events**：从 2 秒轮询切换为基于事件总线的推送模型；P50 刷新延迟从约 2s 降至约 100ms。
- **State Refresh**：Score Sheet（state、attempt、tokens、workspace）通过 SSE 的 run 事件在取消/暂停/认领时立即更新。
- **SSE Reliability**：前端在出错时以指数退避（1s 到 10s）重连日志 SSE；10 秒兜底轮询确保 SSE 断开后能够恢复。
- **Attempt Tracking**：前端订阅 `current_attempt` 而非 `next_attempt`，修复了重试循环后日志显示陈旧的问题。

### Changed
- **Workflow**：成功时清除 fingerprint，防止跨 issue 污染。
- **Workflow Schema**：`agent.permission_auto` 现在为 `.strict()`；未知键会在加载时被拒绝。
- **Protocol**：移除了二进制会话的 stdout 哨兵解析；Stop hook 交付是唯一接受的完成信号。缺失 payload 会被归类为 `no_result_payload`。
- **Event Bus**：所有 tracker 状态变更（releaseIssue、claimIssue、scheduleRetry、updateTokenStats、updateWorkspacePath、markCurrentAttempt）现在都会发出总线事件。
- **HTTP Routes**：`/events/stream` 支持 `Last-Event-ID` 头用于重连后补发；`/logs/:issueId/:attempt` 接受 "current" 作为 attempt 参数。
- **Frontend**：仪表盘按可见的 issue ID 过滤 SSE 事件，以减少不必要的重载。
