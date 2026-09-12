// MCP protocol version negotiation.
// See docs/adr/002-mcp-protocol-version-negotiation.md for the rationale.

// Ordered oldest → newest. The last entry is the preferred (latest) version
// that the server advertises when it cannot honor the client's request.
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
] as const;

export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export const PREFERRED_PROTOCOL_VERSION: SupportedProtocolVersion =
  SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

// Per the MCP spec: if the server supports the client's requested version it
// MUST respond with that same version; otherwise it responds with the latest
// version it supports and the client decides whether to continue.
export function negotiateProtocolVersion(requested: string | undefined): SupportedProtocolVersion {
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    if (version === requested) return version;
  }
  return PREFERRED_PROTOCOL_VERSION;
}
