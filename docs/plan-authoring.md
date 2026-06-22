# Plan Authoring Guide

Plan scripts let an agent decompose a task into smaller sub-issues that run in
sequence, in parallel, or as a DAG. They are executed inside a deterministic
`node:vm` sandbox.

## When to use a plan

Use a plan when a single agent session would be too long, too unfocused, or
needs human approval at an intermediate step:

- Research → implement → validate pipelines
- Multi-file refactors with independent sub-tasks
- Any task where a human must approve a design before execution

## SDK globals

The sandbox injects these globals:

| Global | Purpose |
|--------|---------|
| `args` | Arguments passed when spawning the plan run |
| `issue(prompt, opts?)` | Dispatch a sub-issue |
| `parallel(thunks)` | Run thunks concurrently |
| `pipeline(items, ...stages)` | Process items through sequential stages |
| `dag(nodes, edges)` | Execute a dependency graph of sub-issues |
| `phase(title)` | Label the current phase (visible in dry-run summary) |
| `log(msg)` | Append a message to the plan journal |
| `list_artifacts(issue_uuid)` | List artifacts from a completed sub-issue |
| `get_artifact(artifact_id)` | Fetch a single artifact |

## IDE support

For autocomplete and inline docs in VS Code, add these two lines at the top of
your plan script:

```js
// @ts-check
/// <reference path="./plan-runtime-globals.d.ts" />
```

Copy `templates/plan-runtime-globals.d.ts` next to your script, or reference it
from the nano-symphony repository.

## Choosing between primitives

- **`issue()`** — one-off sub-task. Use for sequential work.
- **`parallel()`** — independent sub-tasks that can run at the same time.
- **`pipeline()`** — same input processed through multiple stages.
- **`dag()`** — sub-tasks with explicit dependencies. Use when later steps need
  results from earlier steps via `{{nodeId}}` interpolation.

## Schema and gates

Always provide a `schema` when the downstream logic depends on the sub-issue
output shape:

```js
const result = await issue("Summarise findings", {
  schema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
  },
});
```

Use `gate: true` to pause the plan for human approval:

```js
const design = await issue("Propose a design", { gate: true });
```

## Common anti-patterns

1. **Nesting plans** — sub-issues created by a plan run cannot themselves spawn
   plans. Return structured data and let the caller issue spawn the next plan.
2. **Non-determinism** — `Date`, `Math.random`, `require`, `import`, `process`,
   and `globalThis` are not available in the sandbox.
3. **Oversized prompts** — keep node prompts focused. Put shared context in the
   plan journal via `log()`.
4. **Dynamic meta** — the plan `meta` object must be a literal; it cannot be
   constructed at runtime.

## Example: review → implement → test DAG

```js
phase("Review");
const review = await issue("Review the auth module", {
  key: "review",
  role: "reviewer",
  gate: true,
});

phase("Implement");
const implementation = await issue("Implement the approved changes", {
  key: "implement",
});

phase("Test");
await issue("Run tests and report results", { key: "test" });
```

## Validation

Validate a plan script before dispatching it:

```bash
bun scripts/validate-plan.ts path/to/plan.js
```

(Not yet implemented — for now you can dry-run by creating the plan run and
approving the dry-run summary in the dashboard.)

## Dispatching plans

Plan scripts are dispatched via the **Symphony CLI** or the MCP tools.

### CLI (recommended)

```bash
# Spawn a plan run and continue independently
symphony spawn-plan-run --script plan.js

# Spawn a plan run and pause the current issue until it completes
symphony spawn-plan-run-and-handoff --script plan.js
```

The CLI reads `SYMPHONY_MCP_URL` and `SYMPHONY_TOKEN` automatically.

### MCP tool

If the agent only supports MCP tools, use `symphony.spawn_plan_run_and_handoff`:

```
symphony.spawn_plan_run_and_handoff({ script: `...plan source...` })
```

Both approaches record a `plan_run_spawned` event and transition the issue to
`awaiting_plan` while the plan runtime executes.
