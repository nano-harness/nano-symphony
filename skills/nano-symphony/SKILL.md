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

## Agent Kinds

Symphony supports two agent kinds via the adapter pattern:

- **nano** (default) — Go-based coding agent. Result parsed from stdout JSON line. Produces `solution.patch` in `--output-dir`.
- **claude-code** — Claude Code CLI (`claude -p`). Result parsed from stream-json envelope. Token usage extracted from envelope `usage` field.

The agent kind is determined by `agent.kind` in the workflow config, or per-issue via `agent_kind` field.

## Available tools

### Required (every session)

- `symphony.fetch_issue` — Fetch the current issue details and orchestration context. **Call once at session start.**
- `symphony.emit_result` — Submit a structured result before completing. **Required before `session_completed`.** See "Submitting results with emit_result" below.
- `symphony.session_completed` — Mark the session complete. **Required before exit.** Full schema below.

### session_completed full schema

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

The `blocker_fingerprint` field enables symphony's same-cause short-circuit: if the same fingerprint appears on consecutive attempts, symphony skips further retries and marks the issue as blocked.

### Artifacts

The `artifacts` array supports these discriminated types:

| kind | Fields | Use case |
|------|--------|----------|
| `file_diff` | path, diff?, additions?, deletions? | Modified file summary |
| `file_added` | path, bytes?, preview? | New file created |
| `file_removed` | path | File deleted |
| `file_renamed` | from, to | File renamed/moved |
| `screenshot` | path, caption? | Visual evidence |
| `log_excerpt` | label, content | Relevant log snippet |
| `url` | label, href | External reference |
| `command_output` | label, cmd, exit_code?, output | Command result |
| `note` | label, markdown | Free-form note |

### Recommended (when applicable)

- `symphony.report_event` — Report meaningful progress, decisions, blockers, validation results. Args: `{kind, message, payload?}`. Typical `kind` values: `progress`, `tool_call`, `validation`, `error`, `blocker`.
- `symphony.report_goal_state` — Report your view of the `/goal` evaluator state when you have context the orchestrator doesn't. Args: `{condition?, turns_evaluated?, max_turns?, achieved_at?, last_reason?, tokens?}`.
- `symphony.suggest_state_transition` — Propose a target state (`{suggested_state, reason}`). Advisory — symphony routes based on `state_transitions` config.
- `symphony.request_workflow_section` — Fetch a specific section of the workflow Markdown by name (`{section?}`). Use when you need extra guidance not in the initial prompt.
- `symphony.get_artifact` — Read a stored artifact. Args: `{artifact_id, mode?, lines?, bytes?, pattern?}`. Modes: `full` | `head` | `tail` | `search`.
- `symphony.update_issue_scratchpad` — Persist a short memo (≤4 KB) for the next invocation. Args: `{text}`. Useful when you will be re-scheduled after a plan run completes.

### Plan runs

- `symphony.spawn_plan_run` — Dispatch a JS plan script and continue independently. Args: `{script, args?}`. Returns `run_id`. Fire-and-forget.
- `symphony.spawn_plan_run_and_handoff` — Dispatch a JS plan script and pause this issue until the run completes. When the plan finishes, this issue is re-scheduled with the plan result injected into the prompt. Args: `{script, args?}`.

## Submitting results with emit_result

Every issue **must** call `symphony.emit_result` before `session_completed`. This is how Symphony captures structured output for callers, reviewers, and downstream plan runs.

- If the issue prompt contains an `<output_schema>` block, `emit_result.data` must conform to that JSON Schema. Symphony validates on receipt.
  - If validation fails, you may retry in the same session: call `emit_result` again with a corrected `data`.
- If there is no `<output_schema>`, pass a plain string (≤ 32 KB) summarising the outcome.

```
// With schema
symphony.emit_result({ data: { summary: "...", files_changed: 3 } })

// Without schema
symphony.emit_result({ data: "Refactored authentication module. Tests pass." })
```

