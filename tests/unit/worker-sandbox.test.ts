import { describe, expect, test } from "bun:test";
import { resolveSandboxAndPermission } from "../../src/orchestrator/worker.ts";

describe("resolveSandboxAndPermission — per-issue merge (nano)", () => {
  test("sandbox_mode=off sets backend to none for nano", () => {
    const result = resolveSandboxAndPermission(
      "nano",
      { sandbox_mode: "off" },
      {
        kind: "nano",
        binary: "nano",
        timeout_ms: 5000,
        sandbox: {
          backend: "native",
          network_access: true,
          extra_read_only_paths: [],
          extra_writable_paths: [],
          extra_denied_paths: [],
        },
        permission_auto: { backend: "llm", model: "m", confidence_threshold: 0.8, timeout_seconds: 5, cache_ttl_minutes: 30, allow_rules: [], denial_max_consecutive: 0, denial_max_total: 0 },
      } as any,
    );
    expect(result.sandboxConfig.backend).toBe("none");
  });

  test("sandbox_extra_writable_paths are merged with workflow paths for nano", () => {
    const result = resolveSandboxAndPermission(
      "nano",
      { sandbox_extra_writable_paths: ["/issue/extra"] },
      {
        sandbox: {
          backend: "native",
          network_access: true,
          extra_read_only_paths: [],
          extra_writable_paths: ["/wf/path"],
          extra_denied_paths: [],
        },
      } as any,
    );
    expect(result.sandboxConfig.extra_writable_paths).toContain("/wf/path");
    expect(result.sandboxConfig.extra_writable_paths).toContain("/issue/extra");
  });

  test("per-issue sandbox overrides are now supported for claude-code", () => {
    const result = resolveSandboxAndPermission(
      "claude-code",
      { sandbox_mode: "off", sandbox_extra_writable_paths: ["/issue/extra"] },
      {
        sandbox: {
          backend: "native",
          network_access: true,
          extra_read_only_paths: [],
          extra_writable_paths: ["/wf/path"],
          extra_denied_paths: [],
        },
      } as any,
    );
    // claude-code now supports per-issue sandbox_mode override
    expect(result.sandboxConfig.backend).toBe("none");
    expect(result.sandboxConfig.extra_writable_paths).toContain("/issue/extra");
    expect(result.sandboxConfig.extra_writable_paths).toContain("/wf/path");
  });

  test("extra_denied_paths from workflow are forwarded", () => {
    const result = resolveSandboxAndPermission(
      "nano",
      {},
      {
        sandbox: {
          backend: "native",
          network_access: true,
          extra_read_only_paths: [],
          extra_writable_paths: [],
          extra_denied_paths: ["/wf/denied"],
        },
      } as any,
    );
    expect(result.sandboxConfig.extra_denied_paths).toEqual(["/wf/denied"]);
  });

  test("defaults sandbox config when workflow has none", () => {
    const result = resolveSandboxAndPermission("nano", {}, undefined);
    expect(result.sandboxConfig.backend).toBe("native");
    expect(result.sandboxConfig.network_access).toBe(true);
    expect(result.sandboxConfig.extra_writable_paths).toEqual([]);
    expect(result.sandboxConfig.extra_denied_paths).toEqual([]);
  });
});

describe("resolveSandboxAndPermission — permission mode default (§4.6-default)", () => {
  test("nano with permission_auto defaults to auto", () => {
    const result = resolveSandboxAndPermission(
      "nano",
      {},
      {
        sandbox: { backend: "native", network_access: true, extra_read_only_paths: [], extra_writable_paths: [], extra_denied_paths: [] },
        permission_auto: { backend: "llm", model: "m", confidence_threshold: 0.8, timeout_seconds: 5, cache_ttl_minutes: 30, allow_rules: [], denial_max_consecutive: 0, denial_max_total: 0 },
      } as any,
    );
    expect(result.permissionMode).toBe("auto");
  });

  test("nano without permission_auto defaults to default", () => {
    const result = resolveSandboxAndPermission(
      "nano",
      {},
      {
        sandbox: { backend: "native", network_access: true, extra_read_only_paths: [], extra_writable_paths: [], extra_denied_paths: [] },
      } as any,
    );
    expect(result.permissionMode).toBe("default");
  });

  test("workflow-pinned permission_mode wins over nano default", () => {
    const result = resolveSandboxAndPermission(
      "nano",
      {},
      {
        sandbox: { backend: "native", network_access: true, extra_read_only_paths: [], extra_writable_paths: [], extra_denied_paths: [] },
        permission_mode: "plan",
        permission_auto: { backend: "llm", model: "m", confidence_threshold: 0.8, timeout_seconds: 5, cache_ttl_minutes: 30, allow_rules: [], denial_max_consecutive: 0, denial_max_total: 0 },
      } as any,
    );
    expect(result.permissionMode).toBe("plan");
  });

  test("claude-code gets undefined permission mode when workflow omits it", () => {
    const result = resolveSandboxAndPermission(
      "claude-code",
      {},
      {
        sandbox: { backend: "native", network_access: true, extra_read_only_paths: [], extra_writable_paths: [], extra_denied_paths: [] },
      } as any,
    );
    expect(result.permissionMode).toBeUndefined();
  });
});

