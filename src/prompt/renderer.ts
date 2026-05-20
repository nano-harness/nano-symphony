import { Liquid } from "liquidjs";
import type { Tracker } from "../db/tracker.ts";

const engine = new Liquid({ strictVariables: true, strictFilters: true });

export interface RenderPromptOptions {
  goal?: {
    condition: string;
    inject_mode?: "prefix" | "system" | "none";
  };
  tracker?: Tracker;
  issueId?: string;
}

export async function renderPrompt(
  template: string,
  vars: Record<string, unknown>,
  opts: RenderPromptOptions = {}
): Promise<string> {
  let prefix = "";

  // Inject reviewer notes if present
  if (opts.tracker && opts.issueId) {
    const revisionEvent = opts.tracker.getLatestEventByKind(opts.issueId, "revision_requested");
    const startedEvent = opts.tracker.getLatestEventByKind(opts.issueId, "started");

    // Only inject if revision_requested is more recent than the last started event
    if (revisionEvent && (!startedEvent || revisionEvent.ts > startedEvent.ts)) {
      const payload = JSON.parse(revisionEvent.payload_json ?? "{}") as { note?: string };
      if (payload.note) {
        prefix += `Reviewer requested changes:\n${payload.note}\n\nAddress these in this attempt.\n\n`;
      }
    }
  }

  // Inject goal if present
  if (opts.goal?.condition && (opts.goal.inject_mode ?? "prefix") === "prefix") {
    prefix += `/goal ${opts.goal.condition}\n\n`;
  }

  const rendered = await engine.parseAndRender(template, vars);
  return prefix + rendered;
}
