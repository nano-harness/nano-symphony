import matter from "gray-matter";
import { readFileSync } from "fs";
import chokidar from "chokidar";
import { WorkflowSchema, type Workflow } from "./types.ts";
import type { Logger } from "pino";

export function loadWorkflow(filePath: string): { workflow: Workflow; template: string } {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = matter(raw);
  const workflow = WorkflowSchema.parse(parsed.data);

  // Validate that the template body references issue variables.
  // Without these, the agent will never receive the issue content.
  const content = parsed.content;
  if (!content.includes("issue.title") && !content.includes("issue.description")) {
    throw new Error(
      `WORKFLOW.md template body does not reference {{ issue.title }} or {{ issue.description }}. ` +
      `The agent will not receive the issue content. ` +
      `Please check ${filePath} — it may have been overwritten with documentation.`
    );
  }

  return { workflow, template: content };
}

export function watchWorkflow(
  filePath: string,
  onChange: (workflow: Workflow, template: string) => void,
  logger?: Logger,
) {
  // awaitWriteFinish gives chokidar a stability window to avoid firing on
  // partial writes (`cat > file` truncate-rewrite, atomic-rename editors).
  // macOS fsevents misses atomic-rename writes from editors, so default to
  // polling on darwin unless explicitly overridden via env.
  const usePolling = process.env.SYMPHONY_WATCH_USE_POLLING !== undefined
    ? process.env.SYMPHONY_WATCH_USE_POLLING === "1"
    : process.platform === "darwin";
  const watcher = chokidar.watch(filePath, {
    persistent: false,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 200 },
    ...(usePolling ? { usePolling: true, interval: 200 } : {}),
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
