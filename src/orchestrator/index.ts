import type { Tracker } from "../db/tracker.ts";
import type { Workflow } from "../workflow/types.ts";
import { runWorker, type WorkerContext } from "./worker.ts";
import { config } from "../config.ts";
import type { Logger } from "pino";

class Semaphore {
  private count: number;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.count = max;
  }

  available(): number {
    return this.count;
  }

  acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.count++;
    }
  }
}

export interface Orchestrator {
  start(): void;
  stop(): Promise<void>;
  kick(): void;
}

export function createOrchestrator(
  tracker: Tracker,
  getWorkflow: () => { workflow: Workflow; template: string } | undefined,
  logger: Logger
): Orchestrator {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sem = new Semaphore(config.MAX_CONCURRENT_AGENTS);
  const mcpUrl = `http://localhost:${config.PORT}/mcp`;

  async function tick(): Promise<number> {
    const wf = getWorkflow();
    if (!wf) return 0;

    const slots = sem.available();
    if (slots <= 0) return 0; // Already at capacity, skip this tick

    const now = Date.now();

    // Fetch retries first (highest priority)
    const retries = tracker.fetchDueRetries(now);

    // Calculate remaining slots after accounting for retries
    const remainingSlots = Math.max(0, slots - retries.length);

    // Only fetch candidates if we have remaining slots
    const candidates = remainingSlots > 0 ? tracker.getCandidates(remainingSlots) : [];

    const toDispatch = [
      ...retries.map((r) => ({ issueId: r.issue_id, attempt: r.next_attempt })),
      ...candidates
        .filter((c) => !retries.find((r) => r.issue_id === c.id))
        .map((c) => ({ issueId: c.id, attempt: 0 })),
    ];

    for (const { issueId, attempt } of toDispatch) {
      const ctx: WorkerContext = {
        tracker,
        workflow: wf,
        logger,
        mcpUrl,
      };

      void sem.acquire().then(() => {
        return runWorker(issueId, attempt, ctx).finally(() => sem.release());
      });
    }

    return toDispatch.length;
  }

  function scheduleNext(hadWork: boolean): void {
    if (!running) return;
    // Adaptive polling: 1s if we dispatched work, ORCHESTRATOR_TICK_MS if idle
    const delay = hadWork ? 1_000 : config.ORCHESTRATOR_TICK_MS;
    timer = setTimeout(() => {
      tick().then((dispatched) => {
        scheduleNext(dispatched > 0);
      }).catch((err: unknown) => {
        logger.error({ err }, "Orchestrator tick error");
        scheduleNext(false);
      });
    }, delay);
  }

  return {
    start() {
      running = true;
      logger.info("Orchestrator started");
      // Run first tick immediately instead of waiting ORCHESTRATOR_TICK_MS
      tick().then((dispatched) => {
        scheduleNext(dispatched > 0);
      }).catch((err: unknown) => {
        logger.error({ err }, "Orchestrator tick error");
        scheduleNext(false);
      });
    },
    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      logger.info("Orchestrator stopped");
    },
    kick() {
      if (!running) return;
      // Clear existing timer and run tick immediately
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      tick().then((dispatched) => {
        scheduleNext(dispatched > 0);
      }).catch((err: unknown) => {
        logger.error({ err }, "Orchestrator tick error");
        scheduleNext(false);
      });
    },
  };
}
