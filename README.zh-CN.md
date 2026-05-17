# nano-symphony

[English README](./README.md)

nano-symphony 是一个轻量级的编码 Agent 编排服务。它使用 SQLite 保存 Issue 状态，为每个任务创建独立工作区，启动配置好的 Agent 进程，并通过 MCP 服务接收 Agent 的进度回报。同时，项目还提供一个简单的 Web 控制台，用于查看任务、运行状态、事件日志和编辑工作流提示词。

## 功能特性

- **Issue 跟踪 API**：通过 HTTP 接口创建、列出、更新和查看本地 Issue。
- **Agent 编排**：轮询可执行的 Issue，声明任务，启动配置的 Agent，并对失败任务进行退避重试。
- **工作区管理**：为每个 Issue 准备独立工作区，并支持可选生命周期 Hook。
- **MCP 集成**：提供 Symphony 工具，供 Agent 获取当前任务、报告进度和 goal 状态、更新 Token 统计、读取工作流片段、建议状态流转和标记会话完成。
- **工作流模板**：加载带 YAML front matter 的 Markdown 工作流文件，并将正文作为 Agent 提示词模板。
- **Web 控制台**：基于 Solid/Vite，支持浏览 Issue、查看活跃运行和事件、流式读取日志、编辑工作流文档。

## 仓库结构

```text
.
├── src/                  # Bun TypeScript 后端
│   ├── db/               # SQLite 迁移和 Tracker 持久化
│   ├── http/             # HTTP API 路由和服务组装
│   ├── mcp/              # MCP 服务和 Symphony 工具处理
│   ├── orchestrator/     # 调度器、Worker、重试和工作区流程
│   ├── spawner/          # Agent 进程启动
│   ├── workflow/         # 工作流加载和校验
│   └── workspace/        # 工作区准备和 Hook
├── frontend/             # Solid/Vite 控制台
├── templates/            # 示例工作流模板
├── skills/               # Symphony 会话中的 Agent Skill 文档
├── tests/                # 单元测试和集成测试
├── .env.example          # 运行时配置默认值
└── package.json          # Bun 脚本和后端依赖
```

## 环境要求

