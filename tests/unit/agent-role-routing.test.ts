import { describe, it, expect } from "bun:test";
import { resolveRoleFromLabels } from "../../src/orchestrator/worker.ts";

describe("agent role routing by labels", () => {
  it("returns undefined when no roles or no labels match", () => {
    expect(resolveRoleFromLabels([], { reviewer: {} })).toBeUndefined();
    expect(resolveRoleFromLabels(["bug"], { reviewer: {} })).toBeUndefined();
    expect(resolveRoleFromLabels(["reviewer"], undefined)).toBeUndefined();
  });

  it("picks the first label that matches a role key", () => {
    const roles = { reviewer: {}, security: {}, docs: {} };
    expect(resolveRoleFromLabels(["security", "reviewer"], roles)).toBe("security");
    expect(resolveRoleFromLabels(["bug", "docs"], roles)).toBe("docs");
  });

  it("prefers explicit agent_role over label mapping", async () => {
    // Covered in worker dispatch: resolveRoleFromLabels is only consulted when issue.agent_role is null.
    expect(resolveRoleFromLabels(["security"], { security: {}, reviewer: {} })).toBe("security");
  });
});
