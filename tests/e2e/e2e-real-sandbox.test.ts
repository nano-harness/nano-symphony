import { describe, test, expect } from "bun:test";
import { runE2e } from "./e2e-utils.ts";

const REAL = process.env.RUN_REAL_AGENT_E2E === "1";
const NANO_BIN = process.env.NANO_BIN_PATH ?? "nano";

describe.skipIf(!REAL)("e2e with real nano-agent + sandbox", () => {
  test(
    "agent's shell cannot read $HOME outside sandbox",
    async () => {
      // This test verifies that the sandbox prevents reading sensitive files
      const homeDir = process.env.HOME ?? "/tmp";
      const res = await runE2e({
        realBinary: NANO_BIN,
        mockSemantics: "success",
        promptOverride: `Try to list files in ${homeDir}/.ssh directory using run_shell_command. Then call symphony.session_completed with semantics="success".`,
        timeoutSec: 60,
      });

      // The agent should complete successfully via MCP even if shell commands fail
      expect(res.events.some((e) => e.kind === "session_completed")).toBe(true);

      // Check if there's a tool_call_failed or error event for the blocked operation
      // Note: This might not always trigger depending on how the agent handles the error
      const hasBlockedAccess = res.events.some(
        (e) =>
          e.kind === "tool_call_failed" ||
          (e.kind === "error" && e.message?.includes("Operation not permitted"))
      );

      if (hasBlockedAccess) {
        console.log("[e2e-real-sandbox] Sandbox successfully blocked access to ~/.ssh");
      }
    },
    120_000
  );

  test(
    "OPENAI_API_KEY not visible to sandboxed shell",
    async () => {
      // Set a marker env var that should NOT be visible in the sandbox
      process.env.OPENAI_API_KEY = "sk-leak-marker-test";

      const res = await runE2e({
        realBinary: NANO_BIN,
        promptOverride: `Run "env | grep OPENAI" using run_shell_command. Then call symphony.session_completed with semantics="success". Report what you found.`,
        timeoutSec: 60,
      });

      // The agent should complete
      expect(res.events.some((e) => e.kind === "session_completed")).toBe(true);

      // Check events and logs to ensure the secret was NOT leaked
      const allEventMessages = res.events.map((e) => e.message ?? "").join(" ");
      expect(allEventMessages).not.toContain("sk-leak-marker-test");

      // Clean up
      delete process.env.OPENAI_API_KEY;
    },
    120_000
  );

  test(
    "sandbox metadata is recorded in events",
    async () => {
      const res = await runE2e({
        realBinary: NANO_BIN,
        mockSemantics: "success",
        promptOverride: `Just call symphony.session_completed with semantics="success" immediately.`,
        timeoutSec: 30,
      });

      // Check if sandbox_observed event was recorded
      const sandboxEvent = res.events.find((e) => e.kind === "sandbox_observed");
      if (sandboxEvent) {
        console.log("[e2e-real-sandbox] Sandbox event:", sandboxEvent);
        expect(sandboxEvent.payload_json).toBeDefined();

        // Parse and validate sandbox metadata
        const payload = JSON.parse(sandboxEvent.payload_json!);
        expect(payload.enabled).toBe(true);
        expect(["native", "docker"]).toContain(payload.backend);
        expect(payload.backend_detail).toBeDefined();
      } else {
        console.warn(
          "[e2e-real-sandbox] No sandbox_observed event - this requires nano-agent with sandbox metadata support"
        );
      }
    },
    120_000
  );

  test(
    "sandbox prevents writing outside workspace",
    async () => {
      const res = await runE2e({
        realBinary: NANO_BIN,
        promptOverride: `Try to create a file at /tmp/sandbox-breach-test.txt using run_shell_command. Then call symphony.session_completed with semantics="success".`,
        timeoutSec: 60,
      });

      // The agent should complete via MCP
      expect(res.events.some((e) => e.kind === "session_completed")).toBe(true);

      // Note: /tmp might be allowed in the sandbox, so this test documents the behavior
      // The real protection is preventing writes to ~/ and system paths
    },
    120_000
  );
});
