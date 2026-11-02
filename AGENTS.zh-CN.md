# AGENTS.md — nano-symphony

[English](./AGENTS.md)

本文件为在 `nano-symphony` 上工作的编码 agent 提供上下文信息。

## 项目概览

`nano-symphony` 是一个用于 agentic issue 解决的本地编排器（orchestrator）。它：

- 暴露一个 HTTP 控制平面和一个 MCP 服务器。
- 派生 `nano-agent` 或 `claude-code` 子进程来处理 issue。
- 管理一个存储 issue、计划运行（plan run）、事件和产物的 SQLite 数据库。
- 从 `frontend/` 提供 SolidJS 仪表盘。

## 工具链

- **运行时/包管理器**：[Bun](https://bun.sh)（必需）。
- **语言**：TypeScript，启用 strict 模式。
- **前端**：SolidJS + Vite。
- **数据库**：通过 `bun:sqlite` 使用 SQLite。

## 常用命令

```bash
# Install dependencies
bun install
cd frontend && bun install

# Type check (no emit)
bun run lint

# Run backend tests
bun test tests/unit tests/*.test.ts
bun test tests/integration --concurrency 1
bun test tests/e2e --concurrency 1

# Run frontend tests
bun run test

# Build frontend bundle
bun run build

# Start dev server
bun run dev
```

## 架构

- `src/http/routes/` — 按领域划分的 Hono 路由模块，由 `src/http/routes/index.ts` 挂载。
- `src/db/` — SQLite 模式、迁移和数据访问。
- `src/orchestrator/` — 基于 tick 的调度器和 worker 生命周期管理。
- `src/spawner/` — 用于派生 nano-agent / claude-code 的适配层。
- `src/mcp/` — MCP 服务器和工具处理器。
- `src/plan-runtime/` — 计划运行脚本的执行环境。
- `src/workflow/` — WORKFLOW.md 解析和模板渲染。
- `src/prompt/` — 基于 Liquid 的 prompt 渲染。
- `frontend/src/` — SolidJS 仪表盘。

## 编码规范

- 优先使用显式类型，避免 `as` 断言。
- 保持路由处理器精简；将业务逻辑委托给 tracker 辅助函数或领域模块。
- 对于可选的字符串 API 字段，使用 `src/http/routes/schemas.ts` 中的 `nullishString()`。
- 环境配置位于 `src/config.ts`，并使用 Zod 进行校验。
- 绝不要记录密钥（API token、MCP 会话 token）。
- 数据库迁移必须是幂等的，且只允许追加。

## 测试

- 后端测试使用 `bun:test`。
- 集成测试创建内存中的 Hono 应用。
- E2E 测试使用一个模拟 agent 响应的调试适配器。
- 前端测试使用 Vitest + `@solidjs/testing-library`；全局 mock `fetch` 以避免未处理的 rejection。

## 安全注意事项

- `API_TOKEN` 拒绝空字符串，且当 `HOST` 非回环地址时为必填。
- Agent 子进程不会收到 `API_TOKEN` 或 `SYMPHONY_API_TOKEN`。
- 其他环境变量会转发给 agent，以便 `PATH` 和各类服务商 API 密钥等工具正常工作。
- 安装脚本会以 `600` 权限写入 `.env`。