describe("resolveSandboxAndPermission — permission mode floor (§4.6a)", () => {
  test("sandbox=off + yolo is floored to auto when permission_auto exists", () => {
    const result = resolveSandboxAndPermission(
      "nano",
      { sandbox_mode: "off" },
      {
        sandbox: { backend: "native", network_access: true, extra_read_only_paths: [], extra_writable_paths: [], extra_denied_paths: [] },
        permission_mode: "yolo",
        permission_auto: { backend: "llm", model: "m", confidence_threshold: 0.8, timeout_seconds: 5, cache_ttl_minutes: 30, allow_rules: [], denial_max_consecutive: 0, denial_max_total: 0 },
      } as any,
    );
    expect(result.permissionMode).toBe("auto");
    expect(result.permissionFloored).toEqual({ from: "yolo", to: "auto" });
  });

  test("sandbox=off + acceptEdits is floored to default when no permission_auto", () => {
    const result = resolveSandboxAndPermission(
      "nano",
      { sandbox_mode: "off" },
      {
        sandbox: { backend: "native", network_access: true, extra_read_only_paths: [], extra_writable_paths: [], extra_denied_paths: [] },
        permission_mode: "acceptEdits",
      } as any,
    );
    expect(result.permissionMode).toBe("default");
    expect(result.permissionFloored).toEqual({ from: "acceptEdits", to: "default" });
  });

  test("sandbox=off + plan is NOT floored", () => {
    const result = resolveSandboxAndPermission(
      "nano",
      { sandbox_mode: "off" },
      {
        sandbox: { backend: "native", network_access: true, extra_read_only_paths: [], extra_writable_paths: [], extra_denied_paths: [] },
        permission_mode: "plan",
        permission_auto: { backend: "llm", model: "m", confidence_threshold: 0.8, timeout_seconds: 5, cache_ttl_minutes: 30, allow_rules: [], denial_max_consecutive: 0, denial_max_total: 0 },
      } as any,
    );
    expect(result.permissionMode).toBe("plan");
    expect(result.permissionFloored).toBeNull();
  });

  test("sandbox=on + yolo is NOT floored", () => {
    const result = resolveSandboxAndPermission(
      "nano",
      {},
      {
        sandbox: { backend: "native", network_access: true, extra_read_only_paths: [], extra_writable_paths: [], extra_denied_paths: [] },
        permission_mode: "yolo",
        permission_auto: { backend: "llm", model: "m", confidence_threshold: 0.8, timeout_seconds: 5, cache_ttl_minutes: 30, allow_rules: [], denial_max_consecutive: 0, denial_max_total: 0 },
      } as any,
    );
    expect(result.permissionMode).toBe("yolo");
    expect(result.permissionFloored).toBeNull();
  });

  test("no floor event when permission_mode is defaulted (not floored)", () => {
    // Nano without permission_auto → defaults to "default", not floored
    const result = resolveSandboxAndPermission(
      "nano",
      {},
      {
        sandbox: { backend: "native", network_access: true, extra_read_only_paths: [], extra_writable_paths: [], extra_denied_paths: [] },
      } as any,
    );
    expect(result.permissionMode).toBe("default");
    expect(result.permissionFloored).toBeNull();
  });

  test("claude-code + sandbox=off + yolo does NOT trigger floor (§3)", () => {
    const result = resolveSandboxAndPermission(
      "claude-code",
      { sandbox_mode: "off" },
      {
        sandbox: { backend: "native", network_access: true, extra_read_only_paths: [], extra_writable_paths: [], extra_denied_paths: [] },
        permission_mode: "yolo",
        permission_auto: { backend: "llm", model: "m", confidence_threshold: 0.8, timeout_seconds: 5, cache_ttl_minutes: 30, allow_rules: [], denial_max_consecutive: 0, denial_max_total: 0 },
      } as any,
    );
    // claude-code has its own permission system; symphony floor must not apply
    expect(result.permissionFloored).toBeNull();
  });

  test("claude-code + sandbox=off + acceptEdits does NOT trigger floor (§3)", () => {
    const result = resolveSandboxAndPermission(
      "claude-code",
      { sandbox_mode: "off" },
      {
        sandbox: { backend: "native", network_access: true, extra_read_only_paths: [], extra_writable_paths: [], extra_denied_paths: [] },
        permission_mode: "acceptEdits",
      } as any,
    );
    expect(result.permissionFloored).toBeNull();
  });
});

