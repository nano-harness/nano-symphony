import { describe, expect, test } from "bun:test";
import { claudeCodeAdapter } from "../../src/spawner/adapters/claude-code.ts";

describe("claude-code adapter parseStreamingLine", () => {
  test("parses tool_use event", () => {
    const line = JSON.stringify({ type: "tool_use", name: "symphony.fetch_issue", input: { uuid: "abc" } });
    const ev = claudeCodeAdapter.parseStreamingLine?.(line);
    expect(ev).toEqual({
      kind: "tool_call",
      message: "Tool: symphony.fetch_issue",
      payload: { tool: "symphony.fetch_issue", input: { uuid: "abc" } },
    });
  });

  test("parses tool_result event", () => {
    const line = JSON.stringify({
      type: "tool_result",
      name: "symphony.fetch_issue",
      output: { title: "Fix bug" },
      is_error: false,
    });
    const ev = claudeCodeAdapter.parseStreamingLine?.(line);
    expect(ev).toEqual({
      kind: "tool_result",
      message: "Tool result: symphony.fetch_issue",
      payload: { tool: "symphony.fetch_issue", output: { title: "Fix bug" }, is_error: false },
    });
  });

  test("parses tool_result error", () => {
    const line = JSON.stringify({
      type: "tool_result",
      name: "Bash",
      output: "permission denied",
      is_error: true,
    });
    const ev = claudeCodeAdapter.parseStreamingLine?.(line);
    expect(ev?.kind).toBe("tool_result");
    expect(ev?.message).toContain("error");
    expect((ev?.payload as Record<string, unknown>).is_error).toBe(true);
  });

  test("tool_result falls back to result field when output missing", () => {
    const line = JSON.stringify({
      type: "tool_result",
      name: "Read",
      result: "file content",
    });
    const ev = claudeCodeAdapter.parseStreamingLine?.(line);
    expect((ev?.payload as Record<string, unknown>).output).toBe("file content");
  });

  test("returns null for unknown type", () => {
    const line = JSON.stringify({ type: "heartbeat" });
    const ev = claudeCodeAdapter.parseStreamingLine?.(line);
    expect(ev).toBeNull();
  });
});
