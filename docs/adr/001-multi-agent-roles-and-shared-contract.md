# ADR 001: Multi-Agent Roles and Shared Contract Schema

## Status

Proposed

## Context

`nano-symphony` currently orchestrates single agents per issue. A plan run can
spawn many sub-issues, but each sub-issue is executed by a generic agent
configured by the workflow's `agent` section. There is no first-class concept of
agent role (planner, executor, reviewer, etc.), and the contract between
`nano-agent` and `nano-symphony` is spread across:

- stdout JSON (`AgentResultSummary`) — parsed by adapter-specific code
- exit codes — defined in both projects
- MCP tool calls (`session_completed`, `report_event`, etc.)
- environment variables (`SYMPHONY_ISSUE_UUID`, `SYMPHONY_WORKSPACE`, etc.)

As the system grows, this implicit contract makes it hard to:

1. Add new agent adapters without duplicating parsing logic.
2. Reason about which agent is best suited for a given sub-issue.
3. Recover from partial failures when an agent role crashes mid-workflow.
4. Share workflow definitions between human operators and automated agents.

## Decision

Introduce **agent roles** into `nano-symphony` and codify the cross-project
contract as a versioned JSON Schema / OpenAPI spec.

### 1. Agent Roles

Each issue (and each node in a plan-run DAG) may declare a `role`. Roles are
names that map to agent profiles in the workflow:

```yaml
agent:
  default:
    kind: nano
    timeout_ms: 3600000
  roles:
    planner:
      kind: nano
      permission_mode: default
      allowed_tools: ["mcp__symphony__*", "ReadFile", "Glob"]
    executor:
      kind: nano
      permission_mode: auto
      timeout_ms: 7200000
    reviewer:
      kind: claude-code
      permission_mode: default
      max_retries: 1
```

When an issue is dispatched, the orchestrator resolves its role to an agent
profile. If no role is specified, the `default` profile is used. This preserves
backward compatibility.

### 2. Role-aware Plan Runs

The plan-runtime SDK will allow roles to be attached to nodes:

```js
dag({
  plan: {
    prompt: "Produce an implementation plan.",
    role: "planner",
  },
  implement: {
    prompt: "Implement the plan from {{plan}}.",
    role: "executor",
    after: ["plan"],
  },
  review: {
    prompt: "Review the implementation from {{implement}}.",
    role: "reviewer",
    after: ["implement"],
  },
});
```

Each node spawns an issue with `agent_kind`/`agent_binary` and a new
`agent_role` field (stored in the `issues` table). The orchestrator uses this
field to select the correct agent profile.

### 3. Shared Contract Schema

Move the implicit contract into an explicit, versioned schema. The first
version (`v1`) covers:

- **AgentResultSummary** — status, reason, goal_state, tokens, artifacts,
  blocker_fingerprint, termination_cause.
- **MCP tool request/response payloads** — `session_completed`, `report_event`,
  `submit_plan`, `emit_result`, `spawn_plan_run`.
- **Environment variables** — required vs optional, types, examples.
- **Exit codes** — canonical names and numeric values.

The schema lives in a new repository directory:

```
nano-symphony/contract/
  v1/
    agent-result-summary.schema.json
    mcp-tools.openapi.json
    env.schema.json
```

`nano-agent` will embed the same schema under:

```
nano-agent/pkg/contract/
  v1/
    agent_result_summary.go   // generated or hand-written constants
```

Both projects validate against the schema at runtime where feasible:

- `nano-agent` validates its stdout JSON before writing it.
- `nano-symphony` validates parsed results and rejects malformed MCP payloads
  with a clear error instead of retrying indefinitely.

### 4. Resume Identity

Replace the fragile resume key (`prompt prefix first 80 chars`) with a stable
identity:

```
{issue_uuid}:{attempt}:{plan_run_id}:{node_id}
```

This identity is passed to the agent via `SYMPHONY_ISSUE_ID` and stored in the
agent's session metadata so that retries and plan-run resumes are deterministic.

### 5. Inter-Role Communication

Reuse the existing `issue_blockers` table for cross-role dependencies:

- A reviewer issue can block an executor issue until approved.
- A planner issue can block implementation issues until the plan is approved.

This is a lightweight alternative to rebuilding mailbox semantics and aligns
with the blocker visualization work already in place.

## Consequences

### Positive

- New agent adapters only need to produce valid contract payloads; the
  orchestrator no longer needs adapter-specific parsing tweaks.
- Operators can declare role-specific permissions and models without changing
  orchestrator code.
- Plan scripts become self-documenting about who does what.
- Resume and crash recovery become deterministic.

### Negative

- Adds a migration: existing workflows without `agent.roles` continue to work,
  but role-aware features require schema updates.
- Requires coordination between `nano-agent` and `nano-symphony` releases when
  the contract version changes.
- The JSON Schema must be kept in sync with Go/TypeScript code until code
  generation is adopted.

## Implementation Phases

1. **Schema repository setup** — create `contract/v1/` in both projects.
2. **Runtime validation** — validate stdout JSON and MCP payloads against the
   schema.
3. **Database migration** — add `agent_role` to `issues` and persist role in
   `plan_runs` node metadata.
4. **Orchestrator role resolution** — select agent profile by role.
5. **Plan-runtime SDK role support** — accept `role` in `issue()`/`dag()`/
   `parallel()` nodes.
6. **Stable resume identity** — replace prompt-prefix resume key.
7. **Documentation and examples** — update `WORKFLOW-reference.md` and add sample
   multi-role workflows.

## Related Documents

- `docs/standards/agent-exit-contract.md`
- `docs/WORKFLOW-reference.md`
- `nano-agent/docs/features/MULTI_AGENT.md`
