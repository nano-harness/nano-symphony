import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { api, type Issue } from "./api";
import { IssueModal } from "./IssueModal";

export function Dashboard() {
  const navigate = useNavigate();
  const [issues, setIssues] = createSignal<Issue[]>([]);
  const [filter, setFilter] = createSignal("");
  const [stateFilter, setStateFilter] = createSignal<string>("ALL");
  const [showModal, setShowModal] = createSignal(false);
  const [editingIssue, setEditingIssue] = createSignal<Issue | null>(null);
  const [deletingId, setDeletingId] = createSignal<string | null>(null);
  const [toast, setToast] = createSignal<{ message: string; type: "success" | "error" } | null>(null);

  const load = async () => {
    setIssues(await api.listIssues());
  };

  onMount(() => {
    load();
    const es = api.streamEvents();
    es.addEventListener("message", () => load());
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

        <button class="btn" onClick={handleCreate}>
          + New Issue
        </button>
        <A href="/workflow" class="btn btn-secondary">
          Edit Workflow
        </A>
      </div>

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
