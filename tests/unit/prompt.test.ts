import { describe, test, expect } from "bun:test";
import { renderPrompt } from "../../src/prompt/renderer.ts";
describe("renderPrompt", () => {
  test("renders simple variables", async () => { const r = await renderPrompt("Hello {{ name }}!", { name: "World" }); expect(r.text).toBe("Hello World!"); });
  test("renders nested object properties", async () => { const r = await renderPrompt("Issue: {{ issue.title }}", { issue: { title: "Fix the bug" } }); expect(r.text).toBe("Issue: Fix the bug"); });
  test("renders attempt number", async () => { const r = await renderPrompt("Attempt: {{ attempt }}", { attempt: 2 }); expect(r.text).toBe("Attempt: 2"); });
  test("prefixes goal command when requested", async () => {
    const r = await renderPrompt("Do work", {}, { goal: { condition: "tests pass", inject_mode: "prefix" } }); expect(r.text).toBe("/goal tests pass\n\nDo work");
  });
  test("does not prefix goal command when inject mode is none", async () => {
    const r = await renderPrompt("Do work", {}, { goal: { condition: "tests pass", inject_mode: "none" } }); expect(r.text).toBe("Do work");
  });
  test("throws on undefined variable in strict mode", async () => { await expect(renderPrompt("{{ undefined_var }}", {})).rejects.toThrow(); });
  test("returns empty commentIds meta by default", async () => {
    const r = await renderPrompt("Hello", { });
    expect(r.meta.commentIds).toEqual([]);
    expect(r.meta.truncated).toBe(false);
  });
});
