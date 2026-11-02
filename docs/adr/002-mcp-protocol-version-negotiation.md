# ADR 002: MCP Protocol Version Negotiation

[中文](./002-mcp-protocol-version-negotiation.zh-CN.md)

## Status

Accepted

## Context

`src/mcp/server.ts` originally hardcoded `protocolVersion: "2024-11-05"` in the
`initialize` response, ignoring whatever version the client requested. The MCP
protocol has since evolved: `2024-11-05` (original) → `2025-03-26` →
`2025-06-18` → `2025-11-25` (first-anniversary revision, adding the Tasks
abstraction and URL-mode elicitation). A later `2026-07-28` draft is a
breaking redesign that removes the `initialize` handshake in favor of a
stateless transport.

Without negotiation, newer clients that require `2025-03-26` or later features
cannot tell whether the server supports them, and the server claims a version
it may not actually implement.

## Decision

### 1. Version negotiation per the MCP spec

The server maintains an ordered list of supported versions
(`src/mcp/protocol.ts`):

```
["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
```

On `initialize`, the server reads `params.protocolVersion` from the client
request:

- If the requested version is in the supported list, the server echoes it.
- Otherwise the server responds with the latest version it supports
  (`2025-11-25`), and the client decides whether to continue or disconnect —
  exactly as the spec prescribes.

### 2. Notification tolerance

JSON-RPC notifications (methods prefixed with `notifications/`, including
`notifications/initialized`) carry no `id` and expect no response. The server
acknowledges them with HTTP `202 Accepted` and an empty body, per the
Streamable HTTP transport, instead of returning a `-32601` "Method not found"
error.

### 3. No adoption of the 2026-07-28 stateless redesign (yet)

The `2026-07-28` revision removes the `initialize` handshake entirely — a
breaking change to every client and to the token-scoped session model this
server relies on. We deliberately keep the handshake architecture and cap
support at `2025-11-25`. Adoption of `2026-07-28` is deferred until the
revision is finalized and client support is widespread; it will require its
own ADR and a migration plan for agent tokens.

## Consequences

### Positive

- Newer clients (2025-03-26 and later) can negotiate the version they need;
  older 2024-11-05 clients keep working unchanged.
- Adding a future supported version is a one-line change in
  `src/mcp/protocol.ts`.
- Standard clients that send `notifications/initialized` no longer receive a
  spurious protocol error.

### Negative

- The server advertises `2025-11-25` but does not yet implement its new
  features (Tasks, URL-mode elicitation); clients that require them must
  detect the missing capabilities from `capabilities`.
- The 2026-07-28 stateless redesign will eventually force a breaking change;
  deferring it accumulates a known migration debt.

## Related Documents

- `src/mcp/protocol.ts`
- `src/mcp/server.ts`
- `tests/unit/mcp-protocol.test.ts`
- MCP specification changelog (modelcontextprotocol.io)
