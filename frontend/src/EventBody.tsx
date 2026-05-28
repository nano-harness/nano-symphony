import { createSignal, Show } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import remarkGfm from "remark-gfm";

/** Maximum payload size (in characters) before auto-collapsing */
const COLLAPSE_THRESHOLD = 8192;

/** Known text fields that should be rendered as markdown */
const MARKDOWN_FIELDS = ["markdown", "text", "summary", "message", "content", "reason"] as const;

interface EventBodyProps {
  kind: string;
  payload: unknown;
}

/**
 * Extracts the best markdown-renderable text from a payload object.
 * Priority: payload.markdown > payload.text > payload.summary > payload.message > payload.content > payload.reason
 */
function extractMarkdownText(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return null;

  const obj = payload as Record<string, unknown>;
  for (const field of MARKDOWN_FIELDS) {
    if (typeof obj[field] === "string" && (obj[field] as string).trim().length > 0) {
      return obj[field] as string;
    }
  }
  return null;
}

/**
 * Custom link component that forces external links to open in new tab safely.
 */
function SafeLink(props: { href?: string; children?: any }) {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}

export function EventBody(props: EventBodyProps) {
  const [expanded, setExpanded] = createSignal(false);
  const [showRaw, setShowRaw] = createSignal(false);

  const markdownText = () => extractMarkdownText(props.payload);
  const jsonText = () => {
    if (props.payload === null || props.payload === undefined) return null;
    try {
      return JSON.stringify(props.payload, null, 2);
    } catch {
      return String(props.payload);
    }
  };

  const isLong = () => {
    const text = markdownText() ?? jsonText();
    return text !== null && text.length > COLLAPSE_THRESHOLD;
  };

  const shouldShowContent = () => !isLong() || expanded();

  return (
    <div class="event-body">
      <Show when={markdownText() && !showRaw()}>
        <Show when={shouldShowContent()} fallback={
          <div class="event-body-collapsed">
            <div class="event-body-markdown markdown-body">
              <SolidMarkdown
                children={markdownText()!.slice(0, COLLAPSE_THRESHOLD)}
                remarkPlugins={[remarkGfm]}
                components={{ a: SafeLink }}
              />
            </div>
            <button class="btn-expand" onClick={() => setExpanded(true)}>
              ⋯ Show full content ({Math.round(markdownText()!.length / 1024)} KB)
            </button>
          </div>
        }>
          <div class="event-body-markdown markdown-body">
            <SolidMarkdown
              children={markdownText()!}
              remarkPlugins={[remarkGfm]}
              components={{ a: SafeLink }}
            />
          </div>
          <Show when={isLong()}>
            <button class="btn-expand" onClick={() => setExpanded(false)}>
              ▲ Collapse
            </button>
          </Show>
        </Show>
        <button class="btn-raw-toggle" onClick={() => setShowRaw(true)}>
          Show raw JSON
        </button>
      </Show>

      <Show when={!markdownText() || showRaw()}>
        <Show when={jsonText()}>
          <Show when={shouldShowContent()} fallback={
            <div class="event-body-collapsed">
              <pre class="event-body-json">{jsonText()!.slice(0, COLLAPSE_THRESHOLD)}</pre>
              <button class="btn-expand" onClick={() => setExpanded(true)}>
                ⋯ Show full content ({Math.round(jsonText()!.length / 1024)} KB)
              </button>
            </div>
          }>
            <pre class="event-body-json">{jsonText()}</pre>
            <Show when={isLong()}>
              <button class="btn-expand" onClick={() => setExpanded(false)}>
                ▲ Collapse
              </button>
            </Show>
          </Show>
          <Show when={showRaw() && markdownText()}>
            <button class="btn-raw-toggle" onClick={() => setShowRaw(false)}>
              Show rendered
            </button>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
