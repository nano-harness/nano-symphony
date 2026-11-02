import { describe, expect, test } from "bun:test";
import { AgentResultSummarySchema, AgentArtifactsSchema, parseLastJsonLine } from "../../src/spawner/agent-result-payload.ts";

// Do not change .passthrough() back to .strict() in agent-result-payload.ts.
// Agents emit diagnostic fields that are not declared in the schema.

describe("AgentResultSummarySchema", () => {
  test("accepts minimal payload", () => {
    const parsed = AgentResultSummarySchema.safeParse({ status: "success" });
    expect(parsed.success).toBe(true);
  });

  test("accepts unknown top-level fields (passthrough)", () => {
    const parsed = AgentResultSummarySchema.safeParse({ status: "success", extra: 1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as any).extra).toBe(1);
    }
  });

  test("accepts nano-agent v0.7 full output with extra diagnostic fields", () => {
    const nanoV07Output = {
      status: "success",
      termination_cause: "natural_completion",
      tool_calls: 2,
      duration_ms: 18089,
      tokens: { input: 11285, output: 20 },
      goal_state: {
        condition: "the issue is resolved and relevant checks pass",
        started_at: "2026-05-25T00:39:55.746413+08:00",
        turns_evaluated: 1,
        tokens_spent: 408,
        max_turns: 50,
        last_reason: "Goal achieved",
        achieved_at: "2026-05-25T00:40:12.945949+08:00",
      },
      cache_key: "u92LBASiW5YSOk77oOavR",
    };
    const parsed = AgentResultSummarySchema.safeParse(nanoV07Output);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("success");
      expect(parsed.data.goal_state?.last_reason).toBe("Goal achieved");
      expect(parsed.data.tokens?.input).toBe(11285);
      // Unknown fields are preserved via passthrough
      expect((parsed.data as any).termination_cause).toBe("natural_completion");
      expect((parsed.data as any).cache_key).toBe("u92LBASiW5YSOk77oOavR");
      expect((parsed.data.goal_state as any).condition).toBe("the issue is resolved and relevant checks pass");
    }
  });

  test("rejects invalid status enum value", () => {
    const parsed = AgentResultSummarySchema.safeParse({ status: "weird" });
    expect(parsed.success).toBe(false);
  });

  test("rejects non-object input", () => {
    expect(AgentResultSummarySchema.safeParse("oops").success).toBe(false);
    expect(AgentResultSummarySchema.safeParse(42).success).toBe(false);
    expect(AgentResultSummarySchema.safeParse(null).success).toBe(false);
  });

  test("rejects tokens with wrong types (still validates declared fields)", () => {
    const parsed = AgentResultSummarySchema.safeParse({
      status: "success",
      tokens: { input: "not-number", output: 20 },
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects blocked_commands_sample longer than 20", () => {
    const parsed = AgentResultSummarySchema.safeParse({
      status: "abandoned",
      blocked_commands_sample: Array.from({ length: 21 }, (_, i) => `cmd-${i}`),
    });
    expect(parsed.success).toBe(false);
  });

  test("accepts full payload with all optional fields", () => {
    const parsed = AgentResultSummarySchema.safeParse({
      status: "needs_retry",
      reason: "temp failure",
      goal_state: { last_reason: "could not connect", iterations: 3 },
      tokens: { input: 1000, output: 200, cached: 50 },
      sandbox: { backend: "native", network: "allowed" },
      blocked_commands_sample: ["curl x"],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects non-success status without a reason", () => {
    const parsed = AgentResultSummarySchema.safeParse({ status: "needs_retry" });
    expect(parsed.success).toBe(false);
  });

  test("rejects non-success status with empty reason", () => {
    const parsed = AgentResultSummarySchema.safeParse({ status: "abandoned", reason: "   " });
    expect(parsed.success).toBe(false);
  });

  test("accepts success status without a reason", () => {
    const parsed = AgentResultSummarySchema.safeParse({ status: "success" });
    expect(parsed.success).toBe(true);
  });

  test("accepts unknown fields in nested objects (goal_state, tokens, sandbox)", () => {
    const parsed = AgentResultSummarySchema.safeParse({
      status: "success",
      goal_state: { last_reason: "done", iterations: 1, new_nested_field: true },
      tokens: { input: 100, output: 50, some_future_metric: 999 },
      sandbox: { backend: "native", network: "allowed", isolation_level: "full" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data.goal_state as any).new_nested_field).toBe(true);
      expect((parsed.data.tokens as any).some_future_metric).toBe(999);
      expect((parsed.data.sandbox as any).isolation_level).toBe("full");
    }
  });
});

describe("AgentArtifactsSchema", () => {
  test("accepts empty object", () => {
    const parsed = AgentArtifactsSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  test("accepts arbitrary adapter-specific artifact fields", () => {
    const parsed = AgentArtifactsSchema.safeParse({ patch: "diff --git a/foo b/foo\n", files: ["a.txt"] });
    expect(parsed.success).toBe(true);
  });
});

describe("parseLastJsonLine", () => {
  test("parses single-line JSON", () => {
    const result = parseLastJsonLine('{"status":"success"}', AgentResultSummarySchema);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("success");
  });

  test("parses last JSON line in multi-line output", () => {
    const text = 'some log output\nmore output\n{"status":"success","reason":"done"}';
    const result = parseLastJsonLine(text, AgentResultSummarySchema);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("success");
  });

  test("skips trailing blank lines", () => {
    const text = '{"status":"success","reason":"done"}\n\n\n';
    const result = parseLastJsonLine(text, AgentResultSummarySchema);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("success");
  });

  test("skips [err] prefixed lines", () => {
    const text = '{"status":"success","reason":"done"}\n[err] some error\n';
    const result = parseLastJsonLine(text, AgentResultSummarySchema);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("success");
  });

  test("finds valid JSON line before invalid trailing lines", () => {
    const text = 'start\n{"status":"needs_retry","reason":"fail"}\nnot json\n\n';
    const result = parseLastJsonLine(text, AgentResultSummarySchema);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("needs_retry");
  });

  test("returns null for empty input", () => {
    expect(parseLastJsonLine("", AgentResultSummarySchema)).toBeNull();
    expect(parseLastJsonLine("   ", AgentResultSummarySchema)).toBeNull();
  });

  test("returns null when no valid JSON matches schema", () => {
    const text = 'some text\n{"invalid":"data"}\nmore text';
    const result = parseLastJsonLine(text, AgentResultSummarySchema);
    expect(result).toBeNull();
  });
});

