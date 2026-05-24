import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { watchWorkflow } from "../../src/workflow/loader.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watchWorkflow", () => {
  const PRIOR_POLL = process.env.SYMPHONY_WATCH_USE_POLLING;
  beforeAll(() => { process.env.SYMPHONY_WATCH_USE_POLLING = "1"; });
  afterAll(() => {
    if (PRIOR_POLL == null) delete process.env.SYMPHONY_WATCH_USE_POLLING;
    else process.env.SYMPHONY_WATCH_USE_POLLING = PRIOR_POLL;
  });

  test("reloads on file change", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-watch-"));
    const file = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(file, "---\ntracker:\n  type: local\n---\nv1");

    const reloads: string[] = [];
    const watcher = watchWorkflow(file, (_wf, template) => reloads.push(template));

    await sleep(300);                       // let watcher attach
    await fs.writeFile(file, "---\ntracker:\n  type: local\n---\nv2");
    await sleep(1500);                      // awaitWriteFinish stability + polling + reload

    await watcher.close();
    await fs.rm(dir, { recursive: true, force: true });
    expect(reloads.some((t) => t.includes("v2"))).toBe(true);
  });

  test("logs (does not swallow) parse / schema errors", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-watch-err-"));
    const file = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(file, "---\ntracker:\n  type: local\n---\nok");

    const errors: unknown[] = [];
    const logger = {
      info: () => {},
      error: (...args: unknown[]) => errors.push(args),
    } as any;
    const watcher = watchWorkflow(file, () => {}, logger);

    await sleep(300);
    // Write something that will fail WorkflowSchema validation
    // (all top-level fields are optional, so we need an invalid nested value)
    await fs.writeFile(file, "---\npolling:\n  interval_ms: not_a_number\n---\nbad");
    await sleep(1500);

    await watcher.close();
    await fs.rm(dir, { recursive: true, force: true });
    expect(errors.length).toBeGreaterThan(0);
  });
});
