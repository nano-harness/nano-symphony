import path from "path";
import os from "os";
import { readFile } from "node:fs/promises";
import { AgentResultSummarySchema, parseLastJsonLine } from "../agent-result-payload.ts";
import type { AgentResultSummary, AgentArtifacts } from "../agent-result-payload.ts";
import { registerAdapter, type AgentAdapter, type WorkspaceFile, type SpawnInvocation } from "../agent-adapter.ts";
import type { SpawnContext } from "../types.ts";
import type { Workflow } from "../../workflow/types.ts";

// Returns platform-specific default read-only paths for native sandbox.
function platformDefaultReadOnlyPaths(backend: "native" | "docker" | "none"): string[] {
  if (backend !== "native") return [];
  const homeDir = os.homedir();
  if (process.platform === "darwin") {
    return [
      "/opt/homebrew",
      "/usr/local",
      "/Library/Developer/CommandLineTools",
      "/Applications/Xcode.app/Contents/Developer",
      path.join(homeDir, ".local"),
      path.join(homeDir, ".bun"),
      path.join(homeDir, ".cargo"),
      path.join(homeDir, ".rustup"),
    ];
  }
  if (process.platform === "linux") {
    return [
      "/opt",
      path.join(homeDir, ".local"),
      path.join(homeDir, ".bun"),
      path.join(homeDir, ".cargo"),
      path.join(homeDir, ".rustup"),
      path.join(homeDir, ".nvm"),
      path.join(homeDir, ".pyenv"),
    ];
  }
  return [];
}

function mandatoryReadOnlyPaths(backend: "native" | "docker" | "none"): string[] {
  if (backend !== "native") return [];
  return [path.join(os.homedir(), ".config", "nano")];
}

function renderYamlList(key: string, values: string[]): string {
  if (values.length === 0) return `  ${key}: []`;
  return [`  ${key}:`, ...values.map((p) => `    - ${JSON.stringify(p)}`)].join("\n");
}

function renderIndentedYamlList(indent: string, key: string, values: string[]): string[] {
  if (values.length === 0) return [];
  return [`${indent}${key}:`, ...values.map((v) => `${indent}  - ${JSON.stringify(v)}`)];
}

function renderNanoYaml(ctx: SpawnContext): string {
  const sandbox = ctx.sandboxConfig ?? {
    backend: "native" as const,
    network_access: true,
    extra_read_only_paths: [],
    extra_writable_paths: [],
    extra_denied_paths: [],
  };

  const extraReadOnlyPaths = sandbox.extra_read_only_paths ?? [];
  const extraWritablePaths = sandbox.extra_writable_paths ?? [];
  const extraDeniedPaths = sandbox.extra_denied_paths ?? [];
  const sandboxBackend = sandbox.backend;
  const readOnlyPaths = mandatoryReadOnlyPaths(sandboxBackend);

  const platformPaths = platformDefaultReadOnlyPaths(sandboxBackend);
  const allReadOnlyPaths = [...new Set([...extraReadOnlyPaths, ...platformPaths])];

  const dockerLines = [
    sandbox.backend === "docker" ? `  docker_image: ${JSON.stringify(sandbox.docker_image ?? "ubuntu:24.04")}` : null,
    sandbox.backend === "docker" && sandbox.docker_runtime
      ? `  docker_runtime: ${JSON.stringify(sandbox.docker_runtime)}`
      : null,
  ].filter((line): line is string => line !== null);

  const permissionLines: string[] = [];
  if (ctx.permissionMode) {
    permissionLines.push(`\npermission_mode: ${ctx.permissionMode}`);
  }
  if (ctx.permissionAuto) {
    permissionLines.push(`\npermission_auto:`);
    permissionLines.push(`  backend: ${ctx.permissionAuto.backend}`);
    if (ctx.permissionAuto.model && !process.env.NANO_PERMISSION_AUTO_MODEL) {
      permissionLines.push(`  model: ${JSON.stringify(ctx.permissionAuto.model)}`);
    }
    permissionLines.push(`  confidence_threshold: ${ctx.permissionAuto.confidence_threshold}`);
    permissionLines.push(`  timeout_seconds: ${ctx.permissionAuto.timeout_seconds}`);
    permissionLines.push(`  cache_ttl_minutes: ${ctx.permissionAuto.cache_ttl_minutes}`);
    permissionLines.push(...renderIndentedYamlList("  ", "allow_rules", ctx.permissionAuto.allow_rules ?? []));
    if (ctx.permissionAuto.denial_max_consecutive > 0) {
      permissionLines.push(`  denial_max_consecutive: ${ctx.permissionAuto.denial_max_consecutive}`);
    }
    if (ctx.permissionAuto.denial_max_total > 0) {
      permissionLines.push(`  denial_max_total: ${ctx.permissionAuto.denial_max_total}`);
    }
  }

  const deniedPathsLine = sandboxBackend !== "none" && extraDeniedPaths.length > 0
    ? `\n${renderYamlList("extra_denied_paths", extraDeniedPaths)}`
    : "";

  return `mcp:
  servers:
    - name: symphony
      url: "${ctx.mcpUrl}"
      transport: streamable
      headers:
        X-Symphony-Token: "\${env:SYMPHONY_TOKEN}"

sandbox:
  enabled: ${sandboxBackend !== "none"}
  backend: ${sandboxBackend}
  network_access: ${sandbox.network_access}
${renderYamlList("extra_read_only_paths", allReadOnlyPaths)}
${renderYamlList("extra_writable_paths", extraWritablePaths)}
${renderYamlList("read_only_paths", readOnlyPaths)}${deniedPathsLine}
${dockerLines.length > 0 ? `\n${dockerLines.join("\n")}` : ""}${permissionLines.join("\n")}
`;
}

