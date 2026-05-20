import { createSignal, Show } from "solid-js";
import { api, type Issue } from "./api";

interface IssueModalProps {
  issue?: Issue | null;
  onClose: () => void;
  onSave: () => void;
}

export function IssueModal(props: IssueModalProps) {
  const isEdit = () => !!props.issue;
  const [title, setTitle] = createSignal(props.issue?.title || "");
  const [description, setDescription] = createSignal(props.issue?.description || "");
  const [priority, setPriority] = createSignal(props.issue?.priority || "medium");
  const [state, setState] = createSignal(props.issue?.state || "todo");
  const [labels, setLabels] = createSignal((props.issue?.labels || []).join(", "));
  const [workspacePath, setWorkspacePath] = createSignal(props.issue?.workspace_path || "");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [touched, setTouched] = createSignal({ title: false });

  const titleValid = () => title().trim() !== "";
  const isValid = () => titleValid();

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    // Mark all fields as touched on submit
    setTouched({ title: true });

    if (!isValid()) {
      setError("Please fix validation errors");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const data: Partial<Issue> = {
        title: title().trim(),
        description: description().trim() || undefined,
        priority: priority(),
        state: state(),
        workspace_path: workspacePath().trim() || undefined,
        labels: labels()
          .split(",")
          .map((l) => l.trim())
          .filter((l) => l),
      };

      if (isEdit()) {
        await api.updateIssue(props.issue!.id, data);
      } else {
        await api.createIssue(data);
      }

      props.onSave();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save issue");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      props.onClose();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleSubmit(e);
    }
  };

  return (
    <div class="modal-backdrop" onClick={props.onClose} onKeyDown={handleKeyDown}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-chapter-mark"></div>
        <div class="modal-header">
          <div class="modal-eyebrow">
            {isEdit() ? "RE-SCORE / Edit movement" : "NEW MOVEMENT / Compose an issue"}
          </div>
          <h2 class="modal-title">{isEdit() ? "Edit Movement" : "Compose"}</h2>
        </div>
        <form onSubmit={handleSubmit}>
          <div class="modal-body">
            <div class="form-field">
              <label class="form-label" for="title">
                Title
              </label>
              <input
                id="title"
                type="text"
                class="form-input"
                value={title()}
                onInput={(e) => setTitle(e.currentTarget.value)}
                onBlur={() => setTouched((t) => ({ ...t, title: true }))}
                placeholder="Issue title..."
                required
                autofocus
              />
              <Show when={touched().title && !titleValid()}>
                <div class="form-field-error">Title is required</div>
              </Show>
            </div>

            <div class="form-field">
              <label class="form-label" for="description">
                Notes
              </label>
              <textarea
                id="description"
                class="form-textarea"
                value={description()}
                onInput={(e) => setDescription(e.currentTarget.value)}
                placeholder="Detailed description..."
              />
            </div>

            <div class="form-row">
              <div class="form-field">
                <label class="form-label" for="priority">
                  Priority
                </label>
                <select
                  id="priority"
                  class="form-select"
                  value={priority()}
                  onChange={(e) => setPriority(e.currentTarget.value)}
                >
                  <option value="urgent">Urgent</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>

              <div class="form-field">
                <label class="form-label" for="state">
                  State
                </label>
                <select
                  id="state"
                  class="form-select"
                  value={state()}
                  onChange={(e) => setState(e.currentTarget.value)}
                >
                  <option value="todo">To Do</option>
                  <option value="in_progress">In Progress</option>
                  <option value="in_review">In Review</option>
                  <option value="done">Done</option>
                  <option value="backlog">Backlog</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            </div>

            <div class="form-field">
              <label class="form-label" for="labels">
                Labels (comma-separated)
              </label>
              <input
                id="labels"
                type="text"
                class="form-input"
                value={labels()}
                onInput={(e) => setLabels(e.currentTarget.value)}
                placeholder="bug, feature, urgent"
              />
            </div>

            <details class="form-advanced" open={!!workspacePath()}>
              <summary class="form-advanced-summary">Advanced settings</summary>
              <div class="form-field">
                <label class="form-label" for="workspace_path">
                  Workspace path
                </label>
                <input
                  id="workspace_path"
                  type="text"
                  class="form-input"
                  value={workspacePath()}
                  onInput={(e) => setWorkspacePath(e.currentTarget.value)}
                  placeholder="Default: managed under ./workspaces/"
                />
                <div class="form-hint">
                  Leave empty to let symphony manage a workspace under <code>./workspaces/</code>.
                  Paste a path that already exists (e.g. a vwsd mountpoint, a git worktree)
                  to use it directly. <strong>Symphony will not delete external paths.</strong>
                </div>
              </div>
            </details>

            <Show when={error()}>
              <div class="form-error">{error()}</div>
            </Show>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" onClick={props.onClose} disabled={loading()}>
              Cancel
            </button>
            <button type="submit" class="btn" disabled={loading() || !isValid()}>
              {loading() ? "Saving..." : isEdit() ? "Save Changes" : "Create Issue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
