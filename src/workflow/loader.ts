import matter from "gray-matter";
import { readFileSync } from "fs";
import chokidar from "chokidar";
import { WorkflowSchema, type Workflow } from "./types.ts";
import type { Logger } from "pino";

export function loadWorkflow(filePath: string): { workflow: Workflow; template: string } {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = matter(raw);
  const workflow = WorkflowSchema.parse(parsed.data);
  return { workflow, template: parsed.content };
}

export function watchWorkflow(
  filePath: string,
  onChange: (workflow: Workflow, template: string) => void,
  logger?: Logger,
) {
  // awaitWriteFinish gives chokidar a stability window to avoid firing on
  // partial writes (`cat > file` truncate-rewrite, atomic-rename editors).
  const watcher = chokidar.watch(filePath, {
    persistent: false,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 200 },
  });
  const reload = (event: string) => {
    try {
      const { workflow, template } = loadWorkflow(filePath);
      onChange(workflow, template);
      logger?.info?.({ filePath, event }, "workflow reloaded");
    } catch (err) {
      // DO NOT swallow — operators must see parse/schema errors. The previous
      // implementation's catch{} hid every kind of editor or schema problem,
      // leaving symphony stuck on the stale template with no log line.
      logger?.error?.({ err, filePath, event }, "workflow reload failed");
    }
  };
  watcher.on("change", () => reload("change"));
  watcher.on("add", () => reload("add"));     // atomic-rename editors only emit add
  return watcher;
}
