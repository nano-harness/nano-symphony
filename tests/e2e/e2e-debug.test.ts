import { describe, test, expect } from "bun:test";
import { runE2e } from "./e2e-utils.ts";

describe("e2e debug", () => {
  test(
    "success semantics completes",
    async () => {
      const res = await runE2e({ mockSemantics: "success" });
      expect(res.run.last_state).toBe("released");
      expect(res.events.some((e) => e.kind === "session_completed")).toBe(true);
      expect(res.events.some((e) => e.kind === "completed")).toBe(true);
    },
    30_000
  );

  test(
    "handoff semantics transitions to in_review",
    async () => {
      const res = await runE2e({ mockSemantics: "handoff" });
      expect(res.run.last_state).toBe("in_review");
      expect(res.events.some((e) => e.kind === "handoff")).toBe(true);
    },
    30_000
  );

  test(
    "abandoned semantics transitions to released",
    async () => {
      const res = await runE2e({ mockSemantics: "abandoned" });
      expect(res.run.last_state).toBe("released");
      expect(res.events.some((e) => e.kind === "abandoned")).toBe(true);
    },
    30_000
  );

  test(
    "skip session_completed with clean exit triggers abandoned path",
    async () => {
      const res = await runE2e({ mockSkipComplete: true, timeoutSec: 15 });
      expect(res.run.last_state).toBe("released");
      expect(res.events.some((e) => e.kind === "session_completed")).toBe(false);
      // Without stdout result or session_completed, agent is abandoned
      expect(res.events.some((e) => e.kind === "abandoned")).toBe(true);
    },
    30_000
  );

  test(
    "bad-token call does not break run",
    async () => {
      const res = await runE2e({ mockSemantics: "success", mockFailFetch: true });
      expect(res.run.last_state).toBe("released");
    },
    30_000
  );
});
