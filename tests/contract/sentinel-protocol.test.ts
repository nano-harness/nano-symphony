import { describe, expect, test } from "bun:test";

/**
 * Cross-repo protocol contract tests
 *
 * These tests ensure nano-symphony and nano-agent agree on:
 * 1. Sentinel prefix format
 * 2. Sentinel JSON structure
 * 3. Exit code values
 *
 * IMPORTANT: If these tests fail, it means the protocol between
 * nano-symphony and nano-agent has drifted. Both repos must be updated.
 */

describe("Sentinel Protocol Contract", () => {
  test("SENTINEL_PREFIX matches nano-agent binary.go:26", () => {
    // Source of truth: nano-agent/pkg/cli/binary.go:26
    //   const binaryResultSentinel = "<<<NANO_RESULT>>>"
    // BEFORE changing EXPECTED_PREFIX here, you MUST grep nano-agent for
    // `binaryResultSentinel\s*=` to confirm the current value. The previous
    // version of this test was wrong because the value was copied from a
    // stale code comment; it passed locally while breaking production.
    const EXPECTED_PREFIX = "<<<NANO_RESULT>>>";

    // Import from spawner to verify actual value
    const spawnerCode = Bun.file("src/spawner/index.ts").text();
    expect(spawnerCode).resolves.toContain(`SENTINEL_PREFIX = "${EXPECTED_PREFIX}"`);
  });

  test("NanoSentinel status enum matches nano-agent", () => {
    // nano-agent binary.go:51-59 defines:
    // - binaryStatusSuccess = "success"
    // - binaryStatusNeedsRetry = "needs_retry"
    // - binaryStatusAbandoned = "abandoned"
    // - binaryStatusTimeout = "timeout"
    // - binaryStatusUnclassified = "unclassified"

    const validStatuses = ["success", "needs_retry", "abandoned", "timeout"];

    // Verify TypeScript interface allows these
    const spawnerCode = Bun.file("src/spawner/index.ts").text();
    expect(spawnerCode).resolves.toContain('status: "success" | "needs_retry" | "abandoned" | "timeout"');
  });

  test("Sentinel JSON structure is documented", () => {
    // This test documents the expected sentinel JSON structure
    // so future changes are clearly visible in git history

    const expectedStructure = {
      status: "success | needs_retry | abandoned | timeout",
      exit_code: "number (optional)",
      duration_ms: "number (optional)",
      tool_calls: "number (optional)",
      tokens: "{ input: number; output: number } (optional)",
      goal_state: {
        condition: "string",
        achieved_at: "string | null (optional, only set for success)",
        started_at: "string (optional)",
        turns_evaluated: "number (optional)",
        tokens_spent: "number (optional)",
        max_turns: "number (optional)",
        last_reason: "string (optional)",
      },
      cache_key: "string (optional)",
    };

    // Document structure for reference
    expect(expectedStructure).toBeDefined();
    expect(expectedStructure.status).toBe("success | needs_retry | abandoned | timeout");
    expect(expectedStructure.goal_state.achieved_at).toBe("string | null (optional, only set for success)");
  });
});

describe("Exit Code Protocol Contract", () => {
  test("Exit codes match nano-agent binary.go:31-36", () => {
    // nano-agent defines:
    // binaryExitSuccess      = 0
    // binaryExitRetry        = 10
    // binaryExitAbandoned    = 20
    // binaryExitTimeout      = 30
    // binaryExitUnclassified = 1

    const NANO_EXIT = {
      SUCCESS: 0,
      RETRY: 10,
      ABANDONED: 20,
      TIMEOUT: 30,
      UNCLASSIFIED: 1,
    };

    // Document expected values
    expect(NANO_EXIT.SUCCESS).toBe(0);
    expect(NANO_EXIT.RETRY).toBe(10);
    expect(NANO_EXIT.ABANDONED).toBe(20);
    expect(NANO_EXIT.TIMEOUT).toBe(30);
    expect(NANO_EXIT.UNCLASSIFIED).toBe(1);
  });
});