export const nanoAdapter: AgentAdapter = {
  kind: "nano",

  renderWorkspaceFiles(ctx: SpawnContext): WorkspaceFile[] {
    return [
      {
        path: ".nano/nano.yaml",
        contents: renderNanoYaml(ctx),
        mode: 0o644,
      },
    ];
  },

  buildSpawnInvocation(ctx: SpawnContext): SpawnInvocation {
    const sandboxBackend = ctx.sandboxConfig?.backend ?? "native";
    const sandboxEnabled = sandboxBackend !== "none";
    const sandboxFlag = sandboxEnabled ? "on" : "off";
    const args = [`binary`, "exec", `--sandbox=${sandboxFlag}`,
      "--config", ".nano/nano.yaml",
      "--output-dir", ctx.outputDir];
    if (ctx.permissionMode) {
      args.push(`--permission-mode=${ctx.permissionMode}`);
    }

    const allowedPaths = [
      ctx.workspace,
      ...(ctx.sandboxConfig?.extra_writable_paths ?? []),
      ...(ctx.sandboxConfig?.extra_read_only_paths ?? []),
    ].filter(Boolean).join(":");

    const env: Record<string, string> = {
      SYMPHONY_TOKEN: ctx.token,
      SYMPHONY_ISSUE_ID: ctx.issueId,
      SYMPHONY_WORKSPACE: ctx.workspace,
      SYMPHONY_MCP_URL: ctx.mcpUrl,
      NANO_SANDBOX_ENABLED: sandboxEnabled ? "true" : "false",
      NANO_SANDBOX_NETWORK_ACCESS: String(ctx.sandboxConfig?.network_access ?? true),
      NANO_SANDBOX_BACKEND: sandboxBackend,
      NANO_SANDBOX_ALLOWED_PATHS: allowedPaths,
      NANO_LOG_LEVEL: "info",
    };
    if (ctx.permissionMode) {
      env.NANO_PERMISSION_MODE = ctx.permissionMode;
    }
    if (ctx.permissionAuto?.model) {
      env.NANO_PERMISSION_AUTO_MODEL = ctx.permissionAuto.model;
    }
    return { argv: [ctx.binary, ...args], env };
  },

  parseResult(stdout: string): AgentResultSummary | null {
    return parseLastJsonLine(stdout, AgentResultSummarySchema);
  },

  async collectArtifacts(ctx: SpawnContext): Promise<AgentArtifacts> {
    try {
      const patch = await readFile(path.join(ctx.outputDir, "solution.patch"), "utf8");
      return { patch };
    } catch {
      return {};
    }
  },

  resolvePermissionMode(agentConfig: Workflow["agent"] | undefined): string | undefined {
    return agentConfig?.permission_mode
      ?? (agentConfig?.permission_auto ? "auto" : "default");
  },

  applyPermissionFloor(ctx: {
    resolvedPermissionMode: string | undefined;
    sandboxOff: boolean;
    agentConfig: Workflow["agent"] | undefined;
  }): { resolvedPermissionMode: string | undefined; floored: { from: string; to: string } | null } {
    const PERMISSIVE_MODES = new Set(["yolo", "acceptEdits"]);
    if (ctx.sandboxOff && ctx.resolvedPermissionMode && PERMISSIVE_MODES.has(ctx.resolvedPermissionMode)) {
      const original = ctx.resolvedPermissionMode;
      const adjusted = ctx.agentConfig?.permission_auto ? "auto" : "default";
      return { resolvedPermissionMode: adjusted, floored: { from: original, to: adjusted } };
    }
    return { resolvedPermissionMode: ctx.resolvedPermissionMode, floored: null };
  },
};

registerAdapter(nanoAdapter);
