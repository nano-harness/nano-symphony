import { createSignal, createMemo, createEffect, For, Show } from "solid-js";
import { getLogParser, type ParsedLogLine } from "./log-parsers";

interface LogViewerProps {
  /** Raw log text (continuously appended) */
  rawText: string;
  /** Current issue's agent kind, determines which parser to use */
  agentKind?: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  system: "SYS",
  assistant: "LLM",
  tool_call: "TOOL",
  tool_result: "RES",
  result: "DONE",
  error: "ERR",
  info: "INFO",
  unknown: "???",
};

export function LogViewer(props: LogViewerProps) {
  const [expandedSet, setExpandedSet] = createSignal<Set<number>>(new Set());
  const [filter, setFilter] = createSignal<string | null>(null);
  const [autoScroll, setAutoScroll] = createSignal(true);
  let containerRef: HTMLDivElement | undefined;

  const parser = createMemo(() => getLogParser(props.agentKind));

  const lines = createMemo((): ParsedLogLine[] => {
    const raw = props.rawText;
    if (!raw) return [];
    const rawLines = raw.split("\n").filter((l) => l.trim());
    const parsed = rawLines.map((l) => parser().parseLine(l));
    return parser().postProcess ? parser().postProcess!(parsed) : parsed;
  });

  const filteredLines = createMemo(() => {
    const f = filter();
    if (!f) return lines();
    return lines().filter((l) => l.type === f);
  });

  // Auto-scroll to bottom on new lines
  createEffect(() => {
    filteredLines(); // track dependency
    if (autoScroll() && containerRef) {
      requestAnimationFrame(() => {
        containerRef!.scrollTop = containerRef!.scrollHeight;
      });
    }
  });

  const handleScroll = () => {
    if (!containerRef) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  const toggleExpand = (idx: number) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  return (
    <div class="log-viewer">
      <div class="log-viewer-toolbar">
        <button class={`log-filter-btn ${!filter() ? "active" : ""}`} onClick={() => setFilter(null)}>
          All ({lines().length})
        </button>
        <For each={["assistant", "tool_call", "system", "result", "error"] as const}>
          {(type) => {
            const count = () => lines().filter((l) => l.type === type).length;
            return (
              <Show when={count() > 0}>
                <button
                  class={`log-filter-btn ${filter() === type ? "active" : ""}`}
                  onClick={() => setFilter(filter() === type ? null : type)}
                >
                  {TYPE_LABELS[type]} ({count()})
                </button>
              </Show>
            );
          }}
        </For>
      </div>
      <div class="log-viewer-body" ref={containerRef} onScroll={handleScroll}>
        <For each={filteredLines()}>
          {(line, idx) => {
            const isExpanded = () => expandedSet().has(idx());
            return (
              <>
                <div
                  class={`log-line ${line.defaultCollapsed && !isExpanded() ? "collapsed" : ""}`}
                  onClick={() => toggleExpand(idx())}
                >
                  <span class={`log-line-type log-type-${line.type}`}>
                    {TYPE_LABELS[line.type] ?? line.type}
                  </span>
                  <span class="log-line-summary">{line.summary}</span>
                  <span class="log-line-chevron">{isExpanded() ? "▾" : "▸"}</span>
                </div>
                <Show when={isExpanded()}>
                  <div class="log-line-expanded">
                    <pre>{line.parsed ? JSON.stringify(line.parsed, null, 2) : line.raw}</pre>
                  </div>
                </Show>
              </>
            );
          }}
        </For>
      </div>
    </div>
  );
}
