import { describe, expect, test } from "bun:test";
import { deriveCompletion } from "../../src/orchestrator/worker.ts";
import { NANO_EXIT } from "../../src/spawner/index.ts";

describe("deriveCompletion", () => {
  test("MCP session_completed handoff overrides sentinel success", () => {
    const result = deriveCompletion(
      { payload_json: JSON.stringify({ semantics: "handoff", summary: "human review", handoff_state: "in_review" }) },
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: { status: "success" } }
    );
    expect(result.semantics).toBe("handoff");
    expect(result.summary).toBe("human review");
    expect(result.handoffState).toBe("in_review");
  });

  test("MCP blocker_fingerprint and termination_cause are passed through", () => {
    const result = deriveCompletion(
      { payload_json: JSON.stringify({
        semantics: "abandoned",
        summary: "Cannot proceed",
        blocker_fingerprint: "sandbox_denied:/etc/passwd",
        termination_cause: "crash"
      }) },
      null
    );
    expect(result.semantics).toBe("abandoned");
    expect(result.blockerFingerprint).toBe("sandbox_denied:/etc/passwd");
    expect(result.terminationCause).toBe("crash");
  });

  test("ignores malformed MCP payload and falls back to sentinel", () => {
    const result = deriveCompletion(
      { payload_json: "not-json" },
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: { status: "success" } }
    );
    expect(result.semantics).toBe("success");
    expect(result.summary).toBeUndefined();
  });

  test("sentinel blocker_fingerprint flows through deriveCompletion", () => {
    const result = deriveCompletion(
      null,
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: {
        status: "abandoned",
        blocker_fingerprint: "sandbox_denied:/x",
        termination_cause: "crash"
      }}
    );
    expect(result.semantics).toBe("abandoned");
    expect(result.blockerFingerprint).toBe("sandbox_denied:/x");
    expect(result.terminationCause).toBe("crash");
  });

  test("legacy sentinel falls back to normalizeBlockerString", () => {
    const result = deriveCompletion(
      null,
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: {
        status: "needs_retry",
        goal_state: { condition: "file exists", last_reason: "Process 12345 exited at 2026-05-21T10:00:00Z" }
      }}
    );
    expect(result.semantics).toBe("needs_retry");
    // Normalized: timestamps and PIDs removed
    expect(result.blockerFingerprint).toContain("Process");
    expect(result.blockerFingerprint).not.toContain("12345");
    expect(result.blockerFingerprint).not.toContain("2026-05-21");
  });

  test("prioritizes sentinel goal_state.achieved_at", () => {
    const result = deriveCompletion(
      null,
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: {
        status: "success",
        goal_state: { condition: "file exists", achieved_at: "2026-05-15T00:00:00Z", last_reason: "goal satisfied" }
      }}
    );
    expect(result.semantics).toBe("success");
    expect(result.summary).toBe("goal satisfied");
    expect(result.blockerFingerprint).toBeUndefined();
  });

  test("uses sentinel status=success", () => {
    const result = deriveCompletion(
      null,
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: {
        status: "success",
        goal_state: { condition: "file exists", last_reason: "task done" }
      }}
    );
    expect(result.semantics).toBe("success");
    expect(result.summary).toBe("task done");
  });

  test("uses sentinel status=needs_retry", () => {
    const result = deriveCompletion(
      null,
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: {
        status: "needs_retry",
        goal_state: { condition: "file exists", last_reason: "retrying" }
      }}
    );
    expect(result.semantics).toBe("needs_retry");
    expect(result.summary).toBe("retrying");
  });

  test("uses sentinel status=abandoned", () => {
    const result = deriveCompletion(
      null,
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: {
        status: "abandoned",
        goal_state: { condition: "file exists", last_reason: "gave up" }
      }}
    );
    expect(result.semantics).toBe("abandoned");
    expect(result.summary).toBe("gave up");
  });

  test("exit code RETRY without sentinel", () => {
    const result = deriveCompletion(null, { exitCode: NANO_EXIT.RETRY, killedByTimeout: false, duration_ms: 10, sentinel: null });
    expect(result.semantics).toBe("needs_retry");
    expect(result.blockerFingerprint).toBe("exit_10");
    expect(result.terminationCause).toBe("exit_only");
  });

  test("exit code ABANDONED without sentinel", () => {
    const result = deriveCompletion(null, { exitCode: NANO_EXIT.ABANDONED, killedByTimeout: false, duration_ms: 10, sentinel: null });
    expect(result.semantics).toBe("abandoned");
    expect(result.blockerFingerprint).toBe("exit_20");
  });

  test("exit code TIMEOUT without sentinel", () => {
    const result = deriveCompletion(null, { exitCode: NANO_EXIT.TIMEOUT, killedByTimeout: false, duration_ms: 10, sentinel: null });
    expect(result.semantics).toBe("needs_retry");
    expect(result.blockerFingerprint).toBe("exit_30");
  });

  test("exit code SUCCESS without sentinel triggers handoff", () => {
    const result = deriveCompletion(null, { exitCode: NANO_EXIT.SUCCESS, killedByTimeout: false, duration_ms: 10, sentinel: null });
    expect(result.semantics).toBe("handoff");
  });

  test("retries timeout without sentinel", () => {
    const result = deriveCompletion(null, { exitCode: null, killedByTimeout: true, duration_ms: 10, sentinel: null });
    expect(result.semantics).toBe("needs_retry");
    expect(result.blockerFingerprint).toBe("killed_by_timeout");
  });

  test("agent silent termination synthesizes fields", () => {
    const result = deriveCompletion(null, { exitCode: NANO_EXIT.UNCLASSIFIED, killedByTimeout: false, duration_ms: 10, sentinel: null });
    expect(result.semantics).toBe("abandoned");
    expect(result.summary).toBe("Agent exited without explicit completion signal");
    expect(result.blockerFingerprint).toBe("agent_terminated_silently");
    expect(result.terminationCause).toBe("no_signal");
  });
});
