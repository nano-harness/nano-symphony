# Agent Exit Contract v1

[中文](./agent-exit-contract.zh-CN.md)

This document defines the standard contract for how agents communicate completion
status to nano-symphony. All agent adapters must conform to this contract.

## Signal Priority (high → low)

### 1. MCP `symphony.session_completed` tool call

- **Authoritative semantic declaration** (semantics, summary, artifacts, follow_ups).
- Agent actively calls this during execution to express intent (e.g. "handoff").
- Supports complex semantics not expressible via stdout alone.
- If the agent crashes before calling this, the signal does not exist.

### 2. stdout AgentResultSummary JSON (last line)

- **Passively collected** after agent exits; parsed by adapter's `parseResult()`.
- Must be a single-line valid JSON matching `AgentResultSummarySchema`.
- Token fields are authoritative for nano-agent; for claude-code, envelope `usage` overrides.
- Scanned from the last line upward, skipping blank lines and `[err]` prefixed lines.

### 3. Exit code

- **Process-level semantic hint**: `0`=success, `10`=retry, `20`=abandoned, `30`=timeout, `1`=unclassified.
- Used **only** for cross-validation (exitCode ≠ 0 && payload.status == "success" → downgrade to needs_retry).
- Does not independently determine completion semantics.

## Conflict Resolution Rules

| Conflict | Resolution |
|----------|-----------|
| MCP `session_completed.semantics` vs stdout `payload.status` | MCP wins (overrides stdout) |
| Envelope `usage` (claude-code) vs `payload.tokens` | Envelope wins (authoritative token source) |
| Exit code vs payload status | Exit code does **not** override; triggers mismatch detection only |

## AgentResultSummary Schema

```typescript
{
  status: "success" | "needs_retry" | "abandoned" | "timeout",
  reason?: string,
  goal_state?: {
    last_reason?: string,
    iterations?: number,
    // passthrough: additional fields accepted
  },
  tokens?: {
    input?: number,
    output?: number,
    cached?: number,
    // passthrough: additional fields accepted
  },
  blocked_commands_sample?: string[],  // max 20 items
  sandbox?: {
    backend?: string,
    network?: string,
    // passthrough: additional fields accepted
  },
  // passthrough: additional top-level fields accepted
}
```

## Adapter Compliance Requirements

When adding a new agent adapter, it **must** implement:

| Method | Required | Description |
|--------|----------|-------------|
| `parseResult(stdout)` | ✅ | Extract `AgentResultSummary` from stdout text |
| `collectArtifacts(ctx)` | ✅ | Collect patch/files from `outputDir` |
| `renderWorkspaceFiles(ctx)` | ✅ | Produce workspace config files for the agent |
| `buildSpawnInvocation(ctx)` | ✅ | Build argv + env for `Bun.spawn` |
| `parseStreamingLine(line)` | Optional | Parse real-time streaming events from stdout |
| `resolvePermissionMode(config)` | Optional | Resolve permission mode from workflow config |
| `applyPermissionFloor(opts)` | Optional | Apply permission floor when sandbox is off |

## Exit Code Constants

```typescript
const NANO_EXIT = {
  SUCCESS: 0,
  RETRY: 10,
  ABANDONED: 20,
  TIMEOUT: 30,
  UNCLASSIFIED: 1,
} as const;
```

## Completion Flow

```
Agent exits
    ↓
1. Check killedByTimeout → needs_retry (terminationCause: "timeout")
    ↓
2. Parse stdout → AgentResultSummary (adapter.parseResult)
    ↓
3. No payload? → abandoned (terminationCause: "no_result_payload")
    ↓
4. Exit code cross-validation:
   payload.status == "success" && exitCode ≠ 0 → needs_retry (terminationCause: "exitcode_mismatch")
    ↓
5. Use payload.status as semantics
    ↓
6. Check MCP session_completed event → override semantics if present
    ↓
7. Apply state_transitions from workflow config
```
