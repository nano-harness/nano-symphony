import { createSignal, onMount, For } from "solid-js";
import { useParams } from "@solidjs/router";
import { api, type Issue, type SymphonyEvent } from "./api";
export function IssueDetail() {
  const params = useParams<{ id: string }>();
  const [issue, setIssue] = createSignal<Issue | null>(null);
  const [events, setEvents] = createSignal<SymphonyEvent[]>([]);
  onMount(async () => { const [i, e] = await Promise.all([api.getIssue(params.id), api.getEvents()]); setIssue(i); setEvents(e.filter(ev => ev.issue_id === params.id)); });
  return <div style="padding:24px;font-family:system-ui">{issue() ? <><h1>{issue()!.title}</h1><p>{issue()!.identifier} · {issue()!.state}</p><h2>Events</h2><For each={events()}>{ev => <div style="border:1px solid #e2e8f0;padding:10px;margin-bottom:8px"><b>{ev.kind}</b> {ev.message}</div>}</For></> : <p>Loading...</p>}</div>;
}
