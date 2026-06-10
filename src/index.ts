import { config } from "./config.ts";
import pino from "pino";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { runMigrations } from "./db/migrations.ts";
import { createTracker } from "./db/tracker.ts";
import { loadWorkflow, watchWorkflow } from "./workflow/loader.ts";
import { createHttpServer } from "./http/server.ts";
import { createOrchestrator } from "./orchestrator/index.ts";
import { resumeRunningPlans } from "./orchestrator/plan-tick.ts";
import { bus } from "./db/event_bus.ts";
import { getActiveProcessCount, killAllAgents } from "./spawner/index.ts";
import { setTokenTtl } from "./mcp/auth.ts";
import type { Workflow } from "./workflow/types.ts";

const logger = pino({ level: config.LOG_LEVEL });

async function main() {
  // S7: Initialize MCP token TTL from config so it's not stuck at the hard-coded 1h default.
  setTokenTtl(config.MCP_TOKEN_TTL_MS);

  // S1: Auto-generate API token if not configured so the control plane is always protected.
  // The server.ts layer also auto-generates if undefined, but doing it here lets us log the
  // value for the operator at startup.
  const apiToken = config.API_TOKEN ?? (() => {
    const generated = randomUUID();
    logger.warn(
      { token: generated },
      "API_TOKEN not set — auto-generated a random token for this session. " +
      "Set API_TOKEN env var to use a stable token across restarts."
    );
    return generated;
  })();

  const db = new Database(config.DB_PATH, { create: true });
  runMigrations(db);

  // Recover runs stuck in 'claimed' from unclean shutdown
  const staleRecovery = db.prepare(
    `UPDATE symphony_runs SET last_state = 'released' WHERE last_state = 'claimed'`
  ).run();
  if (staleRecovery.changes > 0) {
    logger.warn({ count: staleRecovery.changes }, "Recovered stale claimed runs from unclean shutdown");
  }

  // S9: Kill any agent processes that were live before an unclean shutdown.
  // We stored PIDs in symphony_runs.agent_pid; verify each is still running and looks
  // like a child process before sending SIGKILL, then clear the stored PIDs.
  const stalePidRows = db.prepare(
    `SELECT issue_uuid, agent_pid FROM symphony_runs WHERE agent_pid IS NOT NULL`
  ).all() as Array<{ issue_uuid: string; agent_pid: number }>;
  for (const { issue_uuid: issueUuid, agent_pid: pid } of stalePidRows) {
    try {
      // SIGKILL best-effort; if already dead the error is swallowed.
      process.kill(pid, "SIGKILL");
      logger.warn({ issueUuid, pid }, "Killed orphaned agent process from previous run");
    } catch { /* already dead */ }
  }
  if (stalePidRows.length > 0) {
    db.prepare(`UPDATE symphony_runs SET agent_pid = NULL WHERE agent_pid IS NOT NULL`).run();
  }

  const tracker = createTracker(db);
  let currentWorkflow: { workflow: Workflow; template: string } | undefined;
  try { currentWorkflow = loadWorkflow(config.WORKFLOW_PATH); } catch (err) { logger.warn({ err }, "Could not load workflow"); }
  watchWorkflow(config.WORKFLOW_PATH, (workflow, template) => {
    currentWorkflow = { workflow, template };
    bus.emit("event", { kind: "workflow_reloaded", ts: Date.now(), issue_uuid: null, message: "workflow reloaded via watcher", payload_json: null });
  }, logger);
  const getWorkflow = () => currentWorkflow;
  const reloadWorkflow = (): { workflow: Workflow; template: string } | null => {
    try {
      const loaded = loadWorkflow(config.WORKFLOW_PATH);
      currentWorkflow = loaded;
      logger.info("workflow reloaded via API");
      return loaded;
    } catch (err) {
      logger.error({ err }, "workflow reload failed via API");
      return null;
    }
  };
  const orchestrator = createOrchestrator(tracker, getWorkflow, logger);

  // Resume any plan runs that were in-flight before a crash restart.
  // Must happen before orchestrator.start() so the resumed runs are
  // eligible for orchestrator ticks immediately.
  await resumeRunningPlans(tracker, logger);

  const app = createHttpServer(tracker, getWorkflow, () => orchestrator.kick(), { reloadWorkflow, apiToken });
  const server = Bun.serve({
    port: config.PORT,
    hostname: config.HOST,
    fetch: app.fetch,
    idleTimeout: 0,
  });
  logger.info({ port: config.PORT, host: config.HOST }, "HTTP server listening");
  maybeOpenBrowser(`http://localhost:${config.PORT}`, logger);
  orchestrator.start();
  const shutdown = async () => {
    await orchestrator.stop();
    // Wait for inflight agents to finish (max 30s)
    const deadline = Date.now() + 30_000;
    while (getActiveProcessCount() > 0 && Date.now() < deadline) {
      await Bun.sleep(500);
    }
    if (getActiveProcessCount() > 0) {
      logger.warn({ remaining: getActiveProcessCount() }, "Force-killing remaining agents");
      killAllAgents();
      await Bun.sleep(1000);
    }
    server.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function maybeOpenBrowser(url: string, log: pino.Logger) {
  if (process.env.SYMPHONY_OPEN === "0" || process.env.NO_BROWSER) return;
  const cmd =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    log.info({ url }, "Opened dashboard in browser");
  } catch (err) {
    log.warn({ err, url }, "Could not auto-open browser");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
