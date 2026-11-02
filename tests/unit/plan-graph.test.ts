import { describe, test, expect } from "bun:test";
import { computePlanGraph } from "../../src/http/plan-graph.ts";

describe("plan graph", () => {
  test("returns empty graph for no steps", () => {
    const g = computePlanGraph([]);
    expect(g.ok).toBe(true);
    expect(g.nodes).toHaveLength(0);
    expect(g.layers).toHaveLength(0);
  });

  test("computes layers for linear dependencies", () => {
    const g = computePlanGraph([
      { id: "a", title: "A" },
      { id: "b", title: "B", after: ["a"] },
      { id: "c", title: "C", after: ["b"] },
    ]);
    expect(g.ok).toBe(true);
    expect(g.layers).toEqual([["a"], ["b"], ["c"]]);
    expect(g.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  test("computes layers for parallel dependencies", () => {
    const g = computePlanGraph([
      { id: "a", title: "A" },
      { id: "b", title: "B", after: ["a"] },
      { id: "c", title: "C", after: ["a"] },
      { id: "d", title: "D", after: ["b", "c"] },
    ]);
    expect(g.ok).toBe(true);
    expect(g.layers).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  test("detects cycles", () => {
    const g = computePlanGraph([
      { id: "a", title: "A", after: ["b"] },
      { id: "b", title: "B", after: ["a"] },
    ]);
    expect(g.ok).toBe(false);
    expect(g.error).toContain("Cycle");
  });

  test("detects unknown dependencies", () => {
    const g = computePlanGraph([{ id: "a", title: "A", after: ["missing"] }]);
    expect(g.ok).toBe(false);
    expect(g.error).toContain("Unknown dependency");
  });

  test("detects duplicate ids", () => {
    const g = computePlanGraph([
      { id: "a", title: "A" },
      { id: "a", title: "B" },
    ]);
    expect(g.ok).toBe(false);
    expect(g.error).toContain("Duplicate");
  });
});
