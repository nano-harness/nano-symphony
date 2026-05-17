import { config } from "./config.ts";
import pino from "pino";
import { Database } from "bun:sqlite";
import { runMigrations } from "./db/migrations.ts";
import { createTracker } from "./db/tracker.ts";
import { loadWorkflow, watchWorkflow } from "./workflow/loader.ts";
import { createHttpServer } from "./http/server.ts";
import { createOrchestrator } from "./orchestrator/index.ts";
import type { Workflow } from "./workflow/types.ts";

const logger = pino({ level: config.LOG_LEVEL });

async function main() {
  const db = new Database(config.DB_PATH, { create: true });
  runMigrations(db);
  const tracker = createTracker(db);
  let currentWorkflow: { workflow: Workflow; template: string } | undefined;
  try { currentWorkflow = loadWorkflow(config.WORKFLOW_PATH); } catch (err) { logger.warn({ err }, "Could not load workflow"); }
  watchWorkflow(config.WORKFLOW_PATH, (workflow, template) => { currentWorkflow = { workflow, template }; }, logger);
  const getWorkflow = () => currentWorkflow;
  const orchestrator = createOrchestrator(tracker, getWorkflow, logger);
  const app = createHttpServer(tracker, getWorkflow, () => orchestrator.kick());
  const server = Bun.serve({ port: config.PORT, fetch: app.fetch });
  logger.info({ port: config.PORT }, "HTTP server listening");
  orchestrator.start();
  const shutdown = async () => { await orchestrator.stop(); server.stop(); db.close(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });
