# nano-symphony

[中文文档](./README.zh-CN.md)

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
- A compatible coding-agent executable available on `PATH` or configured through `NANO_BIN` / workflow settings. The default binary name is `nano`.

## Download

### One-line Installer (Recommended)

Requires [Bun](https://bun.sh/) to be installed first.

```bash
curl -sSL https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh | bash
```

This will download the latest release, install dependencies, and create the `symphony` launcher in `~/.local/bin`.

After installation, start the service with:

```bash
symphony start
```

To update an installed copy, run:

```bash
symphony update
```

The update command reads the OSS release metadata, downloads the published installer from that metadata, and reruns it with the existing install and binary directories. Existing `.env`, `WORKFLOW.md`, database, and workspaces are preserved; restart any running service after updating.

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

## Quick start

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

### Manual Setup

1. Install dependencies and create a local `.env` file:

   ```bash
   ./scripts/init-project.sh
   ```

   Or run the equivalent commands manually:

   ```bash
   cp .env.example .env
   bun install
   ```

2. Create a workflow file:

   ```bash
   cp templates/WORKFLOW.example.md WORKFLOW.md
   ```

3. Start the backend service:

   ```bash
   bun run start
   ```

   For development with file watching:

   ```bash
   bun run dev
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
| `DB_PATH` | `./symphony.db` | SQLite database path. |
| `WORKFLOW_PATH` | `./WORKFLOW.md` | Workflow Markdown file path. |
| `NANO_BIN` | `nano` | Default agent binary. |
| `WORKSPACE_ROOT` | `./workspaces` | Root directory for generated workspaces. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `MAX_CONCURRENT_AGENTS` | `3` | Maximum concurrent agent runs. |
| `MCP_TOKEN_TTL_MS` | `3600000` | MCP token time-to-live in milliseconds. |
| `ORCHESTRATOR_TICK_MS` | `5000` | Orchestrator polling interval in milliseconds. |

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

See `templates/WORKFLOW.example.md` for the repository's starter template.

## HTTP API overview

All REST endpoints are mounted under `/api/v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/issues` | List issues, optionally filtered by `state`. |
| `GET` | `/issues/:id` | Fetch one issue. |
| `POST` | `/issues` | Create an issue. |
| `PUT` | `/issues/:id` | Update an issue. |
| `GET` | `/runs` | List active runs. |
| `GET` | `/events` | List events, optionally filtered by `since`. |
| `GET` | `/events/stream` | Stream events with Server-Sent Events. |
| `POST` | `/runs/:issueId/cancel` | Cancel a run. |
| `POST` | `/runs/:issueId/pause` | Pause a run. |
| `POST` | `/runs/:issueId/resume` | Resume a run. |
| `GET` | `/workflow` | Read the workflow document. |
| `PUT` | `/workflow` | Save the workflow document. |
| `GET` | `/logs/:issueId/:attempt` | Stream attempt logs with Server-Sent Events. |

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

## License

No license file is currently included in this repository.
