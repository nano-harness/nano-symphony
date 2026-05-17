import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Sentinel prefix consistency check.
 *
 * The string literal in EXPECTED below is the value nano-agent's
 * pkg/cli/binary.go currently emits (binaryResultSentinel).
 *
 * This file deliberately encodes that value as a string literal so any
 * accidental change to src/spawner/index.ts SENTINEL_PREFIX makes this
 * test fail. To intentionally change the protocol, update BOTH this
 * test and src/spawner/index.ts in the same PR (and coordinate with
 * the nano-agent change).
 */
const EXPECTED_PREFIX = "<<<NANO_RESULT>>>";

describe("sentinel prefix", () => {
  test("spawner uses the prefix nano-agent emits", async () => {
    const src = await fs.readFile(
      path.resolve(import.meta.dir, "../../src/spawner/index.ts"),
      "utf-8",
    );
    const m = /SENTINEL_PREFIX\s*=\s*"([^"]+)"/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(EXPECTED_PREFIX);
  });

  test("mock-agent.sh emits sentinels with the same prefix", async () => {
    const src = await fs.readFile(
      path.resolve(import.meta.dir, "../../scripts/mock-agent.sh"),
      "utf-8",
    );
    // every sentinel-emitting printf line must use the canonical prefix
    const printfs = src.match(/printf '[^']*\{[^']*\}\\n'/g) ?? [];
    expect(printfs.length).toBeGreaterThan(0);
    for (const p of printfs) {
      expect(p).toContain(EXPECTED_PREFIX);
    }
  });
});
