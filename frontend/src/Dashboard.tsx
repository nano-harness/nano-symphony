import { createSignal, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { api, type Issue, type Artifact } from "./api";
import { IssueModal } from "./IssueModal";

type ViewMode = "list" | "board";

const VIEW_STORAGE_KEY = "symphony.dashboardView";

const BOARD_COLUMNS: Array<{ state: string; label: string }> = [
  { state: "backlog",     label: "BACKLOG" },
  { state: "todo",        label: "TODO" },
  { state: "in_progress", label: "IN PROGRESS" },
  { state: "in_review",   label: "IN REVIEW" },
  { state: "done",        label: "DONE" },
  { state: "cancelled",   label: "CANCELLED" },
];

export function Dashboard() {
  const navigate = useNavigate();
  const [issues, setIssues] = createSignal<Issue[]>([]);
  const [filter, setFilter] = createSignal("");
  const [stateFilter, setStateFilter] = createSignal<string>("ALL");
  const [showModal, setShowModal] = createSignal(false);
  const [editingIssue, setEditingIssue] = createSignal<Issue | null>(null);
  const [deletingId, setDeletingId] = createSignal<string | null>(null);
  const [toast, setToast] = createSignal<{ message: string; type: "success" | "error" } | null>(null);
  const [recentArtifacts, setRecentArtifacts] = createSignal<Artifact[]>([]);
  const [artifactsCollapsed, setArtifactsCollapsed] = createSignal(true);

  const [viewMode, setViewModeRaw] = createSignal<ViewMode>(
    (() => {
      if (typeof localStorage === "undefined") return "list";
      const stored = localStorage.getItem(VIEW_STORAGE_KEY);
      return stored === "list" || stored === "board" ? stored : "list";
    })()
  );
  const setViewMode = (m: ViewMode) => {
    setViewModeRaw(m);
    try { localStorage.setItem(VIEW_STORAGE_KEY, m); } catch {}
  };

  const load = async () => {
    setIssues(await api.listIssues());
  };

  onMount(() => {
    load();
    api.listRecentArtifacts(10).then(setRecentArtifacts).catch(() => {});
    const es = api.streamEvents();
    es.addEventListener("message", (e) => {
      try {
        const event = JSON.parse(e.data);
        const visibleIds = new Set(issues().map((i) => i.id));
        // Reload if event affects visible issue or is a state change
        if (visibleIds.has(event.issue_id) || event.kind === "state_changed") {
          load();
        }
      } catch {
        // ignore parse errors
      }
    });
    es.addEventListener("run", (e) => {
      try {
        const runPatch = JSON.parse(e.data);
        const visibleIds = new Set(issues().map((i) => i.id));
        // Reload if run event affects visible issue
        if (visibleIds.has(runPatch.issue_id)) {
          load();
        }
      } catch {
        // ignore parse errors
      }
    });
    onCleanup(() => es.close());
  });

  const filtered = () => {
    let result = issues();

    // State filter
    if (stateFilter() !== "ALL") {
      result = result.filter((i) => i.state === stateFilter());
    }

    // Text filter
    const f = filter().toLowerCase();
    if (f) {
      result = result.filter(
        (i) =>
          i.title.toLowerCase().includes(f) ||
          i.description?.toLowerCase().includes(f)
      );
    }

    return result;
  };

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 1800);
  };

  const handleCreate = () => {
    setEditingIssue(null);
    setShowModal(true);
  };

  const handleEdit = (issue: Issue) => {
    setEditingIssue(issue);
    setShowModal(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteIssue(id);
      setDeletingId(null);
      await load();
      showToast("Movement removed");
    } catch (err) {
      showToast("Failed to delete issue", "error");
    }
  };

  const handleSave = async () => {
    await load();
    showToast(editingIssue() ? "Changes saved" : "Movement composed");
  };

  const confirmDelete = (id: string) => {
    setDeletingId(id);
  };

  return (
    <div class="page dashboard">
      <div class="page-header">
        <div class="eyebrow">I. ISSUES — ALLEGRO</div>
        <h1 class="page-title">The Score</h1>
      </div>

      <div class="dashboard-toolbar">
        <input
          type="text"
          class="search-input"
          placeholder="Filter..."
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />

        <div class="view-toggle" role="tablist" aria-label="Dashboard view">
          <button
            class="view-toggle-btn"
            classList={{ active: viewMode() === "list" }}
            onClick={() => setViewMode("list")}
            role="tab"
            aria-selected={viewMode() === "list"}
            title="List view"
          >≡ List</button>
          <button
            class="view-toggle-btn"
            classList={{ active: viewMode() === "board" }}
            onClick={() => setViewMode("board")}
            role="tab"
            aria-selected={viewMode() === "board"}
            title="Board view"
          >▦ Board</button>
        </div>

        <Show when={viewMode() === "list"}>
          <div class="state-chips">
            <For each={["ALL", "TODO", "ACTIVE", "REVIEW", "DONE", "BACKLOG"]}>
              {(chip) => (
                <button
                  class="state-chip"
                  classList={{
                    active: stateFilter() === chip ||
                      (chip === "ACTIVE" && stateFilter() === "in_progress") ||
                      (chip === "REVIEW" && stateFilter() === "in_review") ||
                      (chip === "TODO" && stateFilter() === "todo") ||
                      (chip === "DONE" && stateFilter() === "done") ||
                      (chip === "BACKLOG" && stateFilter() === "backlog")
                  }}
                  onClick={() => {
                    const map: Record<string, string> = {
                      ALL: "ALL",
                      TODO: "todo",
                      ACTIVE: "in_progress",
                      REVIEW: "in_review",
                      DONE: "done",
                      BACKLOG: "backlog",
                    };
                    setStateFilter(map[chip]);
                  }}
                >
                  {chip}
                </button>
              )}
            </For>
          </div>
        </Show>

        <button class="btn" onClick={handleCreate}>
          + New Issue
        </button>
        <A href="/workflow" class="btn btn-secondary">
          Edit Workflow
        </A>
      </div>

      <Show when={viewMode() === "list"}>
        <div class="score">
          <Show when={filtered().length === 0}>
            <div class="score-empty">
              <div class="score-empty-icon">𝄞</div>
              <div class="score-empty-text">A symphony begins with a single bar.</div>
              <div class="score-empty-hint">Create your first issue to start composing.</div>
            </div>
          </Show>

          <Show when={filtered().length > 0}>
            <div class="score-header">
              <div class="score-header-cell">№</div>
              <div class="score-header-cell">Movement</div>
              <div class="score-header-cell">State</div>
              <div class="score-header-cell">Priority</div>
              <div class="score-header-cell">Actions</div>
            </div>
            <ul class="score-list">
              <For each={filtered()}>
                {(issue, index) => (
                  <li
                    class="bar"
                    style={{ "animation-delay": `${index() * 28}ms` }}
                    onClick={() => navigate(`/issues/${issue.id}`)}
                  >
                    <div class="bar-num">{index() + 1}</div>
                    <div class="bar-title">{issue.title}</div>
                    <div class="bar-state">
                      <span class={`pill ${issue.state}`}>
                        {issue.state.replace("_", " ")}
                      </span>
                    </div>
                    <div class="bar-priority">
                      <span class={`priority-dot ${issue.priority}`}></span>
                      <span class="priority-text">{issue.priority}</span>
                    </div>
                    <div class="bar-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        class="icon-btn"
                        onClick={() => handleEdit(issue)}
                        title="Edit issue"
                      >
                        ✎
                      </button>
                      <button
                        class="icon-btn"
                        onClick={() => confirmDelete(issue.id)}
                        title="Delete issue"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>

      <Show when={viewMode() === "board"}>
        <BoardView
          issues={filtered()}
          onCardClick={(id) => navigate(`/issues/${id}`)}
          onEdit={handleEdit}
          onDelete={confirmDelete}
        />
      </Show>

      {/* Recent Artifacts */}
      <Show when={recentArtifacts().length > 0}>
        <section class="dashboard-section">
          <button
            type="button"
            class="section-title section-toggle"
            classList={{ collapsed: artifactsCollapsed() }}
            aria-expanded={!artifactsCollapsed()}
            onClick={() => setArtifactsCollapsed((v) => !v)}
          >
            <span class="section-toggle-caret">▾</span>
            <span>Recent Artifacts</span>
            <span class="section-toggle-count">{recentArtifacts().length}</span>
          </button>
          <Show when={!artifactsCollapsed()}>
            <ul class="artifacts-global-list">
              <For each={recentArtifacts()}>
                {(a) => (
                  <li class="artifact-global-row">
                    <A href={`/issues/${a.issue_id}`}>
                      <span class="artifact-label">{a.label ?? a.kind}</span>
                      <span class="artifact-meta">
                        <span class={`artifact-kind ${a.kind}`}>{a.kind.replace(/_/g, " ")}</span>
                        <span class="artifact-size">{a.content_size < 1024 ? `${a.content_size} B` : `${(a.content_size / 1024).toFixed(1)} KB`}</span>
                      </span>
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </Show>

      {/* Issue Modal */}
      <Show when={showModal()}>
        <IssueModal
          issue={editingIssue()}
          onClose={() => setShowModal(false)}
          onSave={handleSave}
        />
      </Show>

      {/* Delete Confirmation */}
      <Show when={deletingId()}>
        <div class="modal-backdrop" onClick={() => setDeletingId(null)}>
          <div class="modal modal-confirm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-chapter-mark"></div>
            <div class="modal-confirm-body">
              <h3 class="modal-confirm-title">CODA</h3>
              <p class="modal-confirm-message">Remove this movement?</p>
            </div>
            <div class="modal-confirm-footer">
              <button class="btn btn-ghost" onClick={() => setDeletingId(null)}>
                Cancel
              </button>
              <button class="btn btn-danger" onClick={() => handleDelete(deletingId()!)}>
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

function BoardView(props: {
  issues: Issue[];
  onCardClick: (id: string) => void;
  onEdit: (issue: Issue) => void;
  onDelete: (id: string) => void;
}) {
  const byState = createMemo(() => {
    const buckets: Record<string, Issue[]> = {};
    for (const col of BOARD_COLUMNS) buckets[col.state] = [];
    for (const i of props.issues) {
      if (buckets[i.state]) buckets[i.state].push(i);
    }
    return buckets;
  });

  return (
    <div class="board">
      <For each={BOARD_COLUMNS}>
        {(col) => (
          <div class="board-col" data-state={col.state}>
            <div class="board-col-header">
              <span class="board-col-label">{col.label}</span>
              <span class="board-col-count">{byState()[col.state].length}</span>
            </div>
            <div class="board-col-body">
              <Show
                when={byState()[col.state].length > 0}
                fallback={<div class="board-col-empty">— rest —</div>}
              >
                <For each={byState()[col.state]}>
                  {(issue) => (
                    <div
                      class="board-card"
                      onClick={() => props.onCardClick(issue.id)}
                    >
                      <div class="board-card-title">{issue.title}</div>
                      <div class="board-card-meta">
                        <span class={`priority-dot ${issue.priority}`}></span>
                        <span class="priority-text">{issue.priority}</span>
                      </div>
                      <div class="board-card-actions" onClick={(e) => e.stopPropagation()}>
                        <button class="icon-btn" onClick={() => props.onEdit(issue)} title="Edit">✎</button>
                        <button class="icon-btn" onClick={() => props.onDelete(issue.id)} title="Delete">×</button>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
