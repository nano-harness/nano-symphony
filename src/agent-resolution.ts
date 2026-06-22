export type AgentKind = "nano" | "claude-code";

export const AGENT_KIND_BINARY_DEFAULTS: Record<AgentKind, string> = {
  "claude-code": "claude",
  "nano": "nano",
};

export interface ResolvedAgent {
  kind: AgentKind;
  binary: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface AgentOverride {
  kind?: AgentKind;
  binary?: string;
}

export interface AgentDefaults {
  kind?: AgentKind;
  binary?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface AgentRoleProfile extends AgentDefaults {
  extra_env?: Record<string, string>;
  transport?: "cli" | "mcp";
  permission_mode?: string;
  permissions?: {
    allow?: string[];
    deny?: string[];
    denial_max_consecutive?: number;
    denial_max_total?: number;
  };
  sandbox?: Record<string, unknown>;
  trusted_binaries?: string[];
  hooks?: Record<string, unknown>;
}

/**
 * 统一解析 agent 配置。优先级：issue 字段 > plan-runtime 覆盖 > role 配置 > 顶层 agent 默认。
 *
 * 调用方决定 override 从哪来（plan-runtime 或 issue），不必关心内部优先级链。
 *
 * Binary 规则：
 * - 如果 override 给了 binary，直接用它（调用方负责合理性）。
 * - 如果 override 没给 binary 但给了 kind，用该 kind 的默认值。
 * - 如果 override 为空，用 defaults 的 binary；defaults 也没给则用该 kind 的默认值。
 */
export function resolveAgent(
  override: AgentOverride | null | undefined,
  defaults: AgentDefaults = {},
  roleProfile?: AgentRoleProfile | null,
): ResolvedAgent & { roleProfile?: AgentRoleProfile | null } {
  const baseKind = roleProfile?.kind ?? defaults.kind ?? "claude-code";
  const kind = override?.kind ?? baseKind;
  const binary =
    override?.binary ??
    (override?.kind ? AGENT_KIND_BINARY_DEFAULTS[override.kind] : undefined) ??
    roleProfile?.binary ??
    (roleProfile?.kind ? AGENT_KIND_BINARY_DEFAULTS[roleProfile.kind] : undefined) ??
    defaults.binary ??
    AGENT_KIND_BINARY_DEFAULTS[kind] ??
    "claude";
  const timeoutMs = roleProfile?.timeoutMs ?? defaults.timeoutMs ?? 3_600_000;
  const maxRetries = roleProfile?.maxRetries ?? defaults.maxRetries ?? 3;

  return { kind, binary, timeoutMs, maxRetries, roleProfile };
}
