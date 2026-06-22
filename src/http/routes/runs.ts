import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "fs/promises";
import { watch } from "fs";
import path from "path";
import type { Tracker } from "../../db/tracker.ts";
import type { Workflow } from "../../workflow/types.ts";
import { cancelAgent } from "../../spawner/index.ts";

export function createRunsRoutes(
  tracker: Tracker,
  _getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  _triggerTick: () => void,
  _options?: Record<string, unknown>,
): Hono {
  const app = new Hono();

  app.get("/runs", (c) => c.json(tracker.getActiveRuns()));

  app.get("/runs/:issueUuid", (c) => {
    const run = tracker.getRun(c.req.param("issueUuid"));
    if (!run) return c.json({ error: "Not found" }, 404);
    return c.json(run);
  });

  app.post("/runs/:issueUuid/cancel", (c) => {
    const issueUuid = c.req.param("issueUuid");
    cancelAgent(issueUuid); // Kill the process first (no-op if not running)
    tracker.releaseIssue(issueUuid, "cancelled");
    return c.json({ ok: true });
  });

  app.post("/runs/:issueUuid/pause", (c) => {
    tracker.releaseIssue(c.req.param("issueUuid"), "paused");
    return c.json({ ok: true });
  });

  app.post("/runs/:issueUuid/resume", (c) => {
    tracker.releaseIssue(c.req.param("issueUuid"), "released");
    return c.json({ ok: true });
  });

  app.get("/logs/:issueUuid/:attempt", (c) => {
    const { issueUuid, attempt: attemptParam } = c.req.param();
    return streamSSE(c, async (stream) => {
      const issue = tracker.getIssue(issueUuid);
      if (!issue) {
        await stream.writeSSE({ data: "Issue not found", event: "error" });
        return;
      }

      const run = tracker.getRun(issueUuid);
      const wsPath = run?.workspace_path;
      if (!wsPath) {
        await stream.writeSSE({ data: "No workspace found", event: "error" });
        return;
      }

      // Support "current" as attempt parameter
      let attempt = attemptParam;
      if (attempt === "current" && run?.current_attempt !== null && run?.current_attempt !== undefined) {
        attempt = String(run.current_attempt);
      }

      const logPath = path.join(wsPath, "logs", `attempt-${attempt}.log`);
      let offset = 0;
      let lastWriteTs = Date.now();
      let watcher: ReturnType<typeof watch> | null = null;

      const TERMINAL_STATES = new Set(["released", "cancelled", "done", "abandoned"]);

      // Helper to check if run is in terminal state
      const isTerminal = () => {
        const currentRun = tracker.getRun(issueUuid);
        return currentRun && TERMINAL_STATES.has(currentRun.last_state);
      };

      // Helper to read and send incremental log content
      const readAndSend = async () => {
        try {
          const content = await fs.readFile(logPath, "utf-8");
          if (content.length > offset) {
            await stream.writeSSE({ data: content.slice(offset), event: "log" });
            offset = content.length;
            lastWriteTs = Date.now();
            return true;
          }
        } catch {
          // File not ready yet
        }
        return false;
      };

      // Setup fs.watch on the logs directory
      try {
        const logsDir = path.dirname(logPath);
        watcher = watch(logsDir, async (eventType, filename) => {
          if (filename === path.basename(logPath)) {
            await readAndSend();
          }
        });
      } catch {
        // fs.watch not available, will use polling
      }

      // Polling loop
      const pollInterval = setInterval(async () => {
        await readAndSend();

        // Send heartbeat if no activity
        if (Date.now() - lastWriteTs > 5_000) {
          try {
            await stream.writeSSE({ data: "", event: "ping" });
            lastWriteTs = Date.now();
          } catch (e) {
            // Stream closed
          }
        }

        // Check for terminal state
        if (isTerminal()) {
          // Wait 1 second for final writes, then send end event
          setTimeout(async () => {
            const hadNewContent = await readAndSend();
            try {
              await stream.writeSSE({ data: "", event: "end" });
            } catch {
              // Stream already closed
            }
            clearInterval(pollInterval);
            if (watcher) watcher.close();
          }, 1000);
        }
      }, 200);

      // Cleanup on abort
      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(pollInterval);
        if (watcher) watcher.close();
      });

      // Initial read
      await readAndSend();

      // Keep stream alive until terminal state or client disconnect
      await new Promise(() => {});
    });
  });

  return app;
}
