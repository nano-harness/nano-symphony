import { describe, test, expect } from "bun:test";
import { renderPrompt } from "../../src/prompt/renderer.ts";
describe("renderPrompt", () => {
  test("renders simple variables", async () => { expect(await renderPrompt("Hello {{ name }}!", { name: "World" })).toBe("Hello World!"); });
  test("renders nested object properties", async () => { expect(await renderPrompt("Issue: {{ issue.title }}", { issue: { title: "Fix the bug" } })).toBe("Issue: Fix the bug"); });
  test("renders attempt number", async () => { expect(await renderPrompt("Attempt: {{ attempt }}", { attempt: 2 })).toBe("Attempt: 2"); });
  test("prefixes goal command when requested", async () => {
    expect(await renderPrompt("Do work", {}, { goal: { condition: "tests pass", inject_mode: "prefix" } })).toBe("/goal tests pass\n\nDo work");
  });
  test("does not prefix goal command when inject mode is none", async () => {
    expect(await renderPrompt("Do work", {}, { goal: { condition: "tests pass", inject_mode: "none" } })).toBe("Do work");
  });
  test("throws on undefined variable in strict mode", async () => { await expect(renderPrompt("{{ undefined_var }}", {})).rejects.toThrow(); });
});
