import { describe, it, expect } from "bun:test";
import { resolveAgent, AGENT_KIND_BINARY_DEFAULTS } from "../../src/agent-resolution.ts";

describe("resolveAgent", () => {
  it("falls back to defaults when no override", () => {
    const result = resolveAgent(null, { kind: "nano", binary: "/custom/nano" });
    expect(result.kind).toBe("nano");
    expect(result.binary).toBe("/custom/nano");
    expect(result.timeoutMs).toBe(3_600_000);
    expect(result.maxRetries).toBe(3);
  });

  it("override kind uses default binary when no override binary", () => {
    const result = resolveAgent({ kind: "claude-code" }, { kind: "nano", binary: "/custom/nano" });
    expect(result.kind).toBe("claude-code");
    expect(result.binary).toBe("claude");
  });

  it("override binary is respected", () => {
    const result = resolveAgent({ kind: "nano", binary: "/usr/bin/nano" }, { kind: "claude-code" });
    expect(result.kind).toBe("nano");
    expect(result.binary).toBe("/usr/bin/nano");
  });

  it("defaults binary is used when override has no kind", () => {
    const result = resolveAgent({ binary: "/custom/nano" }, { kind: "claude-code" });
    expect(result.kind).toBe("claude-code");
    expect(result.binary).toBe("/custom/nano");
  });

  it("uses AGENT_KIND_BINARY_DEFAULTS when no binary in either layer", () => {
    const result = resolveAgent({ kind: "nano" }, {});
    expect(result.binary).toBe("nano");
  });

  it("falls back to claude when kind is claude-code and no binary", () => {
    const result = resolveAgent(null, { kind: "claude-code" });
    expect(result.binary).toBe("claude");
  });

  it("uses default timeout and maxRetries from defaults", () => {
    const result = resolveAgent(null, { timeoutMs: 60_000, maxRetries: 5 });
    expect(result.timeoutMs).toBe(60_000);
    expect(result.maxRetries).toBe(5);
  });

  it("uses global defaults when nothing provided", () => {
    const result = resolveAgent(null, {});
    expect(result.kind).toBe("claude-code");
    expect(result.binary).toBe("claude");
    expect(result.timeoutMs).toBe(3_600_000);
    expect(result.maxRetries).toBe(3);
  });

  it("override with undefined kind still uses defaults kind", () => {
    const result = resolveAgent({ binary: "/custom/binary" }, { kind: "nano" });
    expect(result.kind).toBe("nano");
    expect(result.binary).toBe("/custom/binary");
  });

  it("role profile overrides defaults but not issue overrides", () => {
    const result = resolveAgent(
      { kind: "nano" },
      { kind: "claude-code", timeoutMs: 60_000, maxRetries: 5 },
      { kind: "claude-code", binary: "/role/claude", timeoutMs: 120_000, maxRetries: 1 },
    );
    expect(result.kind).toBe("nano");
    expect(result.binary).toBe("nano");
    expect(result.timeoutMs).toBe(120_000);
    expect(result.maxRetries).toBe(1);
  });

  it("role profile is used when no issue override", () => {
    const result = resolveAgent(
      null,
      { kind: "claude-code" },
      { kind: "nano", timeoutMs: 120_000 },
    );
    expect(result.kind).toBe("nano");
    expect(result.binary).toBe("nano");
    expect(result.timeoutMs).toBe(120_000);
  });
});

describe("AGENT_KIND_BINARY_DEFAULTS", () => {
  it("has defaults for both kinds", () => {
    expect(AGENT_KIND_BINARY_DEFAULTS["nano"]).toBe("nano");
    expect(AGENT_KIND_BINARY_DEFAULTS["claude-code"]).toBe("claude");
  });
});
