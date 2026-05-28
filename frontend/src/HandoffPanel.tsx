import { createSignal, Show, For, onMount } from "solid-js";
import { api } from "./api";

interface HandoffPanelProps {
  issueId: string;
  issueState: string;
}

export function HandoffPanel(props: HandoffPanelProps) {
  const [handoff, setHandoff] = createSignal<any>(null);
  const [loading, setLoading] = createSignal(false);
  const [showRequestChanges, setShowRequestChanges] = createSignal(false);
  const [reviewNote, setReviewNote] = createSignal("");

  onMount(async () => {
    if (props.issueState === "in_review" || props.issueState === "done") {
      try {
        const data = await api.getHandoff(props.issueId);
        setHandoff(data);
      } catch {
        // No handoff yet
      }
    }
  });

  const handleApprove = async () => {
    setLoading(true);
    try {
      await api.approveHandoff(props.issueId);
      window.location.reload();
    } catch (err) {
      alert("Failed to approve");
    } finally {
      setLoading(false);
    }
  };

  const handleRequestChanges = async () => {
    if (!reviewNote().trim()) {
      alert("Please provide review feedback");
      return;
    }
    setLoading(true);
    try {
      await api.requestChanges(props.issueId, reviewNote());
      window.location.reload();
    } catch (err) {
      alert("Failed to request changes");
    } finally {
      setLoading(false);
    }
  };

  const handleRevealWorkspace = async () => {
    try {
      const result = await api.revealWorkspace(props.issueId);
      console.log("Opened workspace:", result.path);
    } catch (err) {
      alert("Failed to open workspace");
    }
  };

  return (
    <Show when={handoff()}>
      <div class="handoff-panel">
        <div class="handoff-header">
          <h2 class="section-title">IV. HANDOFF — Review Required</h2>
        </div>

        {/* Summary Card */}
        <div class="handoff-card">
          <div class="handoff-card-header">
            <span class="handoff-label">Summary</span>
          </div>
          <p class="handoff-summary">{handoff()?.payload?.summary || handoff()?.message}</p>
          <Show when={handoff()?.payload?.metrics}>
            <div class="handoff-metrics">
              <Show when={handoff()?.payload?.metrics?.turns_used}>
                <span class="metric">Turns: {handoff()?.payload?.metrics?.turns_used}</span>
              </Show>
              <Show when={handoff()?.payload?.metrics?.files_touched}>
                <span class="metric">Files: {handoff()?.payload?.metrics?.files_touched}</span>
              </Show>
              <Show when={handoff()?.payload?.metrics?.tests_passed !== undefined}>
                <span class="metric">Tests: {handoff()?.payload?.metrics?.tests_passed} ✓ / {handoff()?.payload?.metrics?.tests_failed} ✗</span>
              </Show>
            </div>
          </Show>
        </div>

        {/* Workspace Changes */}
        <Show when={handoff()?.payload?.workspace_diff?.changes?.length > 0}>
          <div class="handoff-card">
            <div class="handoff-card-header">
              <span class="handoff-label">Changes</span>
            </div>
            <div class="handoff-changes">
              <p class="handoff-stat">{handoff()?.payload?.workspace_diff?.stat}</p>
              <ul class="file-list">
                <For each={handoff()?.payload?.workspace_diff?.changes}>
                  {(change: any) => (
                    <li class={`file-item file-${change.status}`}>
                      <span class="file-status">{change.status}</span>
                      <span class="file-path">{change.path}</span>
                      <span class="file-changes">+{change.additions} -{change.deletions}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </div>
        </Show>

        {/* Unified diff */}
        <Show when={handoff()?.payload?.workspace_diff?.diff_unified}>
          <div class="handoff-card">
            <div class="handoff-card-header">
              <span class="handoff-label">Diff</span>
              <Show when={handoff()?.payload?.workspace_diff?.diff_truncated}>
                <span class="handoff-warning">(truncated to 200KB)</span>
              </Show>
            </div>
            <pre class="diff-pane">
              <For each={handoff()?.payload?.workspace_diff?.diff_unified?.split("\n") || []}>
                {(line: string) => {
                  const cls = line.startsWith("+") && !line.startsWith("+++")
                    ? "add"
                    : line.startsWith("-") && !line.startsWith("---")
                    ? "del"
                    : line.startsWith("@@")
                    ? "hunk"
                    : line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")
                    ? "meta"
                    : "";
                  return <div class={`diff-line ${cls}`}>{line || " "}</div>;
                }}
              </For>
            </pre>
          </div>
        </Show>

        {/* Agent-declared Artifacts */}
        <Show when={handoff()?.payload?.artifacts?.length > 0}>
          <div class="handoff-card">
            <div class="handoff-card-header">
              <span class="handoff-label">Artifacts</span>
            </div>
            <ul class="artifact-list">
              <For each={handoff()?.payload?.artifacts}>
                {(artifact: any) => (
                  <li class="artifact-item">
                    <span class={`artifact-kind ${artifact.kind}`}>{artifact.kind.replace(/_/g, " ")}</span>
                    <span class="artifact-detail">{artifact.path || artifact.label || artifact.href}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>

        {/* Follow-ups */}
        <Show when={handoff()?.payload?.follow_ups?.length > 0}>
          <div class="handoff-card">
            <div class="handoff-card-header">
              <span class="handoff-label">Follow-ups</span>
            </div>
            <ul class="follow-up-list">
              <For each={handoff()?.payload?.follow_ups}>
                {(item: string) => <li class="follow-up-item">{item}</li>}
              </For>
            </ul>
          </div>
        </Show>

        {/* Review Actions */}
        <Show when={props.issueState === "in_review"}>
          <div class="handoff-actions">
            <button class="btn btn-secondary" onClick={handleRevealWorkspace} disabled={loading()}>
              📂 Open Workspace
            </button>
            <Show when={!showRequestChanges()}>
              <button class="btn" onClick={handleApprove} disabled={loading()}>
                ✓ Approve & Mark Done
              </button>
              <button class="btn btn-secondary" onClick={() => setShowRequestChanges(true)} disabled={loading()}>
                ✎ Request Changes
              </button>
            </Show>
          </div>
          <Show when={showRequestChanges()}>
            <div class="handoff-request-changes">
              <textarea
                class="form-textarea"
                placeholder="Describe what needs to be changed..."
                value={reviewNote()}
                onInput={(e) => setReviewNote(e.currentTarget.value)}
                rows={4}
              />
              <div class="handoff-actions">
                <button class="btn btn-ghost" onClick={() => setShowRequestChanges(false)} disabled={loading()}>
                  Cancel
                </button>
                <button class="btn" onClick={handleRequestChanges} disabled={loading()}>
                  Submit Review
                </button>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </Show>
  );
}
