import { describe, test, expect } from "bun:test";
import { validateAgentResultSummary } from "../../src/contract/validate.ts";

describe("contract validation", () => {
  test("accepts valid success payload", () => {
    const result = validateAgentResultSummary({ status: "success", reason: "done" });
    expect(result.ok).toBe(true);
  });

  test("rejects invalid status", () => {
    const result = validateAgentResultSummary({ status: "unknown", reason: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("status"))).toBe(true);
    }
  });

  test("rejects needs_retry without reason", () => {
    const result = validateAgentResultSummary({ status: "needs_retry" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("reason"))).toBe(true);
    }
  });

  test("rejects abandoned with empty reason", () => {
    const result = validateAgentResultSummary({ status: "abandoned", reason: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("reason"))).toBe(true);
    }
  });

  test("accepts non-object input and reports error", () => {
    const result = validateAgentResultSummary("not an object");
    expect(result.ok).toBe(false);
  });
});
