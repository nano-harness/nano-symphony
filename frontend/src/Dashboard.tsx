import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { A } from "@solidjs/router";
import { api, type Issue } from "./api";

const STATES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"];
const PRIORITIES = ["urgent", "high", "medium", "low"];

const STATE_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

export function Dashboard() {
  const [issues, setIssues] = createSignal<Issue[]>([]);
  const [filter, setFilter] = createSignal("");
  const [draggedIssue, setDraggedIssue] = createSignal<Issue | null>(null);
  const [selectedIssue, setSelectedIssue] = createSignal<Issue | null>(null);
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [newIssueTitle, setNewIssueTitle] = createSignal("");
  const [newIssueDescription, setNewIssueDescription] = createSignal("");
  const [newIssuePriority, setNewIssuePriority] = createSignal("medium");
  const [newIssueState, setNewIssueState] = createSignal("backlog");

  const load = async () => { setIssues(await api.listIssues()); };

  onMount(() => {
    load();
    const es = api.streamEvents();
    es.addEventListener("message", () => load());
    onCleanup(() => es.close());
  });

  const filtered = () => {
    const f = filter().toLowerCase();
    return f
      ? issues().filter(i => i.title.toLowerCase().includes(f) || i.identifier.toLowerCase().includes(f))
      : issues();
  };

  const getIssuesByStateAndPriority = (state: string, priority: string) => {
    return filtered().filter(i => i.state === state && i.priority === priority);
  };

  const handleDragStart = (e: DragEvent, issue: Issue) => {
    setDraggedIssue(issue);
    e.dataTransfer!.effectAllowed = "move";
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
  };

  const handleDrop = async (e: DragEvent, targetState: string) => {
    e.preventDefault();
    const issue = draggedIssue();
    if (issue && issue.state !== targetState) {
      await api.updateIssue(issue.id, { state: targetState });
      await load();
    }
    setDraggedIssue(null);
  };

  const handleCreateIssue = async () => {
    if (!newIssueTitle().trim()) return;
    await api.createIssue({
      title: newIssueTitle(),
      description: newIssueDescription() || null,
      priority: newIssuePriority(),
      state: newIssueState(),
    });
    setNewIssueTitle("");
    setNewIssueDescription("");
    setNewIssuePriority("medium");
    setNewIssueState("backlog");
    setShowCreateDialog(false);
    await load();
  };

  return (
    <div style="padding:24px;font-family:system-ui;height:100vh;display:flex;flex-direction:column">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h1 style="margin:0">Issues</h1>
        <div style="display:flex;gap:12px;align-items:center">
          <input
            placeholder="Filter..."
            value={filter()}
            onInput={e => setFilter(e.currentTarget.value)}
            style="padding:8px;border:1px solid #cbd5e1;border-radius:4px"
          />
          <button
            onClick={() => setShowCreateDialog(true)}
            style="padding:8px 16px;background:#3b82f6;color:white;border:none;border-radius:4px;cursor:pointer"
          >
            + New Issue
          </button>
          <A href="/workflow" style="padding:8px 16px;background:#64748b;color:white;text-decoration:none;border-radius:4px">
            Edit Workflow
          </A>
        </div>
      </div>

      <div style="flex:1;overflow:auto;border:1px solid #e2e8f0;border-radius:8px">
        <table style="width:100%;border-collapse:collapse;table-layout:fixed">
          <thead>
            <tr style="background:#f8fafc;position:sticky;top:0;z-index:10">
              <th style="width:100px;padding:12px;text-align:left;border-right:1px solid #e2e8f0;border-bottom:2px solid #cbd5e1;font-weight:600">Priority</th>
              <For each={STATES}>
                {state => (
                  <th style="padding:12px;text-align:center;border-right:1px solid #e2e8f0;border-bottom:2px solid #cbd5e1;font-weight:600">
                    {STATE_LABELS[state] || state}
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={PRIORITIES}>
              {priority => (
                <tr>
                  <td style="padding:12px;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;font-weight:500;text-transform:capitalize;background:#f8fafc">
                    {priority}
                  </td>
                  <For each={STATES}>
                    {state => (
                      <td
                        style="padding:8px;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;vertical-align:top;background:white"
                        onDragOver={handleDragOver}
                        onDrop={(e) => handleDrop(e, state)}
                      >
                        <div style="display:flex;flex-direction:column;gap:6px;min-height:60px">
                          <For each={getIssuesByStateAndPriority(state, priority)}>
                            {issue => (
                              <div
                                draggable
                                onDragStart={(e) => handleDragStart(e, issue)}
                                onClick={() => setSelectedIssue(issue)}
                                style="padding:8px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:4px;cursor:pointer;font-size:12px"
                                onMouseEnter={(e) => e.currentTarget.style.background = "#e2e8f0"}
                                onMouseLeave={(e) => e.currentTarget.style.background = "#f1f5f9"}
                              >
                                <div style="font-family:monospace;font-weight:600;color:#475569">{issue.identifier}</div>
                                <div style="margin-top:4px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                                  {issue.title}
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>

      {/* Detail Slide-in Panel */}
      <Show when={selectedIssue()}>
        <div
          style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:100"
          onClick={() => setSelectedIssue(null)}
        >
          <div
            style="position:absolute;right:0;top:0;bottom:0;width:500px;background:white;box-shadow:-2px 0 10px rgba(0,0,0,0.1);padding:24px;overflow:auto"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setSelectedIssue(null)}
              style="position:absolute;top:16px;right:16px;background:transparent;border:none;font-size:24px;cursor:pointer;color:#64748b"
            >
              ×
            </button>
            <div style="font-family:monospace;color:#64748b;margin-bottom:8px">{selectedIssue()!.identifier}</div>
            <h2 style="margin:0 0 16px 0">{selectedIssue()!.title}</h2>
            <div style="display:flex;gap:12px;margin-bottom:16px">
              <span style="padding:4px 8px;background:#f1f5f9;border-radius:4px;font-size:12px;text-transform:capitalize">
                {selectedIssue()!.priority}
              </span>
              <span style="padding:4px 8px;background:#f1f5f9;border-radius:4px;font-size:12px">
                {STATE_LABELS[selectedIssue()!.state] || selectedIssue()!.state}
              </span>
            </div>
            <Show when={selectedIssue()!.description}>
              <div style="margin-bottom:16px;color:#475569;white-space:pre-wrap">{selectedIssue()!.description}</div>
            </Show>
            <div style="margin-top:24px">
              <A
                href={`/issues/${selectedIssue()!.id}`}
                style="display:inline-block;padding:8px 16px;background:#3b82f6;color:white;text-decoration:none;border-radius:4px"
              >
                View Full Details
              </A>
            </div>
          </div>
        </div>
      </Show>

      {/* Create Issue Dialog */}
      <Show when={showCreateDialog()}>
        <div
          style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center"
          onClick={() => setShowCreateDialog(false)}
        >
          <div
            style="background:white;border-radius:8px;padding:24px;width:500px;max-width:90%"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style="margin:0 0 16px 0">Create New Issue</h2>
            <div style="display:flex;flex-direction:column;gap:12px">
              <div>
                <label style="display:block;margin-bottom:4px;font-weight:500">Title</label>
                <input
                  type="text"
                  value={newIssueTitle()}
                  onInput={(e) => setNewIssueTitle(e.currentTarget.value)}
                  style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:4px"
                  placeholder="Issue title..."
                />
              </div>
              <div>
                <label style="display:block;margin-bottom:4px;font-weight:500">Description</label>
                <textarea
                  value={newIssueDescription()}
                  onInput={(e) => setNewIssueDescription(e.currentTarget.value)}
                  style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:4px;min-height:100px;resize:vertical"
                  placeholder="Issue description..."
                />
              </div>
              <div style="display:flex;gap:12px">
                <div style="flex:1">
                  <label style="display:block;margin-bottom:4px;font-weight:500">Priority</label>
                  <select
                    value={newIssuePriority()}
                    onChange={(e) => setNewIssuePriority(e.currentTarget.value)}
                    style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:4px"
                  >
                    <For each={PRIORITIES}>
                      {priority => <option value={priority}>{priority}</option>}
                    </For>
                  </select>
                </div>
                <div style="flex:1">
                  <label style="display:block;margin-bottom:4px;font-weight:500">State</label>
                  <select
                    value={newIssueState()}
                    onChange={(e) => setNewIssueState(e.currentTarget.value)}
                    style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:4px"
                  >
                    <For each={STATES}>
                      {state => <option value={state}>{STATE_LABELS[state] || state}</option>}
                    </For>
                  </select>
                </div>
              </div>
              <div style="display:flex;gap:12px;margin-top:8px">
                <button
                  onClick={handleCreateIssue}
                  style="flex:1;padding:10px;background:#3b82f6;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:500"
                >
                  Create Issue
                </button>
                <button
                  onClick={() => setShowCreateDialog(false)}
                  style="flex:1;padding:10px;background:#e2e8f0;color:#475569;border:none;border-radius:4px;cursor:pointer;font-weight:500"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
