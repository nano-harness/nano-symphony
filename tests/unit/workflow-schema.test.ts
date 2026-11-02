import { describe, expect, test } from "bun:test";
import { WorkflowSchema } from "../../src/workflow/types.ts";

describe("workflow schema - agent config", () => {
  test("accepts valid agent config", () => {
    const parsed = WorkflowSchema.safeParse({
      tracker: { type: "local" },
      agent: {
        kind: "nano",
        binary: "nano",
        timeout_ms: 3600000,
        max_retries: 3,
        extra_env: { FOO: "bar" },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.agent?.kind).toBe("nano");
    expect(parsed.data?.agent?.extra_env).toEqual({ FOO: "bar" });
  });

  test("defaults to claude-code kind and 1h timeout", () => {
    const parsed = WorkflowSchema.parse({
      tracker: { type: "local" },
      agent: {},
    });
    expect(parsed.agent?.kind).toBe("claude-code");
    expect(parsed.agent?.timeout_ms).toBe(3600000);
    expect(parsed.agent?.max_retries).toBe(3);
  });

  test("silently ignores removed sandbox/permission fields", () => {
    const parsed = WorkflowSchema.safeParse({
      tracker: { type: "local" },
      agent: {
        sandbox: { backend: "native" },
        permission_mode: "auto",
        permission_auto: { allow_rules: [] },
      },
    });
    // Schema accepts known fields (sandbox, permission_mode) and passes through
    // unknown fields (permission_auto) without throwing — backward compat.
    expect(parsed.success).toBe(true);
    // Known fields are now preserved (added in B3)
    expect((parsed.data?.agent as any)?.sandbox).toEqual({ backend: "native" });
    expect((parsed.data?.agent as any)?.permission_mode).toBe("auto");
    // Unknown fields pass through silently (passthrough mode) — no rejection
    expect(parsed.data?.agent).toBeDefined();
  });

  test("rejects invalid agent kind", () => {
    const parsed = WorkflowSchema.safeParse({
      tracker: { type: "local" },
      agent: { kind: "gpt-5" },
    });
    expect(parsed.success).toBe(false);
  });
});