Always call `emit_result` **before** `session_completed`.

## Decomposing tasks with plans

When an issue requires coordinating many sub-tasks, write an inline JavaScript plan script and dispatch it with `spawn_plan_run_and_handoff`. Symphony dry-runs the script, presents a summary for human approval, then executes it and re-schedules you with the results.

### Plan script SDK

The following globals are injected into the plan script (no `require`/`import` needed):

| Global | Description |
|--------|-------------|
| `args` | Arguments passed via `spawn_plan_run{…, args}` |
| `issue(prompt, opts?)` | Dispatch a sub-issue. Returns the issue's `emit_result.data` (schema-typed) or a string summary. |
| `parallel(thunks)` | Run thunks concurrently. Returns an array of results in order. |
| `pipeline(items, ...stages)` | Process each item through each stage sequentially. |
| `phase(title)` | Label the current phase (visible in dry_run_summary). |
| `log(msg)` | Append a log message to the plan journal. |
| `budget` | `{ total, spent(), remaining() }` — token budget tracking. |
| `list_artifacts(issue_id)` | List artifacts produced by a completed sub-issue. |
| `get_artifact(artifact_id)` | Fetch artifact content. |

`IssueOpts` for `issue()`:

```ts
{
  schema?: object,        // JSON Schema for emit_result.data validation
  agent_kind?: string,    // "nano" | "claude-code"
  prompt?: string,        // Override prompt (default: first arg to issue())
}
```

### Example: research then implement

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

### Constraints

- `meta` must be a **literal object** in the script (not dynamically constructed): `{ name: "...", max_issues: N }`.
- **Forbidden globals:** `Date`, `Date.now()`, `new Date()`, `Math.random()`, `require`, `import`, `process`, `globalThis`. These do not exist in the plan sandbox — determinism is enforced by omission.
- Plans **cannot** be nested. A sub-issue created by a plan run cannot itself spawn plan runs. Use `emit_result` to return structured data; the caller issue can spawn additional plans on re-entry.
- Script size limit: 64 KB.

## Comments & Revision

Symphony supports operator interaction during agent runs:

- **Comments:** Operators can add comments via the API (`POST /api/v1/issues/:id/comments`). On the next attempt, all comments are automatically injected into the agent's prompt as a `## Operator comments` section (max 50 comments, 16KiB).
- **Revision requests:** When a reviewer calls `POST /api/v1/issues/:id/request-changes` with a `note`, the issue state reverts to `todo` and the note is injected into the next attempt's prompt as "Reviewer requested changes: ...". Address these notes in your response.
- **Retrigger:** Operators can retrigger a completed/abandoned issue via `POST /api/v1/issues/:id/retrigger`. This resets the state and blocker fingerprint so the orchestrator re-dispatches.

## Sandbox restrictions

Your `run_shell_command` is wrapped by a process sandbox. You can:

- Read & write files inside `$SYMPHONY_WORKSPACE` (this is your workspace).
- Read system commands in `/usr`, `/bin`, `/etc`.
- Write temporary files under `/tmp` (note: tmpfs, gone after exit).
- Network access (HTTP / DNS — needed for `git clone`, `pip`, etc.).

You CANNOT:

- Write outside `$SYMPHONY_WORKSPACE` (no `~/`, no `/etc`, no other paths).
- Read sensitive paths: `~/.ssh/`, `~/Library/Keychains`, `~/.aws/`, etc.
- See env vars like `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `GITHUB_TOKEN`.
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
5. Call `symphony.emit_result` with the outcome data (or a summary string) before exiting.
6. Call `symphony.session_completed` before exiting, even if the task cannot be completed.

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
- Call `symphony.emit_result` with the structured result or a plain-string summary.
- Call `symphony.session_completed` with the semantics of the outcome.
- If handing off to a reviewer, include `artifacts` and `follow_ups` to minimize context-switching cost.

