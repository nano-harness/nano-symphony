import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { useParams, useNavigate, A } from "@solidjs/router";
import { api, type Issue, type SymphonyEvent, type SymphonyRun } from "./api";
import { IssueModal } from "./IssueModal";
import { HandoffPanel } from "./HandoffPanel";

export function IssueDetail() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [issue, setIssue] = createSignal<Issue | null>(null);
  const [run, setRun] = createSignal<SymphonyRun | null>(null);
  const [events, setEvents] = createSignal<SymphonyEvent[]>([]);
  const [logs, setLogs] = createSignal("");
  const [showModal, setShowModal] = createSignal(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [toast, setToast] = createSignal<{ message: string; type: "success" | "error" } | null>(null);

  const load = async () => {
    const [i, e, r] = await Promise.all([
      api.getIssue(params.id),
      api.getEvents(),
      api.getRun(params.id).catch(() => null),
    ]);
    setIssue(i);
    setEvents(e.filter((ev) => ev.issue_id === params.id).sort((a, b) => a.ts - b.ts));
    setRun(r);
  };

  // Refresh issue and run data (for live updates)
  const refreshIssueAndRun = async () => {
    try {
      const [i, r] = await Promise.all([
        api.getIssue(params.id),
        api.getRun(params.id).catch(() => null),
      ]);
      setIssue(i);
      setRun(r);
    } catch (err) {
      // Silently ignore refresh errors to avoid breaking the refresh chain
    }
  };

  onMount(() => {
    load();

    // Setup events SSE
    const eventsSource = api.streamEvents();
    eventsSource.addEventListener("message", (e) => {
      try {
        const event = JSON.parse(e.data) as SymphonyEvent;
        if (event.issue_id === params.id) {
          setEvents((prev) => {
            // Deduplicate by id
            if (prev.some((ev) => ev.id === event.id)) return prev;
            return [...prev, event].sort((a, b) => a.ts - b.ts);
          });
        }
      } catch {}
    });

    // Listen to run events for immediate state updates
    eventsSource.addEventListener("run", (e) => {
      try {
        const runPatch = JSON.parse(e.data) as Partial<SymphonyRun> & { issue_id: string };
        if (runPatch.issue_id === params.id) {
          setRun((prev) => {
            if (!prev) return prev;
            return { ...prev, ...runPatch };
          });
        }
      } catch {}
    });

    // Fallback poller in case SSE disconnects
    const fallbackInterval = setInterval(refreshIssueAndRun, 10000);

    onCleanup(() => {
      eventsSource.close();
      clearInterval(fallbackInterval);
    });
  });

  // Setup logs SSE with createEffect to handle run changes
  let logsSource: EventSource | null = null;
  let wiredAttempt: number | null = null;
  let logBackoff = 1000;

  const reconnectLogs = (attempt: number) => {
    if (logsSource) logsSource.close();
    logsSource = api.streamLogs(params.id, attempt);
    attachLogListeners(attempt);
  };

  const attachLogListeners = (attempt: number) => {
    if (!logsSource) return;

    logsSource.addEventListener("log", (e: MessageEvent) => {
      setLogs((prev) => prev + e.data);
      logBackoff = 1000; // Reset backoff on successful message
    });

    logsSource.addEventListener("end", () => {
      if (logsSource) logsSource.close();
    });

    logsSource.addEventListener("error", () => {
      if (logsSource) logsSource.close();
      // Retry with exponential backoff
      setTimeout(() => reconnectLogs(attempt), logBackoff);
      logBackoff = Math.min(logBackoff * 2, 10000);
    });
  };

  createEffect(() => {
    const r = run();
    if (!r || r.current_attempt === null) return;
    if (wiredAttempt === r.current_attempt) return; // Same attempt, don't resubscribe
    if (logsSource) {
      logsSource.close();
      setLogs("");
    }
    wiredAttempt = r.current_attempt;
    logBackoff = 1000; // Reset backoff for new attempt
    reconnectLogs(r.current_attempt);
  });

  onCleanup(() => {
    if (logsSource) logsSource.close();
  });

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 1800);
  };

  const handleDelete = async () => {
    try {
      await api.deleteIssue(params.id);
      showToast("Movement removed");
      setTimeout(() => navigate("/"), 500);
    } catch (err) {
      showToast("Failed to delete issue", "error");
      setShowDeleteConfirm(false);
    }
  };

  const handleSave = async () => {
    await load();
    showToast("Changes saved");
  };

  const formatTime = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleString();
  };

  const tryParsePayload = (payloadJson: string | null) => {
    if (!payloadJson) return null;
    try {
      return JSON.parse(payloadJson);
    } catch {
      return null;
    }
  };

  return (
    <div class="page">
      <Show when={issue()} fallback={<p style="color: var(--mute)">Loading...</p>}>
        <div class="issue-detail">
          <div class="issue-main">
            <div class="issue-breadcrumb">
              <A href="/" class="btn btn-secondary">← Back to dashboard</A>
            </div>
            <div class="issue-header">
              <div class="issue-header-top">
                <div>
                  <h1 class="page-title">{issue()!.title}</h1>
                </div>
                <div class="issue-actions">
                  <button class="btn btn-secondary" onClick={() => setShowModal(true)}>
                    ✎ Edit
                  </button>
                  <button class="btn btn-secondary" onClick={() => setShowDeleteConfirm(true)}>
                    × Delete
                  </button>
                </div>
              </div>
              <div class="issue-meta">
                <span class={`pill ${issue()!.state}`}>{issue()!.state.replace("_", " ")}</span>
                <span class="pill">{issue()!.priority}</span>
                <Show when={issue()!.labels.length > 0}>
                  <For each={issue()!.labels}>
                    {(label) => <span class="pill">{label}</span>}
                  </For>
                </Show>
              </div>
            </div>

            <Show when={issue()!.description}>
              <div class="issue-section">
                <h2 class="section-title">Notes</h2>
                <div class="issue-description">{issue()!.description}</div>
              </div>
            </Show>

            <HandoffPanel issueId={params.id} issueState={issue()!.state} />

            <Show when={logs()}>
              <div class="issue-section">
                <h2 class="section-title">III. STAGE — Live transcript</h2>
                <pre class="logs-pane">{logs()}</pre>
              </div>
            </Show>

            <div class="issue-section">
              <h2 class="section-title">II. EVENTS — ANDANTE / Performance log</h2>
              <Show when={events().length === 0}>
                <p style="color: var(--mute); font-size: 13px;">No events recorded yet.</p>
              </Show>
              <Show when={events().length > 0}>
                <ul class="events-list">
                  <For each={events()}>
                    {(event) => {
                      const payload = tryParsePayload(event.payload_json);
                      return (
                        <li class="event-card">
                          <div class="event-header">
                            <span class="event-kind">{event.kind}</span>
                            <span class="event-time">{formatTime(event.ts)}</span>
                          </div>
                          <div class="event-message">{event.message}</div>
                          <Show when={payload}>
                            <details class="event-payload">
                              <summary>View details</summary>
                              <pre style="margin-top: 8px; font-size: 11px; overflow-x: auto;">
                                {JSON.stringify(payload, null, 2)}
                              </pre>
                            </details>
                          </Show>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </Show>
            </div>
          </div>

          <aside class="issue-aside">
            <h3 class="aside-title">Score Sheet</h3>
            <div class="aside-field">
              <div class="aside-label">State</div>
              <div class="aside-value">{issue()!.state.replace("_", " ")}</div>
            </div>
            <div class="aside-field">
              <div class="aside-label">Priority</div>
              <div class="aside-value">{issue()!.priority}</div>
            </div>
            <div class="aside-field">
              <div class="aside-label">Agent</div>
              <div class="aside-value">{issue()!.agent_kind ?? "workflow default"}</div>
            </div>
            <Show when={issue()!.agent_binary}>
              <div class="aside-field">
                <div class="aside-label">Agent binary</div>
                <div class="aside-value-mono">{issue()!.agent_binary}</div>
              </div>
            </Show>
            <div class="aside-field">
              <div class="aside-label">Sandbox</div>
              <div class="aside-value">
                {issue()!.sandbox_mode === "off"
                  ? "Disabled (per-issue)"
                  : issue()!.agent_kind === "claude-code"
                    ? "⚠ Unmanaged (claude-code)"
                    : "Default"}
              </div>
            </div>
            <Show when={(issue()!.sandbox_extra_writable_paths ?? []).length > 0}>
              <div class="aside-field">
                <div class="aside-label">Extra writable</div>
                <div class="aside-value-mono" style="font-size: 11px;">
                  {(issue()!.sandbox_extra_writable_paths ?? []).map((p) => <div>{p}</div>)}
                </div>
              </div>
            </Show>
            <Show when={run()}>
              <div class="aside-field">
                <div class="aside-label">Attempt</div>
                <div class="aside-value-mono">{run()!.next_attempt}</div>
              </div>
              <div class="aside-field">
                <div class="aside-label">Last State</div>
                <div class="aside-value">
                  <span class={`pill ${run()!.last_state}`}>{run()!.last_state.replace("_", " ")}</span>
                </div>
              </div>
              <Show when={run()!.token_total > 0}>
                <div class="aside-field">
                  <div class="aside-label">Tokens</div>
                  <div class="aside-value-mono" style="font-size: 11px;">
                    in: {run()!.token_input.toLocaleString()}<br />
                    out: {run()!.token_output.toLocaleString()}<br />
                    total: {run()!.token_total.toLocaleString()}
                  </div>
                </div>
              </Show>
            </Show>
            <div class="aside-field">
              <div class="aside-label">Created</div>
              <div class="aside-value-mono">
                {new Date(issue()!.created_at).toLocaleDateString()}
              </div>
            </div>
            <div class="aside-field">
              <div class="aside-label">Updated</div>
              <div class="aside-value-mono">
                {new Date(issue()!.updated_at).toLocaleDateString()}
              </div>
            </div>
            <Show when={run()?.workspace_path}>
              <div class="aside-field">
                <div class="aside-label">Workspace</div>
                <div class="aside-value-mono workspace-path">
                  <span title={run()!.workspace_path}>{run()!.workspace_path}</span>
                  <button
                    class="btn-icon"
                    onClick={() => navigator.clipboard.writeText(run()!.workspace_path)}
                    title="Copy path"
                  >
                    ⎘
                  </button>
                </div>
                <div class="workspace-badge">
                  <span class={`pill ${run()!.workspace_managed ? "managed" : "external"}`}>
                    {run()!.workspace_managed ? "managed" : "external"}
                  </span>
                </div>
              </div>
            </Show>
            <Show when={issue()!.branch}>
              <div class="aside-field">
                <div class="aside-label">Branch</div>
                <div class="aside-value-mono">{issue()!.branch}</div>
              </div>
            </Show>
            <Show when={issue()!.url}>
              <div class="aside-field">
                <div class="aside-label">URL</div>
                <div class="aside-value">
                  <a href={issue()!.url!} target="_blank" rel="noopener noreferrer">
                    Link
                  </a>
                </div>
              </div>
            </Show>
          </aside>
        </div>
      </Show>

      {/* Edit Modal */}
      <Show when={showModal()}>
        <IssueModal issue={issue()} onClose={() => setShowModal(false)} onSave={handleSave} />
      </Show>

      {/* Delete Confirmation */}
      <Show when={showDeleteConfirm()}>
        <div class="modal-backdrop" onClick={() => setShowDeleteConfirm(false)}>
          <div class="modal modal-confirm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-chapter-mark"></div>
            <div class="modal-confirm-body">
              <h3 class="modal-confirm-title">CODA</h3>
              <p class="modal-confirm-message">Remove this movement?</p>
            </div>
            <div class="modal-confirm-footer">
              <button class="btn btn-ghost" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
              <button class="btn btn-danger" onClick={handleDelete}>
                Remove
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Toast Notifications */}
      <Show when={toast()}>
        <div class="toast-container">
          <div class={`toast ${toast()!.type}`}>{toast()!.message}</div>
        </div>
      </Show>
    </div>
  );
}
