import { createSignal, Show } from "solid-js";
import { api } from "./api";

interface PlanRunCreatorProps {
  callerIssueUuid: string;
  onCreated: () => void;
}

const DEFAULT_SCRIPT = `dag({
  root: {
    prompt: "Analyze the issue and produce a summary.",
  },
  implement: {
    prompt: "Implement the fix based on {{root}}.",
    after: ["root"],
  },
  test: {
    prompt: "Add or run tests to verify the fix from {{implement}}.",
    after: ["implement"],
  },
});
`;

export function PlanRunCreator(props: PlanRunCreatorProps) {
  const [name, setName] = createSignal("");
  const [script, setScript] = createSignal(DEFAULT_SCRIPT);
  const [args, setArgs] = createSignal("");
  const [maxIssues, setMaxIssues] = createSignal(10);
  const [wallTimeHours, setWallTimeHours] = createSignal(1);
  const [expanded, setExpanded] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const reset = () => {
    setName("");
    setScript(DEFAULT_SCRIPT);
    setArgs("");
    setMaxIssues(10);
    setWallTimeHours(1);
    setError(null);
  };

  const submit = async () => {
    setLoading(true);
    setError(null);
    try {
      let parsedArgs: unknown | undefined;
      if (args().trim()) {
        parsedArgs = JSON.parse(args());
      }
      await api.createPlanRun({
        script: script(),
        meta: { name: name().trim() || "Unnamed plan", max_issues: maxIssues() },
        args: parsedArgs,
        caller_issue_uuid: props.callerIssueUuid,
        wall_time_ms: wallTimeHours() * 60 * 60 * 1000,
      });
      reset();
      setExpanded(false);
      props.onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="plan-run-creator">
      <Show
        when={expanded()}
        fallback={(
          <button class="btn btn-secondary" onClick={() => setExpanded(true)}>
            + Create Plan Run
          </button>
        )}
      >
        <div class="issue-section">
          <h3 class="section-title">Create Plan Run</h3>
          <div class="form-row">
            <label class="form-label">Name</label>
            <input
              class="form-input"
              type="text"
              placeholder="e.g. Fix login bug"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>
          <div class="form-row">
            <label class="form-label">Script</label>
            <textarea
              class="form-textarea code"
              rows={12}
              value={script()}
              onInput={(e) => setScript(e.currentTarget.value)}
            />
            <p class="form-hint">
              Write a plan script using <code>issue()</code>, <code>parallel()</code>, <code>dag()</code>, or <code>pipeline()</code>.
            </p>
          </div>
          <div class="form-row">
            <label class="form-label">Args (JSON, optional)</label>
            <textarea
              class="form-textarea code"
              rows={3}
              placeholder='{"key": "value"}'
              value={args()}
              onInput={(e) => setArgs(e.currentTarget.value)}
            />
          </div>
          <div class="form-row inline">
            <label class="form-label">Max issues</label>
            <input
              class="form-input number"
              type="number"
              min={1}
              max={100}
              value={maxIssues()}
              onInput={(e) => setMaxIssues(Number(e.currentTarget.value))}
            />
            <label class="form-label">Wall time (hours)</label>
            <input
              class="form-input number"
              type="number"
              min={1}
              max={168}
              value={wallTimeHours()}
              onInput={(e) => setWallTimeHours(Number(e.currentTarget.value))}
            />
          </div>
          <Show when={error()}>
            <div class="alert alert-error">{error()}</div>
          </Show>
          <div class="form-actions">
            <button class="btn btn-secondary" onClick={() => setExpanded(false)} disabled={loading()}>
              Cancel
            </button>
            <button class="btn btn-primary" onClick={submit} disabled={loading() || !script().trim()}>
              {loading() ? "Creating..." : "Create Plan Run"}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
