# AGENTS.md — nano-symphony

[中文](./AGENTS.zh-CN.md)

This file contains context for coding agents working on `nano-symphony`.

## Project overview

`nano-symphony` is a local orchestrator for agentic issue resolution. It:

- Exposes an HTTP control plane and an MCP server.
- Spawns `nano-agent` or `claude-code` subprocesses to work on issues.
- Manages a SQLite database of issues, plan runs, events, and artifacts.
- Serves a SolidJS dashboard from `frontend/`.

## Toolchain

- **Runtime/package manager**: [Bun](https://bun.sh) (required).
- **Language**: TypeScript, strict mode enabled.
- **Frontend**: SolidJS + Vite.
- **Database**: SQLite via `bun:sqlite`.

## Common commands

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

## Architecture

- `src/http/routes/` — domain-split Hono route modules mounted by `src/http/routes/index.ts`.
- `src/db/` — SQLite schema, migrations, and data access.
- `src/orchestrator/` — tick-based dispatcher and worker lifecycle.
- `src/spawner/` — adapter layer for spawning nano-agent / claude-code.
- `src/mcp/` — MCP server and tool handlers.
- `src/plan-runtime/` — plan-run script execution environment.
- `src/workflow/` — WORKFLOW.md parsing and template rendering.
- `src/prompt/` — Liquid-based prompt rendering.
- `frontend/src/` — SolidJS dashboard.

## Coding conventions

- Prefer explicit types over `as` assertions.
- Keep route handlers small; delegate business logic to tracker helpers or domain modules.
- Use `nullishString()` from `src/http/routes/schemas.ts` for optional string API fields.
- Environment config lives in `src/config.ts` and is validated with Zod.
- Never log secrets (API tokens, MCP session tokens).
- DB migrations must be idempotent and append-only.

## Testing

- Backend tests use `bun:test`.
- Integration tests create in-memory Hono apps.
- E2E tests use a debug adapter that simulates agent responses.
- Frontend tests use Vitest + `@solidjs/testing-library`; mock `fetch` globally to avoid unhandled rejections.

## Security notes

- `API_TOKEN` rejects empty strings and is required when `HOST` is non-loopback.
- Agent subprocesses do NOT receive `API_TOKEN` or `SYMPHONY_API_TOKEN`.
- Other environment variables are forwarded to agents so tools like `PATH` and provider API keys work.
- The install script writes `.env` with mode `600`.
