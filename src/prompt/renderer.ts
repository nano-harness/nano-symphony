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

  // Inject reviewer notes if present (general revision_request or plan revision feedback)
  if (opts.tracker && opts.issueUuid) {
    const generalRevision = opts.tracker.getLatestEventByKind(opts.issueUuid, "revision_requested");
    const planRevision = opts.tracker.getLatestEventByKind(opts.issueUuid, "plan_revision_requested");
    const startedEvent = opts.tracker.getLatestEventByKind(opts.issueUuid, "started");

    const revisionEvent = planRevision && generalRevision
      ? (planRevision.ts > generalRevision.ts ? planRevision : generalRevision)
      : (planRevision ?? generalRevision);

    // Only inject if revision event is more recent than the last started event
    if (revisionEvent && (!startedEvent || revisionEvent.ts > startedEvent.ts)) {
      let payload: {
        note?: string;
        feedback?: { category: string; severity: string; must_fix?: string[] };
      } = {};
      try {
        payload = JSON.parse(revisionEvent.payload_json ?? "{}") as typeof payload;
      } catch (err) {
        console.warn(`[renderPrompt] ignoring malformed revision payload for ${opts.issueUuid}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (payload.note || payload.feedback) {
        prefix += "Reviewer requested changes:\n";
        if (payload.feedback) {
          prefix += `Category: ${payload.feedback.category}\n`;
          prefix += `Severity: ${payload.feedback.severity}\n`;
          if (payload.feedback.must_fix && payload.feedback.must_fix.length > 0) {
            prefix += "Must fix:\n";
            for (const item of payload.feedback.must_fix) {
              prefix += `- ${item}\n`;
            }
          }
          prefix += "\n";
        }
        if (payload.note) {
          prefix += `${payload.note}\n\n`;
        }
        prefix += "Address these in this attempt.\n\n";
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

  // Inject "Plan First" instruction if issue requires a plan
  if (opts.tracker && opts.issueUuid) {
    const issue = opts.tracker.getIssue(opts.issueUuid);
    if (issue && issue.require_plan === true && issue.state !== "awaiting_plan") {
      prefix +=
        `## Plan First\n\n` +
        `This issue requires a plan before implementation. You MUST spawn a plan run using ` +
        `symphony spawn-plan-run-and-handoff (or the MCP tool) before writing any code.\n\n` +
        `1. Analyze the issue and break it into clear phases\n` +
        `2. Write a JavaScript plan script (issue(), parallel(), pipeline(), phase())\n` +
        `3. Call symphony spawn-plan-run-and-handoff --script plan.js\n` +
        `4. The plan will be dry-run, approved, and executed automatically\n\n` +
        `Do NOT implement anything yet — spawn the plan first.\n\n`;
    }
  }

  // Inject goal if present
  if (opts.goal?.condition) {
    const mode = opts.goal.inject_mode ?? "prefix";
    if (mode === "prefix") {
      prefix += `/goal ${opts.goal.condition}\n\n`;
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