- [Bun](https://bun.sh/)：用于安装依赖、运行后端、执行测试和构建前端。
- 一个兼容的编码 Agent 可执行文件，需要位于 `PATH` 中，或通过 `NANO_BIN` / 工作流配置指定。默认二进制名称为 `nano`。

## 下载

### 一键安装（推荐）

需要先安装 [Bun](https://bun.sh/)。

```bash
curl -sSL https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh | bash
```

该命令会下载最新发布包、安装依赖，并在 `~/.local/bin` 创建 `symphony` 启动器。

安装完成后，启动服务：

```bash
symphony start
```

如需更新已安装版本，运行：

```bash
symphony update
```

`update` 命令会读取 OSS 发布元信息，从元信息中下载发布的安装脚本，并使用当前安装目录和二进制目录重新运行。已有的 `.env`、`WORKFLOW.md`、数据库和工作区会保留；更新后请重启正在运行的服务。

### 手动下载

预构建的发布包和 Skill 文件托管在 OSS 上。

| 资源 | 地址 |
| --- | --- |
| 最新发布包 | `https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/latest/nano-symphony.tar.gz` |
| 发布元信息 | `https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/meta.json` |
| 最新 Skill | `https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/skills/nano-symphony/SKILL.md` |
| 安装脚本 | `https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh` |

历史版本请查看 [GitHub Releases](https://github.com/nano-harness/nano-symphony/releases) 页面。

## 快速开始

### 使用安装脚本

1. 运行安装脚本（见 [下载](#下载)）：

2. 检查并编辑配置文件：

   ```bash
   ~/.local/share/nano-symphony/.env
   ~/.local/share/nano-symphony/WORKFLOW.md
   ```

3. 启动服务：

   ```bash
   symphony start
   ```

### 手动设置

1. 安装依赖并创建本地 `.env` 文件：

   ```bash
   ./scripts/init-project.sh
   ```

   也可以手动执行等价命令：

   ```bash
   cp .env.example .env
   bun install
   ```

2. 创建工作流文件：

   ```bash
   cp templates/WORKFLOW.example.md WORKFLOW.md
   ```

3. 启动后端服务：

   ```bash
   bun run start
   ```

   开发时可使用监听模式：

   ```bash
   bun run dev
   ```

4. HTTP API 默认地址为 `http://localhost:4123/api/v1`，MCP 端点为 `http://localhost:4123/mcp`。

## 前端控制台

前端位于 `frontend/`，根目录的构建脚本会构建前端资源。

```bash
bun run build
```

本地开发前端时，在前端目录启动 Vite：

```bash
cd frontend
bun run dev
```

控制台包含以下路由：

- `/`：Issue 列表和过滤。
- `/issues/:id`：Issue 详情、事件、控制操作和日志流。
- `/workflow`：工作流文档编辑器。

## 配置

运行时配置来自环境变量，并在启动时进行校验。默认值见 `.env.example`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `4123` | HTTP 服务端口。 |
| `DB_PATH` | `./symphony.db` | SQLite 数据库路径。 |
| `WORKFLOW_PATH` | `./WORKFLOW.md` | 工作流 Markdown 文件路径。 |
| `NANO_BIN` | `nano` | 默认 Agent 二进制。 |
| `WORKSPACE_ROOT` | `./workspaces` | 生成工作区的根目录。 |
| `LOG_LEVEL` | `info` | Pino 日志级别。 |
| `MAX_CONCURRENT_AGENTS` | `3` | 最大并发 Agent 运行数。 |
| `MCP_TOKEN_TTL_MS` | `3600000` | MCP Token 有效期，单位毫秒。 |
| `ORCHESTRATOR_TICK_MS` | `5000` | 编排器轮询间隔，单位毫秒。 |

## 沙箱

nano-symphony 启动 nano-agent 时，默认强制开启进程沙箱：

| 平台 | 后端           | 默认隔离 |
|----------|-------------------|-------------------|
| Linux    | Bubblewrap (bwrap) | mount + pid + user namespaces；HOME → workspace；清洗环境变量 |
| macOS    | sandbox-exec      | 路径 + 网络默认拒绝；清洗环境变量（仅保留 NANO_*/PATH/TERM/LANG/LC_ALL） |

**这意味着 Agent 的 `run_shell_command` 无法：**

- 在 `<workspace>`、`/tmp` 或 `extra_writable_paths` 之外写入文件
- 读取敏感文件，如 `~/.ssh/`、`~/Library/Keychains`（macOS）、`~/.aws/` 等
- 看到 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`SSH_AUTH_SOCK` 等机密环境变量
  （LLM 提供商调用在 nano-agent 主进程中进行，主进程可以看到这些变量——
  限制仅针对 Agent 启动的 shell 子进程）

**默认允许网络访问**，因为 Agent 必须通过 MCP 回调 symphony。若要限制 Agent shell 的出站网络，
请在 symphony 宿主机上添加防火墙规则（沙箱无法按主机白名单）。

**自定义配置**，在工作流 YAML 中设置 `agent.sandbox`：

```yaml
agent:
  sandbox:
    backend: native | docker | none
    network_access: true
    extra_read_only_paths: ["/Users/me/.gitconfig"]
    extra_writable_paths: []
    docker_image: ubuntu:24.04        # 仅当 backend=docker 时使用
    docker_runtime: runsc             # 可选：gVisor (runsc) 或 Kata 以获得更强隔离
```

**禁用沙箱**（不推荐——接受 Agent 执行的全部风险）：

```yaml
agent:
  sandbox:
    backend: none
```

### 需要的 nano-agent 版本

本沙箱集成假设 nano-agent 支持沙箱功能。旧版本的 nano-agent 可能看起来能工作，
但沙箱可能静默失效或存在安全问题。

## 工作流文件

工作流文件是带 YAML front matter 的 Markdown。front matter 用于配置 Tracker、轮询、工作区 Hook、Agent 行为、可选的 `/goal` 完成条件和重试策略；Markdown 正文是传递给 Agent 的提示词模板。

最小示例：

```markdown
---
tracker:
  type: local
agent:
  binary: nano
  timeout_ms: 300000
  max_retries: 3
goal:
  condition: "the issue is resolved and relevant checks pass"
  max_turns: 30
  inject_mode: prefix
  abort_on_max_turns: true
---
# Issue: {{ issue.identifier }} - {{ issue.title }}
{{ issue.description }}
Attempt: {{ attempt }}
```

仓库提供的起始模板见 `templates/WORKFLOW.example.md`。

## HTTP API 概览

所有 REST 接口都挂载在 `/api/v1` 下。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/issues` | 列出 Issue，可通过 `state` 过滤。 |
| `GET` | `/issues/:id` | 获取单个 Issue。 |
| `POST` | `/issues` | 创建 Issue。 |
| `PUT` | `/issues/:id` | 更新 Issue。 |
| `GET` | `/runs` | 列出活跃运行。 |
| `GET` | `/events` | 列出事件，可通过 `since` 过滤。 |
| `GET` | `/events/stream` | 使用 Server-Sent Events 流式输出事件。 |
| `POST` | `/runs/:issueId/cancel` | 取消运行。 |
| `POST` | `/runs/:issueId/pause` | 暂停运行。 |
| `POST` | `/runs/:issueId/resume` | 恢复运行。 |
| `GET` | `/workflow` | 读取工作流文档。 |
| `PUT` | `/workflow` | 保存工作流文档。 |
| `GET` | `/logs/:issueId/:attempt` | 使用 Server-Sent Events 流式输出尝试日志。 |

## Agent MCP 工具

MCP 服务为被编排的 Agent 会话暴露以下 Symphony 工具：

- `symphony.fetch_issue`
- `symphony.report_event`
- `symphony.report_goal_state`
- `symphony.update_token_stats`
- `symphony.request_workflow_section`
- `symphony.suggest_state_transition`
- `symphony.session_completed`
- `symphony.create_issue`
- `symphony.activate_issue`

`skills/nano-symphony/SKILL.md` 记录了 Agent 在 Symphony 管理的工作区中应遵循的工作流程。

## 开发脚本

根目录脚本：

```bash
bun run start   # 运行后端
bun run dev     # 以监听模式运行后端
bun run build   # 构建前端
bun run lint    # TypeScript 类型检查
bun test        # 运行测试
```

`frontend/` 目录脚本：

```bash
bun run dev      # 启动 Vite 开发服务器
bun run build    # 构建前端资源
bun run preview  # 预览构建结果
```

## 测试

运行测试套件：

```bash
bun test
```

运行 TypeScript 检查：

```bash
bun run lint
```

### 真实 nano-agent 沙箱测试

仓库包含可选的端到端测试，使用真实的 nano-agent 二进制来验证实际沙箱行为。这些测试默认跳过。

运行方式：

```bash
RUN_REAL_AGENT_E2E=1 NANO_BIN_PATH=/path/to/nano bun test tests/e2e/e2e-real-sandbox.test.ts
```

这些测试验证：
- 沙箱阻止读取敏感文件如 `~/.ssh/`
- 环境变量如 `OPENAI_API_KEY` 在沙箱 shell 中不可见
- 沙箱元数据被正确记录到事件中
- 沙箱阻止在工作区外写入

**注意：**这些测试需要一个支持沙箱功能的真实 nano-agent 二进制。

## 许可证

当前仓库未包含 License 文件。
