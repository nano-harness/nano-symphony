import { describe, test, expect } from "bun:test";
import { calculateBackoff } from "../../src/orchestrator/backoff.ts";
describe("calculateBackoff", () => {
  test("returns value within expected range", () => { for (let i = 0; i < 10; i++) { const d = calculateBackoff(i, 1000, 60000); expect(d).toBeGreaterThanOrEqual(1000); expect(d).toBeLessThanOrEqual(61000); } });
  test("exponential growth is capped at max", () => { expect(calculateBackoff(20, 1000, 5000)).toBeLessThanOrEqual(6000); });
  test("attempt 0 returns base delay range", () => { const d = calculateBackoff(0, 1000, 60000); expect(d).toBeGreaterThanOrEqual(1000); expect(d).toBeLessThanOrEqual(2000); });
});
