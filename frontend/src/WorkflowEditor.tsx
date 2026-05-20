import { createSignal, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import { api } from "./api";

export function WorkflowEditor() {
  const [content, setContent] = createSignal("");
  const [toast, setToast] = createSignal<{ message: string; type: "success" | "error" } | null>(null);

  onMount(async () => {
    const { content: c } = await api.getWorkflow();
    setContent(c);
  });

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 1800);
  };

  const save = async () => {
    try {
      await api.saveWorkflow(content());
      showToast("Workflow saved");
    } catch (err) {
      showToast("Failed to save workflow", "error");
    }
  };

  return (
    <div class="page workflow-editor">
      <div class="page-header">
        <div class="eyebrow">← THE SCORE · CADENZA / Workflow</div>
        <h1 class="page-title">Edit Workflow</h1>
      </div>

      <div class="workflow-toolbar">
        <A href="/" class="btn btn-secondary">
          ← Back to Score
        </A>
        <button class="btn" onClick={save}>
          Save Workflow
        </button>
      </div>

      <textarea
        class="workflow-textarea"
        value={content()}
        onInput={(e) => setContent(e.currentTarget.value)}
        placeholder="# Define your workflow here..."
      />

      {/* Toast Notifications */}
      <Show when={toast()}>
        <div class="toast-container">
          <div class={`toast ${toast()!.type}`}>{toast()!.message}</div>
        </div>
      </Show>
    </div>
  );
}
