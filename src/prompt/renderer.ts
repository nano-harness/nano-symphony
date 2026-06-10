import { Liquid } from "liquidjs";
import type { Tracker } from "../db/tracker.ts";

const engine = new Liquid({ strictVariables: true, strictFilters: true });

/** LRU-like template cache to avoid re-parsing the same workflow template on every dispatch. */
const templateCache = new Map<string, ReturnType<typeof engine.parse>>();
const MAX_TEMPLATE_CACHE_SIZE = 10;

function getCachedTemplate(template: string): ReturnType<typeof engine.parse> {
  const cached = templateCache.get(template);
  if (cached) return cached;

  const tpl = engine.parse(template);
  // Evict oldest entry if at capacity
  if (templateCache.size >= MAX_TEMPLATE_CACHE_SIZE) {
    const firstKey = templateCache.keys().next().value;
    if (firstKey !== undefined) templateCache.delete(firstKey);
  }
  templateCache.set(template, tpl);
  return tpl;
}

export interface RenderPromptOptions {
  goal?: {
    condition: string;
    inject_mode?: "prefix" | "system" | "none";
  };
  tracker?: Tracker;
  issueUuid?: string;
}

export interface RenderPromptMeta {
  commentIds: string[];
  truncated: boolean;
}

export interface RenderPromptResult {
  text: string;
  meta: RenderPromptMeta;
}

const COMMENTS_MAX_COUNT = 50;
const COMMENTS_MAX_BYTES = 16 * 1024;

/**
 * Formats comments into a markdown block for prompt injection.
 * Applies truncation: max 50 comments, max 16KiB total.
 */
export function formatComments(comments: Array<{ id: string; ts: number; author: string; body: string }>): {
  rendered: string;
  includedIds: string[];
  truncated: boolean;
} {
  if (comments.length === 0) return { rendered: "", includedIds: [], truncated: false };

  // Step 1: truncate by count (keep most recent)
  let truncated = false;
  let dropped = 0;
  let included = comments;
  if (comments.length > COMMENTS_MAX_COUNT) {
    dropped = comments.length - COMMENTS_MAX_COUNT;
    included = comments.slice(comments.length - COMMENTS_MAX_COUNT);
    truncated = true;
  }

  // Step 2: format lines and truncate by bytes (drop oldest first)
  const lines: string[] = [];
  const includedIds: string[] = [];
  let totalBytes = 0;

  for (const c of included) {
    const date = new Date(c.ts).toISOString().slice(0, 16).replace("T", " ");
    const line = `- [${date}, ${c.author}] ${c.body}`;
    const lineBytes = new TextEncoder().encode(line + "\n").length;

    if (totalBytes + lineBytes > COMMENTS_MAX_BYTES && lines.length > 0) {
      dropped += included.length - lines.length;
      truncated = true;
      break;
    }

    lines.push(line);
    includedIds.push(c.id);
    totalBytes += lineBytes;
  }

  let rendered = "";
  if (dropped > 0) {
    rendered += `> (${dropped} older comments omitted)\n\n`;
  }
  rendered += `## Operator comments (${includedIds.length})\n`;
  rendered += lines.join("\n") + "\n\n";

  return { rendered, includedIds, truncated };
}

export async function renderPrompt(
  template: string,
  vars: Record<string, unknown>,
  opts: RenderPromptOptions = {}
): Promise<RenderPromptResult> {
  let prefix = "";
  const meta: RenderPromptMeta = { commentIds: [], truncated: false };

  // Inject reviewer notes if present
  if (opts.tracker && opts.issueUuid) {
    const revisionEvent = opts.tracker.getLatestEventByKind(opts.issueUuid, "revision_requested");
    const startedEvent = opts.tracker.getLatestEventByKind(opts.issueUuid, "started");

    // Only inject if revision_requested is more recent than the last started event
    if (revisionEvent && (!startedEvent || revisionEvent.ts > startedEvent.ts)) {
      const payload = JSON.parse(revisionEvent.payload_json ?? "{}") as { note?: string };
      if (payload.note) {
        prefix += `Reviewer requested changes:\n${payload.note}\n\nAddress these in this attempt.\n\n`;
      }
    }
  }

  // Inject comments if present
  if (opts.tracker && opts.issueUuid) {
    const comments = opts.tracker.listComments(opts.issueUuid);
    if (comments.length > 0) {
      const { rendered, includedIds, truncated } = formatComments(comments);
      prefix += rendered;
      meta.commentIds = includedIds;
      meta.truncated = truncated;
    }
  }

  // Inject planning instruction if issue is in planning state
  if (opts.tracker && opts.issueUuid) {
    const issue = opts.tracker.getIssue(opts.issueUuid);
    if (issue && issue.state === "planning") {
      prefix +=
        `## Planning Mode\n\n` +
        `You are in PLANNING mode. Your task is to analyze the issue and produce a detailed implementation plan.\n\n` +
        `1. Break down the work into clear steps\n` +
        `2. Estimate complexity, files touched, and expected turns\n` +
        `3. Submit your plan using: symphony.submit_plan({ markdown: "...", steps: [...], estimates: {...} })\n` +
        `4. After submitting the plan, call symphony.session_completed\n\n` +
        `Do NOT implement anything yet — only produce the plan.\n\n`;
    }
  }

  // Override goal for planning mode
  const isPlanning = opts.tracker && opts.issueUuid
    ? opts.tracker.getIssue(opts.issueUuid)?.state === "planning"
    : false;

  // Inject goal if present
  if (opts.goal?.condition) {
    const mode = opts.goal.inject_mode ?? "prefix";
    if (mode === "prefix") {
      const goalCondition = isPlanning
        ? "Submit a detailed implementation plan using symphony.submit_plan, then call symphony.session_completed"
        : opts.goal.condition;
      prefix += `/goal ${goalCondition}\n\n`;
    }
  }

  const tpl = getCachedTemplate(template);
  const rendered = await engine.render(tpl, vars);

  // Sanity check: verify issue content was actually injected into the rendered prompt
  const issueTitle = (vars.issue as Record<string, unknown> | undefined)?.title as string | undefined;
  if (issueTitle && issueTitle.length > 0 && !rendered.includes(issueTitle)) {
    console.warn(
      `[prompt/renderer] WARNING: rendered prompt does not contain issue title "${issueTitle}". ` +
      `The workflow template may be misconfigured.`
    );
  }

  return { text: prefix + rendered, meta };
}
