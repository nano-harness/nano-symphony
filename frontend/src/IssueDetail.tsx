import { createSignal, createEffect, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import { useParams, useNavigate, A } from "@solidjs/router";
import { api, type Issue, type SymphonyEvent, type SymphonyRun, type Comment, type PlanRun, type JournalEntry, type PlanRunNode, type LlmCall } from "./api";
import { IssueModal } from "./IssueModal";
import { HandoffPanel } from "./HandoffPanel";
import { PlanReviewPanel } from "./PlanReviewPanel";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { EventTimeline } from "./EventTimeline";
import { LogViewer } from "./LogViewer";
import { PlanRunCreator } from "./PlanRunCreator";

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
  const [allIssues, setAllIssues] = createSignal<Issue[]>([]);
  const [showAddBlocker, setShowAddBlocker] = createSignal(false);
  const [llmCalls, setLlmCalls] = createSignal<LlmCall[]>([]);
  const [relatedArtifacts, setRelatedArtifacts] = createSignal<Artifact[]>([]);
  const [showActualsForm, setShowActualsForm] = createSignal(false);
  const [actualTurns, setActualTurns] = createSignal("");
  const [actualFiles, setActualFiles] = createSignal("");
  const [actualComplexity, setActualComplexity] = createSignal<"" | "low" | "medium" | "high">("");

  const load = async () => {
    const [i, e, r, c, pr, llc, ra] = await Promise.all([
      api.getIssue(params.uuid),
      api.getEvents(),
      api.getRun(params.uuid).catch(() => null),
      api.listComments(params.uuid).catch(() => []),
      api.listPlanRuns(params.uuid).catch(() => []),
      api.getLlmCalls(params.uuid).catch(() => ({ issue_uuid: params.uuid, calls: [] })),
      api.getRelatedArtifacts(params.uuid).catch(() => ({ related_issue_uuids: [], artifacts: [] })),
    ]);
    setIssue(i);
    setEvents(e.filter((ev) => ev.issue_uuid === params.uuid).sort((a, b) => a.ts - b.ts));
    setRun(r);
    setComments(c);
    setPlanRuns(pr);
    setLlmCalls(llc.calls);
    setRelatedArtifacts(ra.artifacts);
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
          // Refresh issue/run state for any substantive event so the dashboard stays live
          if ([
            "started",
            "completed",
            "handoff",
            "abandoned",
            "retry_scheduled",
            "retrigger_requested",
            "state_transition_suggested",
            "result_emitted",
            "budget_exceeded",
            "plan_guard",
            "plan_run_spawned",
            "artifacts_collected",
            "semantics_override_rejected",
          ].includes(event.kind)) {
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

  const formatArtifactSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const planProgress = createMemo(() => {
    const json = issue()?.plan_progress_json;
    if (!json) return null;
    try {
      return JSON.parse(json) as { total: number; done: number; cancelled: number; blocked: number; in_progress: number; percent: number };
    } catch {
      return null;
    }
  });

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
                <span class="pill mono">{issue()!.identifier}</span>
                <span class={`pill ${issue()!.state}`}>{issue()!.state.replace("_", " ")}</span>
                <span class="pill">{issue()!.priority}</span>
                <Show when={issue()!.agent_role}>
                  <span class="pill role">role: {issue()!.agent_role}</span>
                </Show>
                <Show when={issue()!.state === "plan_review" && issue()!.labels.includes("plan-sub-task")}>
                  <span class="pill gate">⏸ gate</span>
                </Show>
                <Show when={issue()!.labels.length > 0}>
                  <For each={issue()!.labels}>
                    {(label) => <span class="pill">{label}</span>}
                  </For>
                </Show>
              </div>
            </div>

            <div class="issue-section">
              <div class="section-header">
                <h2 class="section-title">Blockers ({issue()!.blockers.length})</h2>
                <button
                  class="btn btn-secondary btn-small"
                  onClick={() => {
                    api.listIssues().then(setAllIssues).catch(() => {});
                    setShowAddBlocker(true);
                  }}
                >
                  + Add
                </button>
              </div>
              <Show when={issue()!.blockers.length > 0}>
                <ul class="blockers-list">
                  <For each={issue()!.blockers}>
                    {(b) => {
                      const blockerIssue = allIssues().find((i) => i.uuid === b.blocker_uuid);
                      return (
                        <li class="blocker-item">
                          <A href={`/issues/${b.blocker_uuid}`} class="blocker-link">
                            {blockerIssue ? `${blockerIssue.identifier}: ${blockerIssue.title}` : b.blocker_uuid}
                          </A>
                          <span class={`pill ${b.blocker_state}`}>{b.blocker_state.replace("_", " ")}</span>
                          <button
                            class="btn btn-icon btn-small"
                            title="Remove blocker"
                            onClick={() => api.removeBlocker(params.uuid, b.blocker_uuid).then(load).catch((err) => setToast({ message: err.message, type: "error" }))}
                          >
                            ×
                          </button>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </Show>
              <Show when={issue()!.blockers.length === 0}>
                <p style={{ "color": "var(--mute)", "font-size": "13px" }}>No blockers.</p>
              </Show>
              <Show when={showAddBlocker()}>
                <div class="blocker-add-form">
                  <select
                    class="form-select"
                    onChange={(e) => {
                      const uuid = e.currentTarget.value;
                      if (!uuid) return;
                      api.addBlocker(params.uuid, uuid).then(() => {
                        setShowAddBlocker(false);
                        load();
                      }).catch((err) => setToast({ message: err.message, type: "error" }));
                    }}
                  >
                    <option value="">Select an issue...</option>
                    <For each={allIssues().filter((i) => i.uuid !== params.uuid && !issue()!.blockers.some((b) => b.blocker_uuid === i.uuid))}>
                      {(i) => <option value={i.uuid}>{i.identifier}: {i.title}</option>}
                    </For>
                  </select>
                  <button class="btn btn-secondary btn-small" onClick={() => setShowAddBlocker(false)}>
                    Cancel
                  </button>
                </div>
              </Show>
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

            <Show when={issue()!.plan_estimates_json || issue()!.plan_actuals_json}>
              <div class="issue-section">
                <h2 class="section-title">Plan Estimates vs Actuals</h2>
                <div class="plan-estimates-actuals">
                  <For each={[
                    { key: "complexity", label: "Complexity", format: (v: unknown) => String(v) },
                    { key: "files_touched", label: "Files touched", format: (v: unknown) => String(v) },
                    { key: "estimated_turns", label: "Turns", format: (v: unknown) => String(v) },
                  ]}>
                    {(metric) => {
                      const estimates = issue()!.plan_estimates_json ? JSON.parse(issue()!.plan_estimates_json!) as Record<string, unknown> : {};
                      const actuals = issue()!.plan_actuals_json ? JSON.parse(issue()!.plan_actuals_json!) as Record<string, unknown> : {};
                      const estValue = estimates[metric.key];
                      const actValue = actuals[`actual_${metric.key === "estimated_turns" ? "turns" : metric.key === "files_touched" ? "files_touched" : "complexity"}`];
                      if (estValue === undefined && actValue === undefined) return null;
                      return (
                        <div class="estimate-actual-row">
                          <span class="estimate-actual-label">{metric.label}</span>
                          <span class="estimate-actual-value">Est: {estValue !== undefined ? metric.format(estValue) : "—"}</span>
                          <span class="estimate-actual-value">Act: {actValue !== undefined ? metric.format(actValue) : "—"}</span>
                        </div>
                      );
                    }}
                  </For>
                </div>
                <Show when={!["backlog", "planning", "plan_review"].includes(issue()!.state)}>
                  <button class="btn btn-secondary btn-small" onClick={() => setShowActualsForm((s) => !s)}>
                    {showActualsForm() ? "Cancel" : "Record actuals"}
                  </button>
                </Show>
                <Show when={showActualsForm()}>
                  <div class="actuals-form">
                    <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                      <label style="display: flex; flex-direction: column; gap: 4px;">
                        <span style="font-size: 12px; color: var(--mute);">Actual turns</span>
                        <input
                          class="form-input"
                          type="number"
                          min="0"
                          value={actualTurns()}
                          onInput={(e) => setActualTurns(e.currentTarget.value)}
                          style="width: 120px;"
                        />
                      </label>
                      <label style="display: flex; flex-direction: column; gap: 4px;">
                        <span style="font-size: 12px; color: var(--mute);">Actual files touched</span>
                        <input
                          class="form-input"
                          type="number"
                          min="0"
                          value={actualFiles()}
                          onInput={(e) => setActualFiles(e.currentTarget.value)}
                          style="width: 120px;"
                        />
                      </label>
                      <label style="display: flex; flex-direction: column; gap: 4px;">
                        <span style="font-size: 12px; color: var(--mute);">Actual complexity</span>
                        <select
                          class="form-input"
                          value={actualComplexity()}
                          onChange={(e) => setActualComplexity(e.currentTarget.value as "" | "low" | "medium" | "high")}
                          style="width: 120px;"
                        >
                          <option value="">—</option>
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                        </select>
                      </label>
                    </div>
                    <button
                      class="btn btn-primary btn-small"
                      onClick={() => {
                        const payload: { actual_turns?: number; actual_files_touched?: number; actual_complexity?: "low" | "medium" | "high" } = {};
                        const turns = actualTurns().trim();
                        if (turns !== "") payload.actual_turns = Number(turns);
                        const files = actualFiles().trim();
                        if (files !== "") payload.actual_files_touched = Number(files);
                        if (actualComplexity()) payload.actual_complexity = actualComplexity();
                        api.setPlanActuals(params.uuid, payload).then(() => {
                          setShowActualsForm(false);
                          load();
                        }).catch((err) => setToast({ message: err.message, type: "error" }));
                      }}
                    >
                      Save actuals
                    </button>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={planProgress()}>
              <div class="issue-section">
                <h2 class="section-title">Sub-issue Progress</h2>
                <div class="progress-bar">
                  <div
                    class="progress-bar-fill"
                    style={{ width: `${planProgress()!.percent}%` }}
                  />
                </div>
                <div class="progress-stats">
                  <span>{planProgress()!.done} done</span>
                  <span>{planProgress()!.in_progress} in progress</span>
                  <span>{planProgress()!.cancelled} cancelled</span>
                  <span>{planProgress()!.blocked} blocked</span>
                  <span>{planProgress()!.percent}%</span>
                </div>
              </div>
            </Show>

            <div class="issue-section">
              <h2 class="section-title">Plan Runs ({planRuns().length})</h2>
              <PlanRunCreator callerIssueUuid={params.uuid} onCreated={load} />
              <Show when={planRuns().length > 0}>
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
                      <Show when={pr.state === "awaiting_approval"}>
                        <div class="plan-run-actions">
                          <button
                            class="btn btn-primary btn-small"
                            onClick={() => api.approvePlanRun(pr.id).then(load).catch((err) => setToast({ message: err.message, type: "error" }))}
                          >
                            Approve
                          </button>
                          <button
                            class="btn btn-secondary btn-small"
                            onClick={() => {
                              const reason = window.prompt("Reject reason (optional):");
                              if (reason === null) return;
                              api.rejectPlanRun(pr.id, reason || undefined).then(load).catch((err) => setToast({ message: err.message, type: "error" }));
                            }}
                          >
                            Reject
                          </button>
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
                      <PlanRunNodes runId={pr.id} />
                      <PlanRunJournal runId={pr.id} />
                    </div>
                  )}
                </For>
              </Show>
              <Show when={planRuns().length === 0}>
                <p style={{ "color": "var(--mute)", "font-size": "13px" }}>No plan runs yet.</p>
              </Show>
            </div>

            <Show when={relatedArtifacts().length > 0}>
              <div class="issue-section">
                <h2 class="section-title">Related Artifacts</h2>
                <ul class="artifacts-list">
                  <For each={relatedArtifacts()}>
                    {(artifact) => (
                      <li class="artifact-row">
                        <A href={`/issues/${artifact.issue_uuid}`} class="artifact-header">
                          <span class={`artifact-kind ${artifact.kind}`}>{artifact.kind.replace(/_/g, " ")}</span>
                          <span class="artifact-label">{artifact.label ?? artifact.id}</span>
                          <span class="artifact-meta">
                            <span class="artifact-size">{formatArtifactSize(artifact.content_size)}</span>
                            <span class="artifact-attempt">attempt {artifact.attempt}</span>
                          </span>
                        </A>
                      </li>
                    )}
                  </For>
                </ul>
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

            <Show when={llmCalls().length > 0}>
              <div class="issue-section">
                <h2 class="section-title">LLM Calls ({llmCalls().length})</h2>
                <div class="handoff-metrics" style={{ "margin-bottom": "12px" }}>
                  {(() => {
                    const totalCost = llmCalls().reduce((sum, c) => sum + (c.cost_usd ?? 0), 0);
                    const totalTokens = llmCalls().reduce((sum, c) => sum + c.input_tokens + c.output_tokens, 0);
                    return (
                      <>
                        <span class="metric">${totalCost.toFixed(4)}</span>
                        <span class="metric">{totalTokens.toLocaleString()} tokens</span>
                      </>
                    );
                  })()}
                </div>
                <ul class="journal-list">
                  <For each={llmCalls()}>
                    {(call) => (
                      <li class="journal-entry">
                        <span class="journal-time">Attempt {call.attempt}</span>
                        <span class="journal-type">{call.provider}</span>
                        <span class="journal-title">
                          {call.model} · {call.input_tokens.toLocaleString()} in / {call.output_tokens.toLocaleString()} out
                          <Show when={call.cost_usd != null}>
                            · ${(call.cost_usd ?? 0).toFixed(4)}
                          </Show>
                          <Show when={call.duration_ms != null}>
                            · {(call.duration_ms ?? 0) / 1000}s
                          </Show>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>

            <div class="issue-section">
              <h2 class="section-title">II. EVENTS — ANDANTE / Performance log</h2>
              <Show when={events().length === 0}>
                <p style="color: var(--mute); font-size: 13px;">No events recorded yet.</p>
              </Show>
              <Show when={events().length > 0}>
                <EventTimeline events={events()} />
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

            <Show when={issue()!.cost_budget_usd != null || issue()!.token_budget != null}>
              <div class="aside-field">
                <div class="aside-label">Budget</div>
                <div class="aside-value" style="width: 100%;">
                  {(() => {
                    const totalCost = llmCalls().reduce((sum, c) => sum + (c.cost_usd ?? 0), 0);
                    const totalTokens = llmCalls().reduce((sum, c) => sum + c.input_tokens + c.output_tokens, 0);
                    return (
                      <>
                        <Show when={issue()!.cost_budget_usd != null}>
                          <div class="budget-row">
                            <span class="budget-label">Cost</span>
                            <div class="budget-bar">
                              <div
                                class={`budget-bar-fill ${totalCost > issue()!.cost_budget_usd! ? "exceeded" : ""}`}
                                style={{ width: `${Math.min(100, (totalCost / issue()!.cost_budget_usd!) * 100)}%` }}
                              />
                            </div>
                            <span class="budget-value">${totalCost.toFixed(2)} / ${issue()!.cost_budget_usd!.toFixed(2)}</span>
                          </div>
                        </Show>
                        <Show when={issue()!.token_budget != null}>
                          <div class="budget-row">
                            <span class="budget-label">Tokens</span>
                            <div class="budget-bar">
                              <div
                                class={`budget-bar-fill ${totalTokens > issue()!.token_budget! ? "exceeded" : ""}`}
                                style={{ width: `${Math.min(100, (totalTokens / issue()!.token_budget!) * 100)}%` }}
                              />
                            </div>
                            <span class="budget-value">{totalTokens.toLocaleString()} / {issue()!.token_budget!.toLocaleString()}</span>
                          </div>
                        </Show>
                      </>
                    );
                  })()}
                </div>
              </div>
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

function PlanRunJournal(props: { runId: string }) {
  const [entries, setEntries] = createSignal<JournalEntry[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const load = async () => {
    if (loaded()) return;
    try {
      const res = await api.getPlanRunJournal(props.runId);
      setEntries(res.entries);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString();

  const entryTitle = (entry: JournalEntry) => {
    switch (entry.type) {
      case "phase": return `Phase: ${entry.payload.title ?? entry.payload.msg ?? ""}`;
      case "issue_start": return `Start: ${entry.payload.key ?? entry.payload.prompt ?? ""}`;
      case "issue_done": return `Done: ${entry.payload.key ?? ""}`;
      case "issue_error": return `Error: ${entry.payload.key ?? ""}`;
      case "parallel_start": return "Parallel batch started";
      case "parallel_done": return "Parallel batch done";
      case "dag_start": return "DAG started";
      case "dag_done": return "DAG done";
      case "dag_error": return `DAG error: ${entry.payload.error ?? ""}`;
      case "log": return entry.payload.msg ?? "Log";
      default: return entry.type;
    }
  };

  return (
    <div class="plan-run-summary">
      <details onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) load(); }}>
        <summary>Journal</summary>
        <Show when={error()}>
          <p style={{ color: "var(--error)", "font-size": "12px" }}>{error()}</p>
        </Show>
        <Show when={!error() && entries().length === 0 && loaded()}>
          <p style={{ color: "var(--mute)", "font-size": "12px" }}>No journal entries yet.</p>
        </Show>
        <Show when={entries().length > 0}>
          <ul class="journal-list">
            <For each={entries()}>
              {(entry) => (
                <li class={`journal-entry journal-entry-${entry.type}`}>
                  <span class="journal-time">{formatTime(entry.ts)}</span>
                  <span class="journal-type">{entry.type}</span>
                  <span class="journal-title">{entryTitle(entry)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </details>
    </div>
  );
}

function PlanRunNodes(props: { runId: string }) {
  const [nodes, setNodes] = createSignal<PlanRunNode[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const load = async () => {
    if (loaded()) return;
    try {
      const res = await api.getPlanRunNodes(props.runId);
      setNodes(res.nodes);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const formatTime = (ts: number | null) => ts ? new Date(ts).toLocaleTimeString() : "—";

  return (
    <div class="plan-run-summary">
      <details onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) load(); }}>
        <summary>Nodes ({nodes().length})</summary>
        <Show when={error()}>
          <p style={{ color: "var(--error)", "font-size": "12px" }}>{error()}</p>
        </Show>
        <Show when={!error() && nodes().length === 0 && loaded()}>
          <p style={{ color: "var(--mute)", "font-size": "12px" }}>No node records yet.</p>
        </Show>
        <Show when={nodes().length > 0}>
          <ul class="journal-list">
            <For each={nodes()}>
              {(node) => (
                <li class={`journal-entry journal-entry-${node.state}`}>
                  <span class="journal-time">{formatTime(node.started_at)}</span>
                  <span class={`pill ${node.state}`}>{node.state}</span>
                  <span class="journal-title">{node.node_key}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </details>
    </div>
  );
}
