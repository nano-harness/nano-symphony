import { createSignal, Show, For, createEffect } from "solid-js";
import { api, type Artifact } from "./api";

interface ArtifactsPanelProps {
  issueUuid: string;
  maxAttempt: number;
}

export function ArtifactsPanel(props: ArtifactsPanelProps) {
  const [artifacts, setArtifacts] = createSignal<Artifact[]>([]);
  const [selectedAttempt, setSelectedAttempt] = createSignal<number | undefined>(undefined);
  const [expandedId, setExpandedId] = createSignal<string | null>(null);
  const [previewContent, setPreviewContent] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const attempts = () => {
    const max = props.maxAttempt;
    return Array.from({ length: max + 1 }, (_, i) => i);
  };

  const loadArtifacts = async () => {
    setLoading(true);
    try {
      const list = await api.listArtifacts(props.issueUuid, selectedAttempt());
      setArtifacts(list);
    } catch {
      setArtifacts([]);
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => { const _ = selectedAttempt(); loadArtifacts(); });

  const toggleExpand = async (artifact: Artifact) => {
    if (expandedId() === artifact.id) {
      setExpandedId(null);
      setPreviewContent(null);
      return;
    }
    setExpandedId(artifact.id);
    setPreviewContent(null);
    // Fetch full artifact content for preview
    try {
      const full = await api.getArtifact(artifact.id);
      setPreviewContent(full.content);
    } catch {
      setPreviewContent(null);
    }
  };

  const sourceIcon = (source: string) => source === "git_diff" ? "📝" : "📦";
  const kindIcon = (kind: string) => {
    switch (kind) {
      case "file_diff": return "📄";
      case "file_added": return "➕";
      case "file_modified": return "✏️";
      case "file_removed": return "➖";
      case "file_renamed": return "🔄";
      case "screenshot": return "📸";
      case "log_excerpt": return "📋";
      case "command_output": return "💻";
      case "note": return "📝";
      case "url": return "🔗";
      default: return "📦";
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const tryParseMeta = (metaJson: string | null): any => {
    if (!metaJson) return null;
    try { return JSON.parse(metaJson); } catch { return null; }
  };

  const downloadURL = (artifact: Artifact) => {
    if (artifact.content_size === 0 && artifact.path) {
      return api.fileURL(props.issueUuid, artifact.path);
    }
    return api.artifactRawURL(artifact.id);
  };

  return (
    <Show when={artifacts().length > 0 || loading()}>
      <div class="issue-section">
        <h2 class="section-title">Artifacts</h2>

        <Show when={props.maxAttempt > 0}>
          <div class="artifacts-attempt-selector">
            <button
              class="btn-sm"
              classList={{ active: selectedAttempt() === undefined }}
              onClick={() => setSelectedAttempt(undefined)}
            >
              All
            </button>
            <For each={attempts()}>
              {(a) => (
                <button
                  class="btn-sm"
                  classList={{ active: selectedAttempt() === a }}
                  onClick={() => setSelectedAttempt(a)}
                >
                  #{a}
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={loading()}>
          <div class="artifacts-loading">Loading...</div>
        </Show>

        <Show when={!loading() && artifacts().length > 0}>
          <ul class="artifacts-list">
            <For each={artifacts()}>
              {(artifact) => (
                <li class="artifact-row">
                  <div class="artifact-header" onClick={() => toggleExpand(artifact)}>
                    <span class="artifact-icons">
                      <span title={artifact.source}>{sourceIcon(artifact.source)}</span>
                      <span title={artifact.kind}>{kindIcon(artifact.kind)}</span>
                    </span>
                    <span class={`artifact-kind ${artifact.kind}`}>{artifact.kind.replace(/_/g, " ")}</span>
                    <span class="artifact-label">{artifact.label ?? ""}</span>
                    <span class="artifact-meta">
                      <span class="artifact-size">{formatSize(artifact.content_size)}</span>
                      <span class="artifact-attempt">attempt {artifact.attempt}</span>
                    </span>
                    <a
                      class="btn-icon artifact-download"
                      href={downloadURL(artifact)}
                      download
                      title="Download"
                      onClick={(e) => e.stopPropagation()}
                    >↓</a>
                  </div>
                  <Show when={expandedId() === artifact.id}>
                    <div class="artifact-preview">
                      {/* Diff truncation warning */}
                      <Show when={artifact.kind === "file_diff" && tryParseMeta(artifact.metadata_json)?.diff_truncated}>
                        <div class="artifact-warning">⚠ Diff 已截断，完整内容请下载查看</div>
                      </Show>
                      <Show when={artifact.kind === "screenshot"}>
                        <img src={api.artifactRawURL(artifact.id)} alt={artifact.label ?? "screenshot"} class="artifact-img" />
                      </Show>
                      <Show when={artifact.kind === "url" && artifact.metadata_json}>
                        {(() => {
                          try {
                            const meta = JSON.parse(artifact.metadata_json!);
                            return <a href={meta.href} target="_blank" rel="noopener">{meta.label ?? meta.href}</a>;
                          } catch { return null; }
                        })()}
                      </Show>
                      <Show when={artifact.kind === "file_diff" && previewContent()}>
                        <pre class="artifact-diff">{
                          previewContent()!.split("\n").map((line) => {
                            const cls = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : line.startsWith("@@") ? "diff-hunk" : "";
                            return <div class={`diff-line ${cls}`}>{line}</div>;
                          })
                        }</pre>
                      </Show>
                      {/* file_added / file_modified content preview */}
                      <Show when={(artifact.kind === "file_added" || artifact.kind === "file_modified") && previewContent()}>
                        <pre class="artifact-pre">{previewContent()}</pre>
                      </Show>
                      <Show when={(artifact.kind === "log_excerpt" || artifact.kind === "command_output") && previewContent()}>
                        <pre class="artifact-pre">{previewContent()}</pre>
                      </Show>
                      <Show when={artifact.kind === "note" && previewContent()}>
                        <div class="artifact-note">{previewContent()}</div>
                      </Show>
                      <Show when={!previewContent() && artifact.kind !== "screenshot" && artifact.kind !== "url" && expandedId() === artifact.id}>
                        <div class="artifact-no-content">No inline preview available. Use download button.</div>
                      </Show>
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Show>
  );
}
