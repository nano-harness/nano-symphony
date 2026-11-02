import { For, Show } from "solid-js";
import { EventBody } from "./EventBody";
import type { SymphonyEvent } from "./api";

interface EventGroup {
  type: "event" | "tool_pair";
  ts: number;
  attempt: number;
  deltaMs: number;
  event?: SymphonyEvent;
  call?: SymphonyEvent;
  result?: SymphonyEvent;
}

interface EventTimelineProps {
  events: SymphonyEvent[];
}

const MARKDOWN_FIELDS = ["markdown", "text", "summary", "message", "content", "reason"] as const;

function tryParsePayload(payloadJson: string | null): unknown {
  if (!payloadJson) return null;
  try {
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

function extractAttempt(event: SymphonyEvent): number {
  const payload = tryParsePayload(event.payload_json);
  if (payload && typeof payload === "object" && "attempt" in payload) {
    const a = (payload as Record<string, unknown>).attempt;
    if (typeof a === "number") return a;
  }
  return 0;
}

function extractToolName(event: SymphonyEvent): string | undefined {
  const payload = tryParsePayload(event.payload_json);
  if (payload && typeof payload === "object" && "tool" in payload) {
    return String((payload as Record<string, unknown>).tool);
  }
  return undefined;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString();
}

function formatDelta(ms: number) {
  if (ms < 1000) return `+${Math.round(ms)}ms`;
  return `+${(ms / 1000).toFixed(1)}s`;
}

function deltaClass(ms: number) {
  if (ms >= 30_000) return "event-delta hot";
  if (ms >= 10_000) return "event-delta warm";
  return "event-delta";
}

function buildGroups(events: SymphonyEvent[]): EventGroup[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const groups: EventGroup[] = [];
  const consumed = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    if (consumed.has(event.id)) continue;

    if (event.kind === "tool_call") {
      const tool = extractToolName(event);
      // Look ahead for the matching tool_result
      let result: SymphonyEvent | undefined;
      for (let j = i + 1; j < sorted.length; j++) {
        const candidate = sorted[j];
        if (candidate.kind === "tool_result" && extractToolName(candidate) === tool) {
          result = candidate;
          consumed.add(candidate.id);
          break;
        }
      }
      groups.push({
        type: "tool_pair",
        ts: event.ts,
        attempt: extractAttempt(event),
        deltaMs: 0,
        call: event,
        result,
      });
      continue;
    }

    if (event.kind === "tool_result") {
      // Unmatched tool_result (no preceding tool_call captured)
      groups.push({
        type: "event",
        ts: event.ts,
        attempt: extractAttempt(event),
        deltaMs: 0,
        event,
      });
      continue;
    }

    groups.push({
      type: "event",
      ts: event.ts,
      attempt: extractAttempt(event),
      deltaMs: 0,
      event,
    });
  }

  // Compute deltas
  for (let i = 1; i < groups.length; i++) {
    groups[i].deltaMs = Math.max(0, groups[i].ts - groups[i - 1].ts);
  }

  return groups;
}

function isErrorResult(event?: SymphonyEvent): boolean {
  if (!event) return false;
  const payload = tryParsePayload(event.payload_json);
  if (payload && typeof payload === "object") {
    return (payload as Record<string, unknown>).is_error === true;
  }
  return false;
}

function payloadText(event: SymphonyEvent): string | null {
  const payload = tryParsePayload(event.payload_json);
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

export function EventTimeline(props: EventTimelineProps) {
  const groups = () => buildGroups(props.events);

  return (
    <ul class="events-list">
      <For each={groups()}>
        {(group, idx) => {
          const showAttemptHeader = idx() === 0 || groups()[idx() - 1].attempt !== group.attempt;
          return (
            <>
              <Show when={showAttemptHeader}>
                <li class="event-attempt-header">
                  <span class="event-attempt-label">Attempt {group.attempt}</span>
                  <span class="event-attempt-line" />
                </li>
              </Show>
              <Show when={group.type === "event"}>
                <EventGroupCard group={group} />
              </Show>
              <Show when={group.type === "tool_pair"}>
                <ToolPairCard group={group as EventGroup & { type: "tool_pair"; call: SymphonyEvent; result?: SymphonyEvent }} />
              </Show>
            </>
          );
        }}
      </For>
    </ul>
  );
}

function EventGroupCard(props: { group: EventGroup }) {
  const event = () => props.group.event!;
  const payload = () => tryParsePayload(event().payload_json);
  return (
    <li class="event-card">
      <div class="event-header">
        <span class="event-kind">{event().kind}</span>
        <span class={deltaClass(props.group.deltaMs)}>{formatDelta(props.group.deltaMs)}</span>
        <span class="event-time">{formatTime(event().ts)}</span>
      </div>
      <div class="event-message">{event().message}</div>
      <Show when={payload()}>
        <EventBody kind={event().kind} payload={payload()} />
      </Show>
    </li>
  );
}

function ToolPairCard(props: { group: EventGroup & { type: "tool_pair"; call: SymphonyEvent; result?: SymphonyEvent } }) {
  const callPayload = () => tryParsePayload(props.group.call.payload_json);
  const resultPayload = () => (props.group.result ? tryParsePayload(props.group.result.payload_json) : null);
  const durationMs = () => (props.group.result ? props.group.result.ts - props.group.call.ts : 0);
  const hasError = () => isErrorResult(props.group.result);

  return (
    <li class={`event-card tool-pair ${hasError() ? "tool-error" : ""}`}>
      <div class="event-header">
        <span class="event-kind">tool_call → tool_result</span>
        <span class={deltaClass(props.group.deltaMs)}>{formatDelta(props.group.deltaMs)}</span>
        <span class="event-time">{formatTime(props.group.call.ts)}</span>
      </div>
      <div class="tool-pair-title">
        {extractToolName(props.group.call)}
        <Show when={props.group.result}>
          <span class="tool-pair-duration">({(durationMs() / 1000).toFixed(1)}s)</span>
        </Show>
        <Show when={hasError()}>
          <span class="pill error">error</span>
        </Show>
      </div>
      <Show when={props.group.call.message}>
        <div class="event-message">{props.group.call.message}</div>
      </Show>
      <Show when={callPayload()}>
        <EventBody kind="tool_call" payload={callPayload()} />
      </Show>
      <Show when={props.group.result}>
        <div class="tool-result-divider" />
        <div class="event-message">{props.group.result!.message}</div>
        <Show when={resultPayload()}>
          <EventBody kind="tool_result" payload={resultPayload()} />
        </Show>
      </Show>
    </li>
  );
}
