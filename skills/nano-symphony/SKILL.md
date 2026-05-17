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
- `SYMPHONY_MCP_URL` - The Symphony MCP endpoint.
- `SYMPHONY_TOKEN` - The token used by the configured MCP server.

## Available tools

### Required (every session)

- `symphony.fetch_issue` — Fetch the current issue details and orchestration context. **Call once at session start.**
- `symphony.session_completed` — Mark the session complete with `{semantics, summary, handoff_state?}`. **Required before exit.** `semantics ∈ {success, needs_retry, handoff, abandoned}`.

### Recommended (when applicable)

- `symphony.report_event` — Report meaningful progress, decisions, blockers, validation results. Args: `{kind, message, payload?}`. Typical `kind` values: `progress`, `tool_call`, `validation`, `error`, `blocker`.
- `symphony.report_goal_state` — Report your view of the `/goal` evaluator state when you have context the orchestrator doesn't. Args: `{condition?, turns_evaluated?, max_turns?, achieved_at?, last_reason?, tokens?}`.
- `symphony.suggest_state_transition` — Propose a target state (`{suggested_state, reason}`). Advisory — symphony routes based on `state_transitions` config.
- `symphony.request_workflow_section` — Fetch a specific section of the workflow Markdown by name (`{section?}`). Use when you need extra guidance not in the initial prompt.

### Sub-task management

- `symphony.create_issue` — Create a derived child issue. Args: `{title, description?, priority?, state?, labels?, link_current_as_blocker?}`. Default state is `backlog` (not auto-dispatched); pass an active state like `todo` only when you want immediate pickup.
- `symphony.activate_issue` — Move a backlog issue to a schedulable state. Args: `{issue_id, target_state?}`. Target must not be `backlog` / `done` / `cancelled`.

## Sandbox restrictions

Your `run_shell_command` is wrapped by a process sandbox. You can:

- ✅ Read & write files inside `$SYMPHONY_WORKSPACE` (this is your workspace).
- ✅ Read system commands in `/usr`, `/bin`, `/etc`.
- ✅ Write temporary files under `/tmp` (note: tmpfs, gone after exit).
- ✅ Network access (HTTP / DNS — needed for `git clone`, `pip`, etc.).

You CANNOT:

- ❌ Write outside `$SYMPHONY_WORKSPACE` (no `~/`, no `/etc`, no other paths).
- ❌ Read sensitive paths: `~/.ssh/`, `~/Library/Keychains`, `~/.aws/`, etc.
- ❌ See env vars like `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `GITHUB_TOKEN`.
  (These are stripped from your shell's env by design — they belong to nano-agent
  itself, not to commands you run.)

If you need a path mounted that you cannot reach, **report a blocker via
`symphony.report_event`** and ask the user to add it under
`agent.sandbox.extra_read_only_paths` in the workflow YAML.

If a command unexpectedly fails with `Operation not permitted`, **do not retry
in a loop** — it's a sandbox restriction, not a transient error. Report the
blocker and either work around it within the sandbox or propose a workflow
config change.

## Required workflow

1. Fetch the current issue before making changes so you understand the requested outcome and any orchestration metadata.
2. Inspect the repository and identify the smallest safe change that satisfies the issue.
3. Report progress when you complete a meaningful unit of work, hit a blocker, or finish validation.
4. Validate changes using the repository's existing test, lint, or build commands when applicable.
5. Call `symphony.session_completed` before exiting, even if the task cannot be completed.

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
