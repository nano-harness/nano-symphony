# nano-symphony

[中文](./README.zh-CN.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.0+-000000?logo=bun)](https://bun.sh)

> Lightweight orchestration for coding agents — SQLite state, MCP callbacks, web dashboard. The conductor for your [nano-agent](https://github.com/nano-harness/nano-agent) fleet.
>
> Part of the [nano series](https://nano-harness.github.io) — [nano-symphony](https://github.com/nano-harness/nano-symphony) · [nano-agent](https://github.com/nano-harness/nano-agent) · [nano-cloud](https://github.com/nano-harness/nano-cloud). Pairs with the [harness-101](https://github.com/albert-lv/harness-101) course.

nano-symphony is a lightweight orchestration service for running coding-agent work on tracked issues. It stores issue state in SQLite, dispatches agent sessions into isolated workspaces, exposes an MCP server for agent callbacks, and includes a small web dashboard for observing runs and editing the workflow prompt.

## Features

- **Issue tracking API**: create, list, update, and inspect local issues through HTTP endpoints.
- **Agent orchestration**: polls for candidate issues, claims work, launches the configured agent binary, and retries failed runs with backoff.
- **Workspace management**: prepares per-issue workspaces and runs optional lifecycle hooks.
- **MCP integration**: provides Symphony tools that agents can use to fetch assigned work, report progress and goal state, update token statistics, request workflow sections, suggest state transitions, and mark sessions complete.
- **Workflow templates**: loads a Markdown workflow file with YAML front matter and Liquid-style content templates.
- **Web dashboard**: provides a Solid/Vite UI for browsing issues, viewing active runs and events, streaming logs, and editing the workflow document.

## Repository layout

```text
.
├── src/                  # Bun TypeScript backend
│   ├── db/               # SQLite migrations and tracker persistence
│   ├── http/             # HTTP API routes and server composition
│   ├── mcp/              # MCP server and Symphony tool handlers
│   ├── orchestrator/     # Dispatcher, worker, retry, and workspace flow
│   ├── spawner/          # Agent process launching
│   ├── workflow/         # Workflow loading and validation
│   └── workspace/        # Workspace preparation and hooks
├── frontend/             # Solid/Vite dashboard
├── templates/            # Example workflow template
├── skills/               # Agent skill documentation for Symphony sessions
│   ├── nano-symphony/                  # Agent behavior contract inside Symphony workspaces
│   └── nano-symphony-local-loop/       # Local quick start and troubleshooting guide
├── tests/                # Unit and integration tests
├── .env.example          # Runtime configuration defaults
└── package.json          # Bun scripts and backend dependencies
```

## Requirements

- [Bun](https://bun.sh/) for dependency installation, running the backend, tests, and frontend build.
- A compatible coding-agent executable available on `PATH` and configured through workflow settings. Unspecified workflows default to `claude-code` with the `claude` binary; set `agent.kind: nano` to use nano explicitly.

## Download

### One-line Installer (Recommended)

Requires [Bun](https://bun.sh/) to be installed first.

```bash
curl -sSL https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh | bash
```

This will download the latest pre-built bundle (~5 MB), extract it to `~/.local/share/nano-symphony/`, and create the `symphony` launcher in `~/.local/bin`. No `npm install` or source compilation is needed.

After installation, start the service with:

```bash
symphony start
```

To update an installed copy, run:

```bash
symphony update
```

The update command reads the OSS release metadata, downloads the published installer from that metadata, and reruns it with the existing install and binary directories. Existing `.env`, `WORKFLOW.md`, database, and workspaces are preserved; restart any running service after updating.

> **Note:** `symphony dev`, `symphony build`, `symphony test`, and `symphony lint` are only available in source builds and will print a clear error in bundle installs. For local source development use: `SYMPHONY_SHARE_ROOT=$(pwd) bun --watch src/index.ts`.

### Manual Download

Pre-built release archives and the skill file are hosted on OSS.

| Resource | URL |
| --- | --- |
| Latest release | `https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/latest/nano-symphony.tar.gz` |
| Release metadata | `https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/meta.json` |
| Agent skill | `https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/skills/nano-symphony/SKILL.md` |
| Local loop skill | `https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/skills/nano-symphony-local-loop/SKILL.md` |
| Install script | `https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh` |

For all versioned releases, see the [GitHub Releases](https://github.com/nano-harness/nano-symphony/releases) page.

```
~/.local/share/nano-symphony/
├── index.js                       # minified bundle (~484 KB)
├── fsevents*.node                 # chokidar native binding (macOS only)
├── share/
│   ├── frontend/dist/             # compiled dashboard
│   ├── skills/nano-symphony/      # agent skill file (also written to ~/.nano/skills/ globally)
│   ├── templates/
│   │   └── WORKFLOW.example.md
│   └── VERSION                    # semver, e.g. 0.1.5
├── .env                           # generated on first install
├── WORKFLOW.md                    # copied from template on first install
├── symphony.db                    # SQLite, preserved across updates
└── workspaces/                    # preserved across updates

~/.nano/skills/nano-symphony/SKILL.md        # written by install.sh
~/.claude/skills/nano-symphony/SKILL.md      # written by install.sh (if ~/.claude/ exists)
~/.local/bin/symphony                        # wrapper script
```

> **For a step-by-step local loop walkthrough**, see [skills/nano-symphony-local-loop/SKILL.md](skills/nano-symphony-local-loop/SKILL.md) for the fastest path to running a complete demo.

### Using the Installer

1. Run the installer (see [Download](#download)):

2. Review and edit the configuration files:

   ```bash
   ~/.local/share/nano-symphony/.env
   ~/.local/share/nano-symphony/WORKFLOW.md
   ```

3. Start the service:

   ```bash
   symphony start
   ```

### Manual Setup (source mode)

1. Install dependencies and create a local `.env` file:

   ```bash
   ./scripts/init-project.sh
   ```

   Or run the equivalent commands manually:

   ```bash
   cp .env.example .env
   bun install
   cd frontend && bun install
   ```

2. Initialize the workflow file (idempotent — only writes if missing):

   ```bash
   ./scripts/init-project.sh
   ```

   This script copies `templates/WORKFLOW.example.md` to `WORKFLOW.md` in the repository root when none exists.
   To customize prompt / sandbox / permission behavior, edit the root `WORKFLOW.md` directly.
   For how these fields are parsed and rendered, see
   [`docs/WORKFLOW-INTERNALS.md`](docs/WORKFLOW-INTERNALS.md).

3. Start the backend service with the share root pointing to the project directory:

   ```bash
   SYMPHONY_SHARE_ROOT=$(pwd) bun run start
   ```

   For development with file watching:

   ```bash
   SYMPHONY_SHARE_ROOT=$(pwd) bun run dev
   ```

4. Open the HTTP API at `http://localhost:4123/api/v1`. The MCP endpoint is available at `http://localhost:4123/mcp`.

## Frontend dashboard

The frontend lives in `frontend/` and is built by the root build script.

```bash
bun run build
```

For local frontend development, run Vite from the frontend directory:

```bash
cd frontend
bun run dev
```

The dashboard includes routes for:

- `/` - issue list and filtering.
- `/issues/:id` - issue details, events, controls, and log streaming.
- `/workflow` - workflow document editor.

## Configuration

Runtime configuration is read from environment variables and validated at startup. Defaults are shown in `.env.example`.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4123` | HTTP server port. |
| `HOST` | `127.0.0.1` | Bind address. Defaults to loopback-only for security. Set to `0.0.0.0` to expose externally, but **`API_TOKEN` must be set** when using a non-loopback address (symphony refuses to start without it). |
| `API_TOKEN` | *(auto-generated)* | Shared secret protecting `/api/v1/*`. **Always enforced** — a random UUID is auto-generated if unset, so the API is never open by default. Set an explicit value to keep the token stable across restarts. Provide as `Authorization: ******` or `X-Symphony-Token: <your-token>` header (or `?token=` query param for EventSource). The token is injected into the served dashboard for automatic auth. |
| `DB_PATH` | `./symphony.db` | SQLite database path. |
| `WORKFLOW_PATH` | `./WORKFLOW.md` | Workflow Markdown file path. |
| `WORKSPACE_ROOT` | `./workspaces` | Root directory for generated workspaces. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `MAX_CONCURRENT_AGENTS` | `3` | Maximum concurrent agent runs. |
| `AGENT_TOKEN_TTL_MS` | `3600000` | Agent session token time-to-live in milliseconds. |
| `MCP_TOKEN_TTL_MS` | *(deprecated)* | Deprecated alias for `AGENT_TOKEN_TTL_MS`. |
| `ORCHESTRATOR_TICK_MS` | `1000` | Orchestrator polling interval in milliseconds. |

### Security model

- **Control plane auth** (`API_TOKEN`): Always enforced — every request to `/api/v1/*` (except `/api/v1/health`) must include the token via `Authorization` or `X-Symphony-Token` header. A random UUID is auto-generated at startup if `API_TOKEN` is unset; set it explicitly to keep the same token across restarts. Comparison is constant-time to prevent timing attacks. The token is injected as `window.__SYMPHONY_API_TOKEN__` into the served HTML so that the built-in dashboard authenticates automatically.
- **Bind address** (`HOST`): Defaults to `127.0.0.1` (loopback only). Symphony refuses to start if `HOST` is a non-loopback address and `API_TOKEN` is unset.
- **Control-plane secrets**: Agent subprocesses do not receive symphony's own service credentials (`API_TOKEN`, `SYMPHONY_API_TOKEN`) or the parent Claude Code session variables. Other environment variables (e.g. `PATH`, `HOME`, provider API keys set by the operator) are preserved so the agent can access required tools. If you need stricter isolation, run symphony in an environment that only contains the variables the agent should see.

## Sandbox

When nano-symphony spawns nano-agent, it forces the agent into a process
sandbox by default:

| Platform | Backend           | Default isolation |
|----------|-------------------|-------------------|
| Linux    | Bubblewrap (bwrap) | mount + pid + user namespaces; HOME → workspace; clean env |
| macOS    | sandbox-exec      | path + network deny-default; clean env (NANO_*/PATH/TERM/LANG/LC_ALL only) |

**This means the agent's `run_shell_command` cannot:**

- Write outside `<workspace>`, `/tmp`, or `extra_writable_paths`
- Read sensitive files like `~/.ssh/`, `~/Library/Keychains` (macOS), `~/.aws/` etc.
- See secret env vars like `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SSH_AUTH_SOCK`
  (the LLM provider call happens in nano-agent's main process, which DOES see
  these — the restriction is only on shell subprocess that the agent spawns)

**Network is allowed by default** because the agent must call back to symphony
via MCP. To restrict outbound network from agent shells, add a firewall rule
on the symphony host (the sandbox cannot per-host whitelist).

**To customize**, set `agent.sandbox` in the workflow YAML:

```yaml
agent:
  sandbox:
    backend: native | docker | none
    network_access: true
    extra_read_only_paths: ["/Users/me/.gitconfig"]
    extra_writable_paths: []
    docker_image: ubuntu:24.04        # only used when backend=docker
    docker_runtime: runsc             # optional: gVisor (runsc) or Kata for stronger isolation
```

**To disable** (NOT recommended — accept full agent execution risk):

```yaml
agent:
  sandbox:
    backend: none
```

### Required nano-agent version

This sandbox integration assumes nano-agent with sandbox support. Older nano-agent versions
may appear to work but the sandbox might be silently broken or have security issues.

## Workflow file

A workflow file is Markdown with YAML front matter. The front matter configures tracker, polling, workspace hooks, agent behavior, optional `/goal` completion criteria, and retry behavior. The Markdown body is the prompt template passed to the agent.

Minimal example:

```markdown
---
tracker:
  type: local
agent:
  binary: nano
  timeout_ms: 3600000
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

See `templates/WORKFLOW.example.md` for the repository's starter template.

## HTTP API overview

All REST endpoints are mounted under `/api/v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/issues` | List issues, optionally filtered by `state`. |
| `GET` | `/issues/:id` | Fetch one issue. |
| `POST` | `/issues` | Create an issue. Accepts optional `workspace_path` for external workspace. |
| `PUT` | `/issues/:id` | Update an issue. Can update `workspace_path` before first run. |
| `GET` | `/runs` | List active runs. |
| `GET` | `/events` | List events, optionally filtered by `since`. |
| `GET` | `/events/stream` | Stream events with Server-Sent Events. |
| `POST` | `/runs/:issueId/cancel` | Cancel a run. |
| `POST` | `/runs/:issueId/pause` | Pause a run. |
| `POST` | `/runs/:issueId/resume` | Resume a run. |
| `GET` | `/workflow` | Read the workflow document. |
| `PUT` | `/workflow` | Save the workflow document. |
| `GET` | `/logs/:issueId/:attempt` | Stream attempt logs with Server-Sent Events. |

## Workspace

By default, nano-symphony creates and manages isolated workspaces under `./workspaces/<identifier>` for each issue. When a run completes or is cancelled, managed workspaces are automatically cleaned up.

### Bring your own workspace

For issues that require integration with external development environments, you can specify a custom `workspace_path` when creating or updating an issue. Symphony will use the provided path directly without managing its lifecycle.

**Use cases:**

1. **vwsd mountpoint**: Point symphony to a persistent vwsd workspace that survives across sessions:

   ```bash
   curl -X POST http://localhost:4123/api/v1/issues \
     -H "Content-Type: application/json" \
     -d '{
       "identifier": "PROJ-42",
       "title": "Implement feature X",
       "state": "todo",
       "workspace_path": "/Users/me/.vwsd/workspaces/my-project"
     }'
   ```

2. **git worktree**: Use a dedicated git worktree for the agent's changes:

   ```bash
   # Create a worktree first
   git worktree add ../worktrees/feature-branch feature-branch

   # Then create the issue pointing to it
   curl -X POST http://localhost:4123/api/v1/issues \
     -H "Content-Type: application/json" \
     -d '{
       "identifier": "TASK-1",
       "title": "Fix bug in feature-branch",
       "state": "todo",
       "workspace_path": "~/code/myproject/worktrees/feature-branch"
     }'
   ```

**Important notes:**

- External workspaces are **never deleted** by symphony, even after runs complete or are cancelled.
- The path can be absolute, relative, or use `~` for home directory expansion.
- If the path doesn't exist, symphony will create it (mkdir -p).
- Leave `workspace_path` empty or null to use default managed workspaces.
- The workspace badge in the dashboard shows whether a workspace is "managed" or "external".

### Diff in handoff review

Symphony's handoff panel renders a unified diff of changes the agent made to the
workspace. This only works if the workspace is a git repository:

- **Managed workspaces** (default `./workspaces/<id>/`): symphony auto-creates an
  empty baseline commit on first claim. Disable via `workspace.git_baseline: false`.
- **External workspaces** (`workspace_path` set on the issue): symphony never
  initializes git on your path. Make sure your path is already a git worktree, or
  add a `workspace.hooks.after_create` hook that runs `git init && git add -A &&
  git commit --allow-empty -m baseline`.

## Agent MCP tools

The MCP server exposes Symphony tools for orchestrated agent sessions:

- `symphony.fetch_issue`
- `symphony.report_event`
- `symphony.report_goal_state`
- `symphony.update_token_stats`
- `symphony.request_workflow_section`
- `symphony.suggest_state_transition`
- `symphony.session_completed`
- `symphony.create_issue`
- `symphony.activate_issue`

The `skills/nano-symphony/SKILL.md` file documents the expected agent workflow when operating inside a Symphony-managed workspace.

## Development scripts

Root scripts:

```bash
bun run start   # run the backend
bun run dev     # run the backend with watch mode
bun run build   # build the frontend
bun run lint    # type-check the TypeScript project
bun test        # run tests
```

Frontend scripts in `frontend/`:

```bash
bun run dev      # start Vite dev server
bun run build    # build frontend assets
bun run preview  # preview the built frontend
```

## Testing

Run the repository test suite with:

```bash
bun test
```

Run the TypeScript check with:

```bash
bun run lint
```

### Real nano-agent sandbox tests

The repository includes optional end-to-end tests that run with a real nano-agent binary
to verify actual sandbox behavior. These tests are skipped by default.

To run them:

```bash
RUN_REAL_AGENT_E2E=1 NANO_BIN_PATH=/path/to/nano bun test tests/e2e/e2e-real-sandbox.test.ts
```

These tests verify:
- Sandbox prevents reading sensitive files like `~/.ssh/`
- Environment variables like `OPENAI_API_KEY` are not visible in sandboxed shell
- Sandbox metadata is properly recorded in events
- Sandbox prevents writing outside workspace

**Note:** These tests require a real nano-agent binary with sandbox support.

## Troubleshooting

### Changes to WORKFLOW.md not taking effect

1. Check the logs for `workflow reloaded` or `workflow reload failed`.
2. On macOS, polling is enabled by default since v0.8+, but if it still does not take effect you can set `SYMPHONY_WATCH_USE_POLLING=1`.
3. Writing via the `PUT /api/v1/workflow` endpoint triggers a reload synchronously, independent of the watcher.
4. If you see `workflow reload failed`, check the YAML front matter syntax.

For the detailed mechanics, see [`docs/WORKFLOW-INTERNALS.md`](docs/WORKFLOW-INTERNALS.md).

## License

This project is licensed under the [MIT License](LICENSE).
