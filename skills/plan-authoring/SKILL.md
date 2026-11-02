---
name: plan-authoring
description: Use this skill when writing, reviewing, or debugging nano-symphony plan scripts.
---

# Plan Authoring

[中文](./SKILL.zh-CN.md)

You are helping write or review a **nano-symphony plan script**. Plan scripts
run inside a deterministic `node:vm` sandbox and orchestrate sub-issues through
the Symphony MCP tools.

## When to use a plan

Use a plan when a single agent session would be too long, too unfocused, or
needs human approval at an intermediate step:

- Research → implement → validate pipelines
- Multi-file refactors with independent sub-tasks
- Any task where a human must approve a design before execution

## Available primitives

| Primitive | Use when |
|-----------|----------|
| `issue(prompt, opts?)` | A single sub-task that must complete before continuing. |
| `parallel(thunks)` | Multiple independent sub-tasks that can run concurrently. |
| `pipeline(items, ...stages)` | The same set of items needs to flow through several stages. |
| `dag(nodes, edges)` | Sub-tasks have explicit dependencies; later nodes reference earlier results with `{{nodeId}}`. |

## Best practices

1. **Always use `phase(title)`** to label logical stages. Phases appear in the
dry-run summary shown to operators for approval.
2. **Provide `schema`** when downstream code depends on the shape of a sub-issue
result. This also enables type-safe access in the plan script.
3. **Use `gate: true`** for design approvals or any point where a human should
review before continuing.
4. **Use `key`** for stable crash-resume identity on important nodes, especially
in DAGs.

## Anti-patterns to avoid

- **Do not nest plans.** A sub-issue created by a plan run cannot itself spawn
plan runs. Return structured data and let the caller issue spawn the next plan.
- **Do not use forbidden globals.** `Date`, `Math.random`, `require`, `import`,
`process`, and `globalThis` are unavailable in the sandbox.
- **Do not construct `meta` dynamically.** The plan `meta` object must be a
literal object in the script.
- **Do not put huge context in prompts.** Keep prompts focused; use `log()` for
shared context that humans may need to read in the journal.

## Example: research then implement

```js
phase("Research");
const analysis = await issue(
  "Analyse the current auth module and summarise its pain points",
  {
    schema: {
      type: "object",
      properties: { pain_points: { type: "array", items: { type: "string" } } },
      required: ["pain_points"],
    },
  }
);

phase("Implement");
await parallel(
  analysis.pain_points.map((point) => () => issue(`Fix: ${point}`))
);

phase("Validate");
const report = await issue(
  "Run the test suite and report the result",
  {
    schema: {
      type: "object",
      properties: { passed: { type: "boolean" }, summary: { type: "string" } },
      required: ["passed", "summary"],
    },
  }
);

log(`Validation passed: ${report.passed}`);
```

## Example: review → implement → test DAG

```js
const result = await dag(
  [
    { id: "review", prompt: "Review the auth module for issues", role: "reviewer", gate: true },
    { id: "implement", prompt: "Implement the approved changes" },
    { id: "test", prompt: "Run tests and report results" },
  ],
  [
    { from: "review", to: "implement" },
    { from: "implement", to: "test" },
  ]
);
```

## Debugging plans

- Open the plan run in the dashboard and expand **Journal** to see phase and
sub-issue transitions.
- Expand **Nodes** to see which DAG nodes are running, done, or failed.
- Check `/api/v1/plan-runs/:id/journal` and `/api/v1/plan-runs/:id/nodes` for
programmatic access.

## CLI-first dispatch

Plan scripts should be dispatched via the **Symphony CLI**. The CLI reads
`SYMPHONY_MCP_URL` and `SYMPHONY_TOKEN` automatically and works in every runtime.
Use the MCP JSON-RPC tools only when the agent cannot execute shell commands.

### CLI: spawn a plan run and handoff

```bash
# Write plan script to a file
cat > plan.js << 'EOF'
phase("Research");
const analysis = await issue("Analyse the auth module", {
  schema: { type: "object", properties: { issues: { type: "array", items: { type: "string" } } }, required: ["issues"] }
});

phase("Fix");
await parallel(analysis.issues.map(i => () => issue(`Fix: ${i}`)));
EOF

# Dispatch and handoff (pauses current issue until plan completes)
symphony spawn-plan-run-and-handoff --script plan.js --meta-json '{"name":"Auth refactor","max_issues":10}'
```

### MCP fallback

If the agent only supports MCP tools, use `symphony.spawn_plan_run_and_handoff`:

```
symphony.spawn_plan_run_and_handoff({ script: `...plan source...`, meta: { name: "Auth refactor", max_issues: 10 } })
```

Both approaches create a `plan_run_spawned` event and transition the issue to
`awaiting_plan` while the plan runtime executes.
