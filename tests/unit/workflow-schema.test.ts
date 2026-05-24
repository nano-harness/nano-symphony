import { describe, expect, test } from "bun:test";
import { WorkflowSchema } from "../../src/workflow/types.ts";

describe("workflow schema - permission_auto passthrough", () => {
  test("AcceptsNewFields", () => {
    const parsed = WorkflowSchema.safeParse({
      tracker: { type: "local" },
      agent: {
        permission_auto: {
          backend: "llm",
          confidence_threshold: 0.8,
          timeout_seconds: 5,
          cache_ttl_minutes: 30,
          allow_rules: ["Bash(vwsd *)"],
          denial_max_consecutive: 3,
          denial_max_total: 20,
        },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.agent?.permission_auto?.allow_rules).toEqual(["Bash(vwsd *)"]);
  });

  test("Defaults", () => {
    const parsed = WorkflowSchema.parse({
      tracker: { type: "local" },
      agent: { permission_auto: {} },
    });
    expect(parsed.agent?.permission_auto?.allow_rules).toEqual([]);
    expect(parsed.agent?.permission_auto?.denial_max_consecutive).toBe(0);
    expect(parsed.agent?.permission_auto?.denial_max_total).toBe(0);
  });

  test("StrictRejectsRemovedFields", () => {
    const parsed = WorkflowSchema.safeParse({
      tracker: { type: "local" },
      agent: { permission_auto: { trusted_binaries: ["vwsd"] } },
    });
    expect(parsed.success).toBe(false);
  });

  test("StrictRejectsTypo", () => {
    const parsed = WorkflowSchema.safeParse({
      tracker: { type: "local" },
      agent: { permission_auto: { allowed_rules: ["Bash(vwsd *)"] } },
    });
    expect(parsed.success).toBe(false);
  });
});

