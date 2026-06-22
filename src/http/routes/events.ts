import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Tracker, SymphonyEvent } from "../../db/tracker.ts";
import type { Workflow } from "../../workflow/types.ts";
import type { RunPatch } from "../../db/event_bus.ts";
import { bus } from "../../db/event_bus.ts";
import { MAX_SSE_CONNECTIONS } from "./schemas.ts";

let activeSSECount = 0;

export function createEventsRoutes(
  tracker: Tracker,
  _getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  _triggerTick: () => void,
  _options?: Record<string, unknown>,
): Hono {
  const app = new Hono();

  app.get("/events", (c) => {
    const since = c.req.query("since");
    return c.json(tracker.getEvents(since ? Number(since) : undefined));
  });

  app.get("/events/stream", (c) => {
    if (activeSSECount >= MAX_SSE_CONNECTIONS) {
      return c.json({ error: "Too many SSE connections" }, 503);
    }
    // Increment before entering streamSSE so the check above is consistent.
    activeSSECount++;
    return streamSSE(c, async (stream) => {
      // Support Last-Event-ID for reconnection catch-up
      const lastEventId = c.req.header("Last-Event-ID");
      const querySince = c.req.query("since");
      const since = lastEventId ? Number(lastEventId) : (querySince ? Number(querySince) : undefined);

      // Catch up with historical events if since is provided
      if (since !== undefined) {
        const events = tracker.getEvents(since);
        for (const ev of events) {
          await stream.writeSSE({ data: JSON.stringify(ev), id: String(ev.ts), event: "message" });
        }
      }

      let lastWriteTs = Date.now();
      let cleanedUp = false;

      // Listen to bus events
      const onEvent = async (event: SymphonyEvent) => {
        try {
          await stream.writeSSE({ data: JSON.stringify(event), id: String(event.ts), event: "message" });
          lastWriteTs = Date.now();
        } catch (e) {
          // Stream closed, cleanup will happen in abort handler
        }
      };

      const onRun = async (patch: RunPatch) => {
        try {
          await stream.writeSSE({ data: JSON.stringify(patch), event: "run" });
          lastWriteTs = Date.now();
        } catch (e) {
          // Stream closed
        }
      };

      bus.on("event", onEvent);
      bus.on("run", onRun);

      // Heartbeat interval
      const heartbeatInterval = setInterval(async () => {
        if (Date.now() - lastWriteTs > 10_000) {
          try {
            await stream.writeSSE({ data: "", event: "ping" });
            lastWriteTs = Date.now();
          } catch (e) {
            // Stream closed
          }
        }
      }, 10_000);

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        activeSSECount--;
        bus.off("event", onEvent);
        bus.off("run", onRun);
        clearInterval(heartbeatInterval);
      };

      // Cleanup on abort or when the stream callback exits (e.g. streamSSE error).
      c.req.raw.signal.addEventListener("abort", cleanup);

      try {
        // Keep stream alive indefinitely
        await new Promise(() => {});
      } finally {
        cleanup();
      }
    });
  });

  return app;
}
