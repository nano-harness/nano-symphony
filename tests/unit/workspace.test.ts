import { describe, test, expect } from "bun:test";
import { sanitizeIdentifier, assertContained } from "../../src/workspace/manager.ts";
import path from "path";
describe("workspace manager", () => {
  test("sanitizeIdentifier replaces invalid chars", () => { expect(sanitizeIdentifier("hello/world")).toBe("hello_world"); expect(sanitizeIdentifier("task-123")).toBe("task-123"); });
  test("sanitizeIdentifier truncates long identifiers", () => { expect(sanitizeIdentifier("a".repeat(100)).length).toBe(64); });
  test("assertContained passes for valid path", () => { expect(() => assertContained("/home/user/workspaces", path.join("/home/user/workspaces", "task-1"))).not.toThrow(); });
  test("assertContained throws for path traversal", () => { expect(() => assertContained("/home/user/workspaces", "/home/user/other")).toThrow("Path traversal"); });
  test("assertContained throws for exact root traversal with ..", () => { expect(() => assertContained("/home/user/workspaces", "/home/user/workspaces/../other")).toThrow("Path traversal"); });
});
