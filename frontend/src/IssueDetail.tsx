import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { useParams, useNavigate, A } from "@solidjs/router";
import { api, type Issue, type SymphonyEvent, type SymphonyRun, type Comment, type PlanRun } from "./api";
import { IssueModal } from "./IssueModal";
import { HandoffPanel } from "./HandoffPanel";
import { PlanReviewPanel } from "./PlanReviewPanel";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { EventBody } from "./EventBody";
import { LogViewer } from "./LogViewer";

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  "nano": "Nano",
  "claude-code": "Claude Code",
};

export function IssueDetail() {
  const params = useParams<{ uuid: string }>();
  const navigate = useNavigate();
  const [issue, setIssue] = createSignal<Issue | null>(null);
  const [run, setRun] = createSignal<SymphonyRun | null>(null);
  const [events, setEvents] = createSignal<SymphonyEvent[]>([]);
  const [logs, setLogs] = createSignal("");
  const [showModal, setShowModal] = createSignal(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [toast, setToast] = createSignal<{ message: string; type: "success" | "error" } | null>(null);
  const [comments, setComments] = createSignal<Comment[]>([]);
  const [newComment, setNewComment] = createSignal("");
  const [showRetriggerNote, setShowRetriggerNote] = createSignal(false);
  const [retriggerNote, setRetriggerNote] = createSignal("");
  const [showCancelConfirm, setShowCancelConfirm] = createSignal(false);
  const [planRuns, setPlanRuns] = createSignal<PlanRun[]>([]);

  const load = async () => {
    const [i, e, r, c, pr] = await Promise.all([
      api.getIssue(params.uuid),
      api.getEvents(),
      api.getRun(params.uuid).catch(() => null),
      api.listComments(params.uuid).catch(() => []),
      api.listPlanRuns(params.uuid).catch(() => []),
    ]);
    setIssue(i);
    setEvents(e.filter((ev) => ev.issue_uuid === params.uuid).sort((a, b) => a.ts - b.ts));
    setRun(r);
    setComments(c);
    setPlanRuns(pr);
  };

  // Refresh issue and run data (for live updates)
  const refreshIssueAndRun = async () => {
    try {
      const [i, r] = await Promise.all([
        api.getIssue(params.uuid),
        api.getRun(params.uuid).catch(() => null),
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
        if (event.issue_uuid === params.uuid) {
          setEvents((prev) => {
            // Deduplicate by id
            if (prev.some((ev) => ev.id === event.id)) return prev;
            return [...prev, event].sort((a, b) => a.ts - b.ts);
          });
          // Refresh comments on comment events
          if (event.kind === "comment_added" || event.kind === "comment_deleted") {
            api.listComments(params.uuid).then(setComments).catch(() => {});
          }
          // Refresh issue on retrigger
          if (event.kind === "retrigger_requested") {
            refreshIssueAndRun();
          }
        }
      } catch {}
    });

    // Listen to run events for immediate state updates
    eventsSource.addEventListener("run", (e) => {
      try {
        const runPatch = JSON.parse(e.data) as Partial<SymphonyRun> & { issue_uuid: string };
        if (runPatch.issue_uuid === params.uuid) {
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
  let logsDisposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const reconnectLogs = (attempt: number) => {
    if (logsDisposed) return;
    if (logsSource) logsSource.close();
    logsSource = api.streamLogs(params.uuid, attempt);
    attachLogListeners(attempt);
  };

  const attachLogListeners = (attempt: number) => {
    if (!logsSource) return;

    logsSource.addEventListener("log", (e: MessageEvent) => {
      if (logsDisposed) return;
      setLogs((prev) => prev + e.data);
      logBackoff = 1000; // Reset backoff on successful message
    });

    logsSource.addEventListener("end", () => {
      if (logsSource) logsSource.close();
    });

    logsSource.addEventListener("error", () => {
      if (logsSource) logsSource.close();
      if (logsDisposed) return;
      // Retry with exponential backoff
      reconnectTimer = setTimeout(() => {
        if (!logsDisposed) reconnectLogs(attempt);
      }, logBackoff);
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
    logsDisposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (logsSource) logsSource.close();
  });

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 1800);
  };

  const handleDelete = async () => {
    try {
      await api.deleteIssue(params.uuid);
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

  const handleAddComment = async () => {
    const body = newComment().trim();
    if (!body) return;
    try {
      await api.addComment(params.uuid, body);
      setNewComment("");
      const c = await api.listComments(params.uuid);
      setComments(c);
    } catch (err) {
      showToast("Failed to add comment", "error");
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      await api.deleteComment(params.uuid, commentId);
      const c = await api.listComments(params.uuid);
      setComments(c);
    } catch (err) {
      showToast("Failed to delete comment", "error");
    }
  };

  const handleRetrigger = async (note?: string) => {
    try {
      await api.retrigger(params.uuid, note ? { note } : undefined);
      showToast("Retrigger requested");
      setShowRetriggerNote(false);
      setRetriggerNote("");
      await refreshIssueAndRun();
    } catch (err) {
      showToast("Retrigger failed", "error");
    }
  };

  const handleCancel = async () => {
    try {
      await api.cancelRun(params.uuid);
      showToast("Run cancelled");
      setShowCancelConfirm(false);
      await refreshIssueAndRun();
    } catch (err) {
      showToast("Failed to cancel run", "error");
    }
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
                  <button
                    class="btn btn-secondary"
                    onClick={() => handleRetrigger()}
                    disabled={run()?.last_state === "claimed"}
                    title={run()?.last_state === "claimed" ? "Already running" : "Retrigger this issue"}
                  >
                    ↻ Retrigger
                  </button>
                  <button class="btn btn-secondary" title="Retrigger with note" onClick={() => setShowRetriggerNote(true)}>
                    ↻+
                  </button>
                  <Show when={issue()!.state !== "done" && issue()!.state !== "cancelled"}>
                    <button
                      class="btn btn-secondary"
                      onClick={() => setShowCancelConfirm(true)}
                      disabled={run()?.last_state !== "claimed"}
                      title={run()?.last_state === "claimed" ? "Cancel running agent" : "No active run to cancel"}
                    >
                      ⏹ Cancel
                    </button>
                  </Show>
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

            <HandoffPanel issueUuid={params.uuid} issueState={issue()!.state} onActionComplete={refreshIssueAndRun} />

            <PlanReviewPanel
              issueUuid={params.uuid}
              issueState={issue()!.state}
              onAction={() => { load(); }}
            />

            <Show when={planRuns().length > 0}>
              <div class="issue-section">
                <h2 class="section-title">Plan Runs ({planRuns().length})</h2>
                <For each={planRuns()}>
                  {(pr) => (
                    <div class="plan-run-card">
                      <div class="plan-run-header">
                        <span class="plan-run-id">{pr.id}</span>
                        <span class={`pill ${pr.state}`}>{pr.state.replace("_", " ")}</span>
                      </div>
                      <Show when={pr.meta}>
                        <div class="plan-run-meta">
                          <span class="plan-run-name">
                            {(() => {
                              try { return JSON.parse(pr.meta).name ?? "Unnamed"; }
                              catch { return "Unnamed"; }
                            })()}
                          </span>
                        </div>
                      </Show>
                      <Show when={pr.dry_run_summary}>
                        <div class="plan-run-summary">
                          <details>
                            <summary>Dry-run summary</summary>
                            <pre class="plan-run-pre">{pr.dry_run_summary}</pre>
                          </details>
                        </div>
                      </Show>
                      <Show when={pr.result}>
                        <div class="plan-run-result">
                          <details>
                            <summary>Result</summary>
                            <pre class="plan-run-pre">{pr.result}</pre>
                          </details>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <ArtifactsPanel issueUuid={params.uuid} maxAttempt={run()?.next_attempt ? run()!.next_attempt - 1 : 0} />

            <div class="issue-section">
              <h2 class="section-title">Comments ({comments().length})</h2>
              <Show when={comments().length > 0}>
                <ul class="comments-list">
                  <For each={comments()}>
                    {(comment) => (
                      <li class="comment-card">
                        <div class="comment-header">
                          <span class="comment-author">{comment.author}</span>
                          <span class="comment-time">{formatTime(comment.ts)}</span>
                          <button class="btn-icon comment-delete" onClick={() => handleDeleteComment(comment.id)} title="Delete comment">×</button>
                        </div>
                        <div class="comment-body">{comment.body}</div>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <div class="comment-form">
                <textarea
                  class="comment-input"
                  placeholder="Add a comment..."
                  value={newComment()}
                  onInput={(e) => setNewComment(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAddComment(); }}
                />
                <button class="btn btn-secondary" onClick={handleAddComment} disabled={!newComment().trim()}>
                  Submit
                </button>
              </div>
            </div>

            <Show when={logs()}>
              <div class="issue-section">
                <h2 class="section-title">III. STAGE — Live transcript</h2>
                <LogViewer rawText={logs()} agentKind={issue()!.agent_kind} />
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
                            <EventBody kind={event.kind} payload={payload} />
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
              <div class="aside-value">
                <span class={`pill ${issue()!.state}`}>{issue()!.state.replace("_", " ")}</span>
              </div>
            </div>
            <div class="aside-field">
              <div class="aside-label">Priority</div>
              <div class="aside-value">{issue()!.priority}</div>
            </div>
            <div class="aside-field">
              <div class="aside-label">Agent</div>
              <div class="aside-value">{AGENT_DISPLAY_NAMES[issue()!.agent_kind ?? ""] ?? issue()!.agent_kind ?? "workflow default"}</div>
            </div>
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
                  <button
                    class="btn-icon"
                    onClick={() => api.revealWorkspace(params.uuid)}
                    title="Open in Finder"
                  >
                    ↗
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

      {/* Cancel Confirmation */}
      <Show when={showCancelConfirm()}>
        <div class="modal-backdrop" onClick={() => setShowCancelConfirm(false)}>
          <div class="modal modal-confirm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-chapter-mark"></div>
            <div class="modal-confirm-body">
              <h3 class="modal-confirm-title">FERMATA</h3>
              <p class="modal-confirm-message">Terminate the running process?</p>
            </div>
            <div class="modal-confirm-footer">
              <button class="btn btn-ghost" onClick={() => setShowCancelConfirm(false)}>
                Keep running
              </button>
              <button class="btn btn-danger" onClick={handleCancel}>
                Cancel Run
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Retrigger with Note Modal */}
      <Show when={showRetriggerNote()}>
        <div class="modal-backdrop" onClick={() => setShowRetriggerNote(false)}>
          <div class="modal modal-confirm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-chapter-mark"></div>
            <div class="modal-confirm-body">
              <h3 class="modal-confirm-title">Retrigger with note</h3>
              <textarea
                class="comment-input"
                placeholder="Add a note for the next attempt..."
                value={retriggerNote()}
                onInput={(e) => setRetriggerNote(e.currentTarget.value)}
                style="width: 100%; min-height: 80px;"
              />
            </div>
            <div class="modal-confirm-footer">
              <button class="btn btn-ghost" onClick={() => setShowRetriggerNote(false)}>
                Cancel
              </button>
              <button class="btn btn-secondary" onClick={() => handleRetrigger(retriggerNote())}>
                Retrigger
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
