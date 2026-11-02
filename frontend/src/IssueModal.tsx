import { createSignal, createResource, For, Show } from "solid-js";
import { api, type Issue } from "./api";

interface IssueModalProps {
  issue?: Issue | null;
  onClose: () => void;
  onSave: () => void;
}

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  nano: "Nano",
  "claude-code": "Claude Code",
};

export function IssueModal(props: IssueModalProps) {
  const [health] = createResource(() => api.getHealth());
  const availableAgents = () => health()?.available_agents ?? [];
  const isEdit = () => !!props.issue;
  const [title, setTitle] = createSignal(props.issue?.title || "");
  const [description, setDescription] = createSignal(props.issue?.description || "");
  const [priority, setPriority] = createSignal(props.issue?.priority || "medium");
  const [state, setState] = createSignal(props.issue?.state || "todo");
  const [labels, setLabels] = createSignal((props.issue?.labels || []).join(", "));
  const [workspacePath, setWorkspacePath] = createSignal(props.issue?.workspace_path || "");
  const [agentKind, setAgentKind] = createSignal<string>(props.issue?.agent_kind ?? "");
  const [agentRole, setAgentRole] = createSignal<string>(props.issue?.agent_role ?? "");
  const [requirePlan, setRequirePlan] = createSignal<string>(
    props.issue?.require_plan === true ? "true"
      : props.issue?.require_plan === false ? "false"
      : ""
  );
  const [costBudget, setCostBudget] = createSignal(props.issue?.cost_budget_usd?.toString() ?? "");
  const [tokenBudget, setTokenBudget] = createSignal(props.issue?.token_budget?.toString() ?? "");
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
        agent_kind: agentKind() === "" ? null : (agentKind() as "nano" | "claude-code"),
        agent_role: agentRole().trim() || undefined,
        require_plan: requirePlan() === "" ? null : requirePlan() === "true",
        cost_budget_usd: costBudget().trim() === "" ? null : Number(costBudget()),
        token_budget: tokenBudget().trim() === "" ? null : Number(tokenBudget()),
        labels: labels()
          .split(",")
          .map((l) => l.trim())
          .filter((l) => l),
      };

      if (isEdit()) {
        await api.updateIssue(props.issue!.uuid, data);
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
                  <option value="backlog">Backlog</option>
                  <option value="todo">To Do</option>
                  <option value="planning">Planning</option>
                  <option value="plan_review">Plan Review</option>
                  <option value="in_progress">In Progress</option>
                  <option value="in_review">In Review</option>
                  <option value="done">Done</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            </div>

            <div class="form-row">
              <div class="form-field">
                <label class="form-label" for="agent_kind">
                  Agent
                </label>
                <select
                  id="agent_kind"
                  class="form-select"
                  value={agentKind()}
                  onChange={(e) => setAgentKind(e.currentTarget.value)}
                >
                  <option value="">Workflow default</option>
                  <For each={availableAgents()}>
                    {(kind) => (
                      <option value={kind}>
                        {AGENT_DISPLAY_NAMES[kind] ?? kind}
                      </option>
                    )}
                  </For>
                </select>
              </div>

              <div class="form-field">
                <label class="form-label" for="require_plan">
                  Planning
                </label>
                <select
                  id="require_plan"
                  class="form-select"
                  value={requirePlan()}
                  onChange={(e) => setRequirePlan(e.currentTarget.value)}
                >
                  <option value="">Workflow default</option>
                  <option value="true">Require plan</option>
                  <option value="false">Skip planning</option>
                </select>
              </div>
            </div>

            <div class="form-row">
              <div class="form-field">
                <label class="form-label" for="cost_budget">
                  Cost budget (USD)
                </label>
                <input
                  id="cost_budget"
                  type="number"
                  min="0"
                  step="0.01"
                  class="form-input"
                  value={costBudget()}
                  onInput={(e) => setCostBudget(e.currentTarget.value)}
                  placeholder="No limit"
                />
              </div>

              <div class="form-field">
                <label class="form-label" for="token_budget">
                  Token budget
                </label>
                <input
                  id="token_budget"
                  type="number"
                  min="0"
                  step="1"
                  class="form-input"
                  value={tokenBudget()}
                  onInput={(e) => setTokenBudget(e.currentTarget.value)}
                  placeholder="No limit"
                />
              </div>
            </div>

            <div class="form-field">
              <label class="form-label" for="agent_role">
                Agent role
              </label>
              <input
                id="agent_role"
                type="text"
                class="form-input"
                value={agentRole()}
                onInput={(e) => setAgentRole(e.currentTarget.value)}
                placeholder="e.g. planner, executor, reviewer"
              />
              <div class="form-hint">
                Selects a profile from workflow.agent.roles. Falls back to the default agent config.
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
