import { createSignal, Show, onMount } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api";

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

  onMount(async () => {
    try {
      const result = await api.getPlan(props.issueUuid);
      if (result) setPlan(result.payload);
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
    setLoading(true);
    try {
      await api.revisePlan(props.issueUuid, reviseNote());
      props.onAction?.();
    } catch (err) {
      alert(`Failed to request plan revision: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
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

        <Show when={plan()?.markdown}>
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
              <textarea
                class="form-textarea"
                placeholder="Describe what needs to be changed in the plan..."
                value={reviseNote()}
                onInput={(e) => setReviseNote(e.currentTarget.value)}
                rows={4}
              />
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
