---
name: nano-symphony
description: Use this skill when operating inside a nano-symphony orchestrated workspace to fetch the assigned issue, report progress, and mark the session complete through the Symphony MCP tools.
---

# nano-symphony

You are operating inside a nano-symphony orchestrated workspace. This skill documents the expected agent workflow and the Symphony MCP tools available in this environment.

## Installation

Install nano-symphony with the one-line installer:

```bash
curl -sSL https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh | bash
```

Prerequisites: [Bun](https://bun.sh/) must be installed.

After installation, start the service:

```bash
symphony start
```

For manual setup, download the latest archive from:
- Archive: `https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/latest/nano-symphony.tar.gz`
- Install script: `https://binary-releases.oss-cn-hangzhou.aliyuncs.com/symphony/install.sh`

## When to use this skill

Use this skill whenever the workspace has been prepared by nano-symphony and you need to work on the current orchestration issue. The environment typically provides:

- `SYMPHONY_ISSUE_ID` - The current issue or task identifier.
- `SYMPHONY_WORKSPACE` - The workspace path for this run.
- `SYMPHONY_WORKSPACE_MANAGED` - `"1"` if symphony manages this workspace, `"0"` if it's an external user-provided path.
- `SYMPHONY_MCP_URL` - The Symphony MCP endpoint.
- `SYMPHONY_TOKEN` - The token used by the configured MCP server.

## Available tools

### Required (every session)

- `symphony.fetch_issue` — Fetch the current issue details and orchestration context. **Call once at session start.**
- `symphony.session_completed` — Mark the session complete with `{semantics, summary, handoff_state?}`. **Required before exit, including failure paths.** If the task cannot be completed, still call this with semantics=abandoned or needs_retry plus a concise summary and (optional) blocker_fingerprint. `semantics ∈ {success, needs_retry, handoff, abandoned}`.

You may attach artifacts to help the reviewer:

```json
{
  "semantics": "handoff",
  "summary": "Implemented JSON streaming parser. Tests pass.",
  "artifacts": [
    {"kind": "file_diff", "path": "src/parser.ts", "additions": 85, "deletions": 12},
    {"kind": "command_output", "label": "tests", "cmd": "pnpm test", "exit_code": 0, "output": "12 passed"}
  ],
  "follow_ups": ["Performance test on 100MB file pending"],
  "metrics": {"turns_used": 12, "files_touched": 3, "tests_passed": 12}
}
```

For a failure, prefer:

```json
{
  "semantics": "abandoned",
  "summary": "Cannot read ~/.aws/credentials — protected by default blocklist.",
  "blocker_fingerprint": "sandbox_denied:~/.aws/credentials"
}
```

`blocker_fingerprint` should be ≤ 80 chars, deterministic across attempts, and free of timestamps / PIDs / random ids. Symphony will short-circuit the issue to `blocked` if the same fingerprint repeats.

### Recommended (when applicable)

- `symphony.report_event` — Report meaningful progress, decisions, blockers, validation results. Args: `{kind, message, payload?}`. Typical `kind` values: `progress`, `tool_call`, `validation`, `error`, `blocker`.
- `symphony.report_goal_state` — Report your view of the `/goal` evaluator state when you have context the orchestrator doesn't. Args: `{condition?, turns_evaluated?, max_turns?, achieved_at?, last_reason?, tokens?}`.
- `symphony.suggest_state_transition` — Propose a target state (`{suggested_state, reason}`). Advisory — symphony routes based on `state_transitions` config.
- `symphony.request_workflow_section` — Fetch a specific section of the workflow Markdown by name (`{section?}`). Use when you need extra guidance not in the initial prompt.

### Sub-task management

- `symphony.create_issue` — Create a derived child issue. Args: `{title, description?, priority?, state?, labels?, link_current_as_blocker?}`. Default state is `backlog` (not auto-dispatched); pass an active state like `todo` only when you want immediate pickup.
- `symphony.activate_issue` — Move a backlog issue to a schedulable state. Args: `{issue_id, target_state?}`. Target must not be `backlog` / `done` / `cancelled`.

## Sandbox restrictions

`run_shell_command` and filesystem tools share a default sensitive-file blocklist that **always applies, even when `sandbox.enabled: false`**. The blocklist denies access to:

- Cloud credentials: `~/.aws/`, `~/.gnupg/`, `~/.kube/`, `~/.docker/config.json`
- Shell secrets: `~/.ssh/`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`
- nano-agent's own config: `~/.nano/*.yaml`, `~/.nano/*.yml`, `~/.nano/config*`, and the equivalents under `~/.config/nano/`
- Glob patterns: `**/.env`, `**/.env.*`, `**/credentials`, `**/*.pem`, `**/*.key`

`~/.nano/skills/**` is **explicitly readable / writable** so you can update SKILL files when asked.

When `sandbox.enabled: true`, additional `allowed_paths` / `read_only_paths` / `blocked_paths` from the workflow YAML are layered on top. In embedded mode the default `allowed_paths` are `[projectPath, os.TempDir(), userCacheDir()]` (NOT `~/.nano` or `~/.config/nano`); override via `NANO_SANDBOX_ALLOWED_PATHS`.

Network access, env-var stripping (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `GITHUB_TOKEN`), and `Operation not permitted` semantics are unchanged.

**Note on external workspaces:** When `SYMPHONY_WORKSPACE_MANAGED=0`, the workspace is user-provided (e.g., vwsd mountpoint, git worktree). Symphony will not delete this workspace after the run completes. All blocklist restrictions still apply.

If a path you legitimately need is denied, **report a blocker via `symphony.report_event`**. Do not retry the same denied path in a loop — it's a deterministic restriction, not a transient error.

## Required workflow

1. Fetch the current issue before making changes so you understand the requested outcome and any orchestration metadata.
2. Inspect the repository and identify the smallest safe change that satisfies the issue.
3. Report progress when you complete a meaningful unit of work, hit a blocker, or finish validation.
4. Validate changes using the repository's existing test, lint, or build commands when applicable.

### Stop hook delivery

nano-symphony receives binary session results via the nano-agent Stop hook payload (posted to symphony’s `/agent-result` endpoint). stdout/stderr scanning for sentinels is not used.
If the process is force-terminated and cannot deliver the Stop hook payload, symphony classifies the run as `no_result_payload`.

## Reporting guidance

Report concise, actionable events. Include:

- What changed or what was discovered.
- Any validation commands run and their results.
- Blockers or assumptions that affect the final outcome.
- The final status when calling `symphony.session_completed`.

Do not report secrets, tokens, or other sensitive values from the environment.

## Completion checklist

Before ending the session:

- Confirm the requested issue has been addressed or clearly explain why it could not be addressed.
- Confirm relevant validation has passed, was skipped because the change is documentation-only, or explain any failures.
- Call `symphony.session_completed` with a concise summary of the outcome.
