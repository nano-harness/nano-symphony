import { describe, expect, test } from "bun:test";
import { deriveCompletion } from "../../src/orchestrator/worker.ts";
import { NANO_EXIT } from "../../src/spawner/index.ts";

describe("deriveCompletion", () => {
  test("MCP session_completed handoff overrides sentinel success", () => {
    const result = deriveCompletion(
      { payload_json: JSON.stringify({ semantics: "handoff", summary: "human review", handoff_state: "in_review" }) },
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: { status: "success" } }
    );
    expect(result).toEqual({ semantics: "handoff", summary: "human review", handoffState: "in_review" });
  });

  test("ignores malformed MCP payload and falls back to sentinel", () => {
    const result = deriveCompletion(
      { payload_json: "not-json" },
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: { status: "success" } }
    );
    expect(result).toEqual({ semantics: "success", summary: undefined });
  });

  test("prioritizes sentinel goal_state.achieved_at", () => {
    const result = deriveCompletion(
      null,
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: {
        status: "success",
        goal_state: { condition: "file exists", achieved_at: "2026-05-15T00:00:00Z", last_reason: "goal satisfied" }
      }}
    );
    expect(result).toEqual({ semantics: "success", summary: "goal satisfied" });
  });

  test("uses sentinel status=success", () => {
    const result = deriveCompletion(
      null,
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: {
        status: "success",
        goal_state: { condition: "file exists", last_reason: "task done" }
      }}
    );
    expect(result).toEqual({ semantics: "success", summary: "task done" });
  });

  test("uses sentinel status=needs_retry", () => {
    const result = deriveCompletion(
      null,
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: {
        status: "needs_retry",
        goal_state: { condition: "file exists", last_reason: "retrying" }
      }}
    );
    expect(result).toEqual({ semantics: "needs_retry", summary: "retrying" });
  });

  test("uses sentinel status=abandoned", () => {
    const result = deriveCompletion(
      null,
      { exitCode: 0, killedByTimeout: false, duration_ms: 10, sentinel: {
        status: "abandoned",
        goal_state: { condition: "file exists", last_reason: "gave up" }
      }}
    );
    expect(result).toEqual({ semantics: "abandoned", summary: "gave up" });
  });

  test("exit code RETRY without sentinel", () => {
    expect(deriveCompletion(null, { exitCode: NANO_EXIT.RETRY, killedByTimeout: false, duration_ms: 10, sentinel: null })).toEqual({
      semantics: "needs_retry",
    });
  });

  test("exit code ABANDONED without sentinel", () => {
    expect(deriveCompletion(null, { exitCode: NANO_EXIT.ABANDONED, killedByTimeout: false, duration_ms: 10, sentinel: null })).toEqual({
      semantics: "abandoned",
    });
  });

  test("exit code TIMEOUT without sentinel", () => {
    expect(deriveCompletion(null, { exitCode: NANO_EXIT.TIMEOUT, killedByTimeout: false, duration_ms: 10, sentinel: null })).toEqual({
      semantics: "needs_retry",
    });
  });

  test("exit code SUCCESS without sentinel triggers handoff", () => {
    expect(deriveCompletion(null, { exitCode: NANO_EXIT.SUCCESS, killedByTimeout: false, duration_ms: 10, sentinel: null })).toEqual({
      semantics: "handoff",
    });
  });

  test("retries timeout without sentinel", () => {
    expect(deriveCompletion(null, { exitCode: null, killedByTimeout: true, duration_ms: 10, sentinel: null })).toEqual({
      semantics: "needs_retry",
    });
  });

  test("abandons unclassified exit code without sentinel", () => {
    expect(deriveCompletion(null, { exitCode: NANO_EXIT.UNCLASSIFIED, killedByTimeout: false, duration_ms: 10, sentinel: null })).toEqual({
      semantics: "abandoned",
    });
  });
});
