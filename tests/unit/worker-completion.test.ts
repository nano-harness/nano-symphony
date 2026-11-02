import { describe, expect, test } from "bun:test";
import { deriveCompletion } from "../../src/orchestrator/worker.ts";

describe("deriveCompletion", () => {
  test("retries when process was killed by timeout", () => {
    const result = deriveCompletion(
      { exitCode: null, killedByTimeout: true, duration_ms: 10, agentResult: null, artifacts: {} },
      null
    );
    expect(result.semantics).toBe("needs_retry");
    expect(result.blockerFingerprint).toBe("killed_by_timeout");
    expect(result.terminationCause).toBe("timeout");
  });

  test("missing result payload is a hard failure", () => {
    const result = deriveCompletion(
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, agentResult: null, artifacts: {} },
      null
    );
    expect(result.semantics).toBe("abandoned");
    expect(result.terminationCause).toBe("no_result_payload");
  });

  test("needs_retry falls back to normalizeBlockerString", () => {
    const result = deriveCompletion(
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, agentResult: null, artifacts: {} },
      {
        status: "needs_retry",
        goal_state: { last_reason: "Process 12345 exited at 2026-05-21T10:00:00Z" },
      }
    );
    expect(result.semantics).toBe("needs_retry");
    // Normalized: timestamps and PIDs removed
    expect(result.blockerFingerprint).toContain("Process");
    expect(result.blockerFingerprint).not.toContain("12345");
    expect(result.blockerFingerprint).not.toContain("2026-05-21");
  });

  test("success uses payload reason", () => {
    const result = deriveCompletion(
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, agentResult: null, artifacts: {} },
      { status: "success", reason: "ok" }
    );
    expect(result.semantics).toBe("success");
    expect(result.summary).toBe("ok");
    expect(result.blockerFingerprint).toBeUndefined();
  });

  test("abandoned uses goal_state.last_reason as fingerprint", () => {
    const result = deriveCompletion(
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, agentResult: null, artifacts: {} },
      { status: "abandoned", goal_state: { last_reason: "sandbox denied" } }
    );
    expect(result.semantics).toBe("abandoned");
    expect(result.blockerFingerprint).toBe("sandbox denied");
  });

  test("exit code mismatch downgrades success to needs_retry", () => {
    const result = deriveCompletion(
      { exitCode: 1, killedByTimeout: false, duration_ms: 10, agentResult: null, artifacts: {} },
      { status: "success", reason: "all good" }
    );
    expect(result.semantics).toBe("needs_retry");
    expect(result.summary).toContain("exited with code 1");
    expect(result.blockerFingerprint).toBe("exitcode_mismatch:1");
    expect(result.terminationCause).toBe("exitcode_mismatch");
  });

  test("exit code 0 with success payload is not downgraded", () => {
    const result = deriveCompletion(
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, agentResult: null, artifacts: {} },
      { status: "success", reason: "done" }
    );
    expect(result.semantics).toBe("success");
    expect(result.terminationCause).toBeUndefined();
  });

  test("exit code null with success payload is not downgraded", () => {
    const result = deriveCompletion(
      { exitCode: null, killedByTimeout: false, duration_ms: 10, agentResult: null, artifacts: {} },
      { status: "success", reason: "done" }
    );
    expect(result.semantics).toBe("success");
  });

  test("non-zero exit code with non-success payload is not affected", () => {
    const result = deriveCompletion(
      { exitCode: 1, killedByTimeout: false, duration_ms: 10, agentResult: null, artifacts: {} },
      { status: "needs_retry", reason: "failed" }
    );
    expect(result.semantics).toBe("needs_retry");
    // Should use normal path, not exitcode_mismatch
    expect(result.terminationCause).toBeUndefined();
  });
});
