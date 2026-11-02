import { createSignal, Show, onMount, For } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import remarkGfm from "remark-gfm";
import { api, type PlanDiff, type PlanGraph, type PlanHistoryEntry } from "./api";

interface PlanReviewPanelProps {
  issueUuid: string;
  issueState: string;
  onAction?: () => void;
}

interface PlanPayload {
  markdown?: string;
  revision?: number;
  estimates?: {
    files_touched?: number;
    complexity?: string;
    estimated_turns?: number;
  };
}

export function PlanReviewPanel(props: PlanReviewPanelProps) {
  const [plan, setPlan] = createSignal<PlanPayload | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [showRevise, setShowRevise] = createSignal(false);
  const [reviseNote, setReviseNote] = createSignal("");
  const [reviseCategory, setReviseCategory] = createSignal<"scope" | "approach" | "estimate" | "missing_tests" | "other">("scope");
  const [reviseSeverity, setReviseSeverity] = createSignal<"minor" | "major" | "blocking">("major");
  const [reviseMustFix, setReviseMustFix] = createSignal("");
  const [history, setHistory] = createSignal<PlanHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = createSignal(false);
  const [diffFrom, setDiffFrom] = createSignal<number | null>(null);
  const [diffTo, setDiffTo] = createSignal<number | null>(null);
  const [diffResult, setDiffResult] = createSignal<PlanDiff | null>(null);
  const [diffLoading, setDiffLoading] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<"plan" | "graph">("plan");
  const [graph, setGraph] = createSignal<PlanGraph | null>(null);
  const [graphLoading, setGraphLoading] = createSignal(false);

  const loadGraph = async () => {
    if (graph() || graphLoading()) return;
    setGraphLoading(true);
    try {
      const g = await api.getPlanGraph(props.issueUuid);
      setGraph(g);
    } catch {
      // No graph yet
    } finally {
      setGraphLoading(false);
    }
  };

  onMount(async () => {
    try {
      const result = await api.getPlan(props.issueUuid);
      if (result) setPlan(result.payload);
      const hist = await api.getPlanHistory(props.issueUuid);
      setHistory(hist.history);
    } catch {
      // No plan yet
    }
  });

  const handleApprove = async () => {
    setLoading(true);
    try {
      await api.approvePlan(props.issueUuid);
      props.onAction?.();
    } catch (err) {
      alert(`Failed to approve plan: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleRevise = async () => {
    if (!reviseNote().trim()) {
      alert("Please provide revision feedback");
      return;
    }
    const mustFixLines = reviseMustFix()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const feedback = {
      category: reviseCategory(),
      severity: reviseSeverity(),
      must_fix: mustFixLines.length > 0 ? mustFixLines : undefined,
    };
    setLoading(true);
    try {
      await api.revisePlan(props.issueUuid, reviseNote(), feedback);
      props.onAction?.();
    } catch (err) {
      alert(`Failed to request plan revision: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const loadDiff = async () => {
    const from = diffFrom();
    const to = diffTo();
    if (from === null || to === null || from === to) {
      setDiffResult(null);
      return;
    }
    setDiffLoading(true);
    try {
      const diff = await api.getPlanDiff(props.issueUuid, from, to);
      setDiffResult(diff);
    } catch (err) {
      alert(`Failed to load diff: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDiffLoading(false);
    }
  };

  const selectRevisionsForDiff = (from: number, to: number) => {
    setDiffFrom(from);
    setDiffTo(to);
    setShowHistory(true);
    void loadDiff();
  };

  return (
    <Show when={plan() || props.issueState === "planning"}>
      <div class="handoff-panel">
        <div class="handoff-header">
          <h2 class="section-title">
            {props.issueState === "planning"
              ? "⏳ Planning in progress..."
              : props.issueState === "plan_review"
              ? "📋 Implementation Plan — Review Required"
              : "📋 Implementation Plan"}
          </h2>
          <Show when={(plan()?.revision ?? 0) > 0}>
            <span class="pill" style="font-size: 11px;">Revision {plan()!.revision}</span>
          </Show>
        </div>

        <Show when={props.issueState === "planning" && !plan()}>
          <div class="handoff-card">
            <p style="color: var(--mute); font-size: 13px;">
              Agent is analyzing the issue and generating an implementation plan…
            </p>
          </div>
        </Show>

        <Show when={history().length > 1}>
          <div class="handoff-card">
            <div class="handoff-card-header" style={{ cursor: "pointer" }} onClick={() => setShowHistory((s) => !s)}>
              <span class="handoff-label">History ({history().length} revisions)</span>
              <span style="color: var(--mute); font-size: 12px;">{showHistory() ? "▲" : "▼"}</span>
            </div>
            <Show when={showHistory()}>
              <div style="margin-top: 12px;">
                <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px;">
                  <select
                    class="form-input"
                    style="min-width: 120px;"
                    value={diffFrom() ?? ""}
                    onChange={(e) => setDiffFrom(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
                  >
                    <option value="">From revision</option>
                    <For each={history()}>
                      {(h) => <option value={h.revision}>Revision {h.revision}</option>}
                    </For>
                  </select>
                  <select
                    class="form-input"
                    style="min-width: 120px;"
                    value={diffTo() ?? ""}
                    onChange={(e) => setDiffTo(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
                  >
                    <option value="">To revision</option>
                    <For each={history()}>
                      {(h) => <option value={h.revision}>Revision {h.revision}</option>}
                    </For>
                  </select>
                  <button class="btn btn-secondary" onClick={loadDiff} disabled={diffLoading()}>
                    Compare
                  </button>
                </div>

                <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
                  <For each={history().slice(1)}>
                    {(h) => (
                      <button
                        class="btn btn-ghost"
                        style="font-size: 12px; padding: 4px 8px;"
                        onClick={() => selectRevisionsForDiff(history().find((x) => x.revision === h.revision - 1)?.revision ?? h.revision - 1, h.revision)}
                      >
                        Diff r{h.revision - 1}→r{h.revision}
                      </button>
                    )}
                  </For>
                </div>

                <Show when={diffResult()}>
                  <div class="plan-diff">
                    <div style="font-size: 12px; color: var(--mute); margin-bottom: 8px;">
                      Diff revision {diffResult()!.from_revision} → {diffResult()!.to_revision}
                    </div>

                    <Show when={diffResult()!.markdown.hunks.length > 0}>
                      <div class="plan-diff-section">
                        <div class="plan-diff-title">Markdown</div>
                        <For each={diffResult()!.markdown.hunks}>
                          {(hunk) => (
                            <div class="plan-diff-hunk">
                              <div class="plan-diff-hunk-header">
                                @@ -{hunk.oldStart} +{hunk.newStart} @@
                              </div>
                              <For each={hunk.lines}>
                                {(line) => (
                                  <div class={`plan-diff-line ${line.kind}`}>
                                    <span class="plan-diff-marker">
                                      {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
                                    </span>
                                    <span class="plan-diff-text">{line.text}</span>
                                  </div>
                                )}
                              </For>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>

                    <Show when={diffResult()!.steps.added.length > 0 || diffResult()!.steps.removed.length > 0 || diffResult()!.steps.changed.length > 0}>
                      <div class="plan-diff-section">
                        <div class="plan-diff-title">Steps</div>
                        <For each={diffResult()!.steps.added}>
                          {(step) => (
                            <div class="plan-diff-line added">
                              <span class="plan-diff-marker">+</span>
                              <span class="plan-diff-text">{step.id}: {step.title}</span>
                            </div>
                          )}
                        </For>
                        <For each={diffResult()!.steps.removed}>
                          {(step) => (
                            <div class="plan-diff-line removed">
                              <span class="plan-diff-marker">-</span>
                              <span class="plan-diff-text">{step.id}: {step.title}</span>
                            </div>
                          )}
                        </For>
                        <For each={diffResult()!.steps.changed}>
                          {(change) => (
                            <div class="plan-diff-step-change">
                              <div style="font-size: 12px; color: var(--mute); margin-bottom: 4px;">
                                {change.from.id} ({change.changedFields.join(", ")})
                              </div>
                              <Show when={change.changedFields.includes("title")}>
                                <div class="plan-diff-line removed">
                                  <span class="plan-diff-marker">-</span>
                                  <span class="plan-diff-text">{change.from.title}</span>
                                </div>
                                <div class="plan-diff-line added">
                                  <span class="plan-diff-marker">+</span>
                                  <span class="plan-diff-text">{change.to.title}</span>
                                </div>
                              </Show>
                              <Show when={change.changedFields.includes("description")}>
                                <div class="plan-diff-line removed">
                                  <span class="plan-diff-marker">-</span>
                                  <span class="plan-diff-text">{change.from.description || "(no description)"}</span>
                                </div>
                                <div class="plan-diff-line added">
                                  <span class="plan-diff-marker">+</span>
                                  <span class="plan-diff-text">{change.to.description || "(no description)"}</span>
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>

                    <Show when={Object.keys(diffResult()!.estimates.added).length > 0 || Object.keys(diffResult()!.estimates.removed).length > 0 || Object.keys(diffResult()!.estimates.changed).length > 0}>
                      <div class="plan-diff-section">
                        <div class="plan-diff-title">Estimates</div>
                        <For each={Object.entries(diffResult()!.estimates.added)}>
                          {([key, value]) => (
                            <div class="plan-diff-line added">
                              <span class="plan-diff-marker">+</span>
                              <span class="plan-diff-text">{key}: {JSON.stringify(value)}</span>
                            </div>
                          )}
                        </For>
                        <For each={Object.entries(diffResult()!.estimates.removed)}>
                          {([key, value]) => (
                            <div class="plan-diff-line removed">
                              <span class="plan-diff-marker">-</span>
                              <span class="plan-diff-text">{key}: {JSON.stringify(value)}</span>
                            </div>
                          )}
                        </For>
                        <For each={Object.entries(diffResult()!.estimates.changed)}>
                          {([key, change]) => (
                            <div class="plan-diff-step-change">
                              <div style="font-size: 12px; color: var(--mute); margin-bottom: 4px;">{key}</div>
                              <div class="plan-diff-line removed">
                                <span class="plan-diff-marker">-</span>
                                <span class="plan-diff-text">{JSON.stringify(change.from)}</span>
                              </div>
                              <div class="plan-diff-line added">
                                <span class="plan-diff-marker">+</span>
                                <span class="plan-diff-text">{JSON.stringify(change.to)}</span>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={plan()?.markdown}>
          <div class="plan-tabs">
            <button
              class={`plan-tab ${activeTab() === "plan" ? "active" : ""}`}
              onClick={() => setActiveTab("plan")}
            >
              Plan
            </button>
            <button
              class={`plan-tab ${activeTab() === "graph" ? "active" : ""}`}
              onClick={() => { setActiveTab("graph"); void loadGraph(); }}
            >
              Graph
            </button>
          </div>
        </Show>

        <Show when={activeTab() === "graph"}>
          <div class="handoff-card">
            <div class="handoff-card-header">
              <span class="handoff-label">Dependency Graph</span>
            </div>
            <Show when={graphLoading()}>
              <p style="color: var(--mute); font-size: 13px;">Loading graph…</p>
            </Show>
            <Show when={!graphLoading() && graph()}>
              <Show when={!graph()!.ok}>
                <div class="plan-graph-error">{graph()!.error}</div>
              </Show>
              <Show when={graph()!.ok}>
                <div class="plan-graph">
                  <For each={graph()!.layers}>
                    {(layer) => (
                      <div class="plan-graph-layer">
                        <For each={layer}>
                          {(nodeId) => {
                            const node = graph()!.nodes.find((n) => n.id === nodeId);
                            return (
                              <div class="plan-graph-node">
                                <div class="plan-graph-node-title">{node?.title ?? nodeId}</div>
                                <Show when={node?.description}>
                                  <div class="plan-graph-node-desc">{node!.description}</div>
                                </Show>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
                <Show when={graph()!.edges.length > 0}>
                  <div class="plan-graph-edges">
                    <For each={graph()!.edges}>
                      {(edge) => (
                        <div class="plan-graph-edge">{edge.from} → {edge.to}</div>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
          </div>
        </Show>

        <Show when={activeTab() === "plan" && plan()?.markdown}>
          <div class="handoff-card">
            <div class="handoff-card-header">
              <span class="handoff-label">Plan</span>
              <Show when={plan()?.estimates}>
                <div style="display: flex; gap: 8px; font-size: 11px; color: var(--mute);">
                  <Show when={plan()!.estimates!.complexity}>
                    <span class="pill">Complexity: {plan()!.estimates!.complexity}</span>
                  </Show>
                  <Show when={plan()!.estimates!.files_touched !== undefined}>
                    <span class="pill">~{plan()!.estimates!.files_touched} files</span>
                  </Show>
                  <Show when={plan()!.estimates!.estimated_turns !== undefined}>
                    <span class="pill">~{plan()!.estimates!.estimated_turns} turns</span>
                  </Show>
                </div>
              </Show>
            </div>
            <div class="event-body-markdown markdown-body">
              <SolidMarkdown
                children={plan()!.markdown!}
                remarkPlugins={[remarkGfm]}
              />
            </div>
          </div>
        </Show>

        <Show when={props.issueState === "plan_review"}>
          <div class="handoff-actions">
            <Show when={!showRevise()}>
              <button class="btn" onClick={handleApprove} disabled={loading()}>
                ✓ Approve Plan
              </button>
              <button class="btn btn-secondary" onClick={() => setShowRevise(true)} disabled={loading()}>
                ✎ Request Changes
              </button>
            </Show>
          </div>
          <Show when={showRevise()}>
            <div class="handoff-request-changes">
              <div style="display: grid; gap: 12px; margin-bottom: 12px;">
                <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                  <label style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 140px;">
                    <span style="font-size: 12px; color: var(--mute);">Category</span>
                    <select
                      class="form-input"
                      value={reviseCategory()}
                      onChange={(e) => setReviseCategory(e.currentTarget.value as typeof reviseCategory extends () => infer T ? T : never)}
                    >
                      <option value="scope">Scope</option>
                      <option value="approach">Approach</option>
                      <option value="estimate">Estimate</option>
                      <option value="missing_tests">Missing tests</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 140px;">
                    <span style="font-size: 12px; color: var(--mute);">Severity</span>
                    <select
                      class="form-input"
                      value={reviseSeverity()}
                      onChange={(e) => setReviseSeverity(e.currentTarget.value as typeof reviseSeverity extends () => infer T ? T : never)}
                    >
                      <option value="minor">Minor</option>
                      <option value="major">Major</option>
                      <option value="blocking">Blocking</option>
                    </select>
                  </label>
                </div>
                <label style="display: flex; flex-direction: column; gap: 4px;">
                  <span style="font-size: 12px; color: var(--mute);">Must fix (one per line)</span>
                  <textarea
                    class="form-textarea"
                    placeholder="- Add unit tests&#10;- Reduce scope to MVP"
                    value={reviseMustFix()}
                    onInput={(e) => setReviseMustFix(e.currentTarget.value)}
                    rows={3}
                  />
                </label>
                <textarea
                  class="form-textarea"
                  placeholder="Describe what needs to be changed in the plan..."
                  value={reviseNote()}
                  onInput={(e) => setReviseNote(e.currentTarget.value)}
                  rows={4}
                />
              </div>
              <div class="handoff-actions">
                <button class="btn btn-ghost" onClick={() => setShowRevise(false)} disabled={loading()}>
                  Cancel
                </button>
                <button class="btn" onClick={handleRevise} disabled={loading()}>
                  Submit Revision Request
                </button>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </Show>
  );
}
