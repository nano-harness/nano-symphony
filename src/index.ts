import { config } from "./config.ts";
import pino from "pino";
import { Database } from "bun:sqlite";
import { runMigrations } from "./db/migrations.ts";
import { createTracker } from "./db/tracker.ts";
import { loadWorkflow, watchWorkflow } from "./workflow/loader.ts";
import { createHttpServer } from "./http/server.ts";
import { createOrchestrator } from "./orchestrator/index.ts";
import { bus } from "./db/event_bus.ts";
import type { Workflow } from "./workflow/types.ts";

const logger = pino({ level: config.LOG_LEVEL });

async function main() {
  const db = new Database(config.DB_PATH, { create: true });
  runMigrations(db);
  const tracker = createTracker(db);
  let currentWorkflow: { workflow: Workflow; template: string } | undefined;
  try { currentWorkflow = loadWorkflow(config.WORKFLOW_PATH); } catch (err) { logger.warn({ err }, "Could not load workflow"); }
  watchWorkflow(config.WORKFLOW_PATH, (workflow, template) => {
    currentWorkflow = { workflow, template };
    bus.emit("event", { kind: "workflow_reloaded", ts: Date.now(), issue_id: null, message: "workflow reloaded via watcher", payload_json: null });
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
  const app = createHttpServer(tracker, getWorkflow, () => orchestrator.kick(), { reloadWorkflow });
  const server = Bun.serve({
    port: config.PORT,
    fetch: app.fetch,
    idleTimeout: 0,
  });
  logger.info({ port: config.PORT }, "HTTP server listening");
  maybeOpenBrowser(`http://localhost:${config.PORT}`, logger);
  orchestrator.start();
  const shutdown = async () => { await orchestrator.stop(); server.stop(); db.close(); process.exit(0); };
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
