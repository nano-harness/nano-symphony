/**
 * Plan runner: executes an approved plan script inside a node:vm sandbox.
 *
 * The sandbox receives only the deterministic plan SDK globals; Date, Math.random,
 * require, import, process, and globalThis are NOT injected and thus unavailable.
 *
 * Each issue() call creates a real sub-issue in the tracker and waits for it to
 * complete via polling. The runner runs in-process inside the orchestrator.
 */

import { createContext, Script } from "node:vm";
import { nanoid } from "nanoid";
import type { Tracker } from "../db/tracker.ts";
import type { ArtifactView, DagEdge, DagNode, IssueOpts, Thunk } from "./sdk.ts";
import { appendJournalEntry, getCompletedIssueResults, issueKey } from "./journal.ts";

const RUNNER_POLL_INTERVAL_MS = 2_000;
const RUNNER_ISSUE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface RunnerInput {
  runId: string;
  script: string;
  args: unknown;
  maxIssues: number;
  wallTimeMs: number;
  tracker: Tracker;
  /** Token spent counter (updated by caller from outside) */
  tokenSpent: () => number;
  /** Total token budget (0 = unlimited) */
  tokenTotal: number;
  /** Max retries for each sub-issue when it's transiently cancelled (default: 0 = no retry) */
  maxRetries?: number;
}

export interface RunnerResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Last phase set via phase() during execution */
  lastPhase: string | null;
  /** Last log message emitted via log() during execution */
  lastLog: string | null;
  /** Timestamp of last log() call */
  lastLogAt: number | null;
  /** Number of sub-issues started */
  subIssuesStarted: number;
  /** Number of sub-issues that reached 'done' state */
  subIssuesDone: number;
  /** Number of sub-issues that were cancelled/failed */
  subIssuesFailed: number;
  /** 'cancelled_by_user' if the plan run itself was cancelled externally */
  terminationReason?: string;
}

export async function runPlan(input: RunnerInput): Promise<RunnerResult> {
  const completedResults = getCompletedIssueResults(input.runId);
  let issueCount = 0;
  let currentPhase: string | null = null;
  let lastLog: string | null = null;
  let lastLogAt: number | null = null;
  let subIssuesStarted = 0;
  let subIssuesDone = 0;
  let subIssuesFailed = 0;
  const maxRetries = input.maxRetries ?? 0;
  const startedAt = Date.now();
  // Per-phase deterministic call index for stable resume keys.
  const phaseCallIndex = new Map<string, number>();

  function makeResult(fields: Omit<RunnerResult, "lastPhase" | "lastLog" | "lastLogAt" | "subIssuesStarted" | "subIssuesDone" | "subIssuesFailed">): RunnerResult {
    return { ...fields, lastPhase: currentPhase, lastLog, lastLogAt, subIssuesStarted, subIssuesDone, subIssuesFailed };
  }

  function checkWallTime(): void {
    if (Date.now() - startedAt > input.wallTimeMs) {
      throw new Error("wall_time_exceeded");
    }
  }

  async function runIssue(prompt: string, opts?: IssueOpts, onCreated?: (uuid: string) => void): Promise<{ result: unknown; uuid: string; key: string }> {
    checkWallTime();

    const effectivePrompt = opts?.prompt ?? prompt;

    if (issueCount >= input.maxIssues) {
      throw new Error(
        `max_issues_exceeded: plan has already spawned ${issueCount} issues (limit=${input.maxIssues})`
      );
    }
    issueCount++;

    // Stable resume identity: user-provided key, or deterministic phase+call index.
    const phase = currentPhase ?? "default";
    const callIndex = (phaseCallIndex.get(phase) ?? 0) + 1;
    phaseCallIndex.set(phase, callIndex);
    const identity = opts?.key ?? `${phase}:${callIndex}`;
    const key = issueKey(input.runId, identity);

    // Crash-resume: if this issue was already completed in a prior run, return its stored result
    if (completedResults.has(key)) {
      const prior = completedResults.get(key)!;
      appendJournalEntry(input.runId, {
        type: "log",
        ts: Date.now(),
        payload: { msg: `Resuming: skipping already-completed issue (key=${key})` },
      });
      return { result: prior.result ?? null, uuid: String(prior.issue_uuid ?? ""), key };
    }

    // Retry loop: attempt this sub-issue up to (1 + maxRetries) times on transient cancel
    let attempt = 0;
    while (true) {
      // Create sub-issue
      const uuid = nanoid();
      subIssuesStarted++;
      const now = Date.now();

      const created = input.tracker.insertIssue({
        uuid,
        title: `[Plan ${input.runId}] ${effectivePrompt.slice(0, 120)}`,
        description: effectivePrompt,
        priority: "medium",
        state: opts?.gate ? "plan_review" : "todo",
        labels: ["plan-sub-task"],
        agent_kind: opts?.agent_kind ?? null,
        agent_binary: opts?.binary ?? null,
        agent_role: opts?.role ?? null,
        require_plan: null,
        plan_run_id: input.runId,
        expected_schema: opts?.schema ? JSON.stringify(opts.schema) : null,
        scratchpad: null,
      });
      const identifier = created.identifier;
      onCreated?.(uuid);

      input.tracker.upsertPlanRunNode({
        run_id: input.runId,
        node_key: key,
        issue_uuid: uuid,
        state: "running",
        started_at: now,
      });

      appendJournalEntry(input.runId, {
        type: "issue_start",
        ts: now,
        payload: { key, issue_uuid: uuid, identifier, phase: currentPhase },
      });

      // Poll until issue reaches a terminal state
      const deadline = Date.now() + RUNNER_ISSUE_TIMEOUT_MS;
      let issueResult: unknown = null;
      let cancelled = false;

      poll:
      while (true) {
        checkWallTime();
        if (Date.now() > deadline) {
          const errMsg = `issue timeout: ${identifier} did not complete within the allowed time`;
          input.tracker.upsertPlanRunNode({
            run_id: input.runId,
            node_key: key,
            issue_uuid: uuid,
            state: "failed",
            started_at: now,
            finished_at: Date.now(),
            error: errMsg,
          });
          throw new Error(errMsg);
        }

        await new Promise(res => setTimeout(res, RUNNER_POLL_INTERVAL_MS));

        const issue = input.tracker.getIssue(uuid);
        if (!issue) {
          const errMsg = `Issue ${uuid} disappeared from tracker`;
          input.tracker.upsertPlanRunNode({
            run_id: input.runId,
            node_key: key,
            issue_uuid: uuid,
            state: "failed",
            started_at: now,
            finished_at: Date.now(),
            error: errMsg,
          });
          throw new Error(errMsg);
        }

        if (issue.state === "done" || issue.state === "cancelled") {
          // Get the latest emit_result
          const result = input.tracker.getLatestIssueResult(uuid);
          const resultData = result?.data ?? null;
          const finishedAt = Date.now();

          input.tracker.upsertPlanRunNode({
            run_id: input.runId,
            node_key: key,
            issue_uuid: uuid,
            state: issue.state,
            started_at: now,
            finished_at: finishedAt,
            result: resultData,
          });

          appendJournalEntry(input.runId, {
            type: "issue_done",
            ts: finishedAt,
            payload: { key, issue_uuid: uuid, identifier, state: issue.state, has_result: !!result, result: resultData },
          });

          if (issue.state === "cancelled") {
            cancelled = true;
            break poll;
          }

          issueResult = resultData;
          subIssuesDone++;
          break poll;
        }

        if (opts?.gate && issue.state === "plan_review") {
          appendJournalEntry(input.runId, {
            type: "log",
            ts: Date.now(),
            payload: { msg: `Gate: waiting for approval of ${identifier} (issue ${uuid})` },
          });
        }
      }

      if (cancelled) {
        subIssuesFailed++;

        // Check if the plan run itself was cancelled by the user/operator
        const planRun = input.tracker.getPlanRun(input.runId);
        if (planRun?.state === "cancelled") {
          throw new Error(`cancelled_by_user: plan run ${input.runId} was cancelled`);
        }

        // Transient cancel: retry if budget remains
        if (attempt < maxRetries) {
          attempt++;
          subIssuesStarted--; // will be re-incremented in next loop iteration
          subIssuesFailed--;  // will be re-incremented if it fails again
          issueCount--;        // the retry is not an extra issue slot
          appendJournalEntry(input.runId, {
            type: "log",
            ts: Date.now(),
            payload: { msg: `Sub-issue ${identifier} cancelled (transient), retrying (attempt ${attempt}/${maxRetries})` },
          });
          continue;
        }

        const errMsg = `Sub-issue ${identifier} was cancelled`;
        input.tracker.upsertPlanRunNode({
          run_id: input.runId,
          node_key: key,
          issue_uuid: uuid,
          state: "failed",
          started_at: now,
          finished_at: Date.now(),
          error: errMsg,
        });
        throw new Error(errMsg);
      }

      return { result: issueResult, uuid, key };
    }
  }

  async function runParallel<T>(thunks: Array<Thunk<T>>): Promise<T[]> {
    appendJournalEntry(input.runId, {
      type: "parallel_start",
      ts: Date.now(),
      payload: { count: thunks.length },
    });
    const results = await Promise.all(thunks.map(t => t()));
    appendJournalEntry(input.runId, {
      type: "parallel_done",
      ts: Date.now(),
      payload: { count: thunks.length },
    });
    return results;
  }

  async function runPipeline<T>(items: T[], ...stages: Array<(input: unknown) => Promise<unknown>>): Promise<unknown[]> {
    return Promise.all(
      items.map(async (item) => {
        let current: unknown = item;
        for (const stage of stages) {
          current = await stage(current);
        }
        return current;
      })
    );
  }

  async function runDag(nodes: DagNode[], edges: DagEdge[]): Promise<Record<string, unknown>> {
    // --- Build adjacency list and in-degree map ---
    const adj = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    const nodeMap = new Map<string, DagNode>();

    for (const n of nodes) {
      if (nodeMap.has(n.id)) throw new Error(`dag: duplicate node id "${n.id}"`);
      nodeMap.set(n.id, n);
      adj.set(n.id, []);
      inDegree.set(n.id, 0);
    }

    for (const e of edges) {
      if (!nodeMap.has(e.from)) throw new Error(`dag: edge references unknown node "${e.from}"`);
      if (!nodeMap.has(e.to)) throw new Error(`dag: edge references unknown node "${e.to}"`);
      adj.get(e.from)!.push(e.to);
      inDegree.set(e.to, inDegree.get(e.to)! + 1);
    }

    // --- Kahn's algorithm: topological sort + layer grouping ---
    const layers: string[][] = [];
    let currentLayer = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const visited = new Set<string>();

    while (currentLayer.length > 0) {
      layers.push(currentLayer);
      for (const id of currentLayer) visited.add(id);
      const nextLayer: string[] = [];
      for (const id of currentLayer) {
        for (const to of adj.get(id)!) {
          const newDegree = inDegree.get(to)! - 1;
          inDegree.set(to, newDegree);
          if (newDegree === 0) nextLayer.push(to);
        }
      }
      currentLayer = nextLayer;
    }

    if (visited.size !== nodes.length) {
      const cycleNodes = nodes.map(n => n.id).filter(id => !visited.has(id));
      throw new Error(`dag: cycle detected involving nodes: ${cycleNodes.join(", ")}`);
    }

    appendJournalEntry(input.runId, {
      type: "dag_start",
      ts: Date.now(),
      payload: { node_count: nodes.length, edge_count: edges.length, layer_count: layers.length },
    });

    const results = new Map<string, unknown>();
    // node id -> created issue uuid for this run
    const nodeIssueUuid = new Map<string, string>();
    // node id -> whether it acts as a reviewer/gate for downstream nodes
    const nodeIsGate = new Map<string, boolean>();
    // Precompute reverse adjacency: node -> direct predecessors
    const predecessors = new Map<string, string[]>();
    for (const n of nodes) predecessors.set(n.id, []);
    for (const e of edges) predecessors.get(e.to)!.push(e.from);

    // --- Execute layer by layer ---
    try {
      for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
        const layer = layers[layerIdx];
        checkWallTime();

        // Interpolate prompts with predecessor results
        const interpolated = layer.map((id) => {
          const node = nodeMap.get(id)!;
          const prompt = node.prompt.replace(/\{\{([^}]+)\}\}/g, (_match, refId) => {
            const trimmed = refId.trim();
            if (!results.has(trimmed)) {
              throw new Error(`dag: node "${id}" references unknown predecessor "${trimmed}"`);
            }
            const val = results.get(trimmed);
            return typeof val === "string" ? val : JSON.stringify(val);
          });
          // DAG node id is the stable resume identity.
          // Also merge legacy top-level role/gate into opts.
          const opts: IssueOpts = {
            ...node.opts,
            key: id,
            role: node.opts?.role ?? node.role,
            gate: node.opts?.gate ?? node.gate,
          };
          return { id, prompt, opts };
        });

        // Run all nodes in this layer in parallel.
        // For each node, after creation, add blockers for any gate predecessors.
        const layerResults = await Promise.all(
          interpolated.map(({ id, prompt, opts }) =>
            runIssue(prompt, opts, (uuid) => {
              nodeIssueUuid.set(id, uuid);
              const node = nodeMap.get(id)!;
              nodeIsGate.set(id, (node.opts?.role ?? node.role) === "reviewer" || (node.opts?.gate ?? node.gate) === true);
              for (const predId of predecessors.get(id) ?? []) {
                if (!nodeIsGate.get(predId)) continue;
                const blockerUuid = nodeIssueUuid.get(predId);
                if (!blockerUuid) continue;
                input.tracker.insertBlocker(uuid, blockerUuid, input.tracker.getIssue(blockerUuid)?.state ?? "todo");
                appendJournalEntry(input.runId, {
                  type: "log",
                  ts: Date.now(),
                  payload: { msg: `Reviewer/gate node "${predId}" blocks successor "${id}"` },
                });
              }
            }).then((res) => ({ id, res }))
          )
        );

        for (const { id, res } of layerResults) {
          results.set(id, res.result);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendJournalEntry(input.runId, {
        type: "dag_error",
        ts: Date.now(),
        payload: { error: message },
      });
      throw err;
    }

    // Build return object preserving input node order
    const resultObj: Record<string, unknown> = {};
    for (const n of nodes) {
      resultObj[n.id] = results.get(n.id) ?? null;
    }

    appendJournalEntry(input.runId, {
      type: "dag_done",
      ts: Date.now(),
      payload: { node_count: nodes.length, completed: results.size },
    });

    return resultObj;
  }

  function setPhase(title: string): void {
    currentPhase = title;
    appendJournalEntry(input.runId, {
      type: "phase",
      ts: Date.now(),
      payload: { title },
    });
  }

  function logMsg(msg: string): void {
    lastLog = msg;
    lastLogAt = Date.now();
    appendJournalEntry(input.runId, {
      type: "log",
      ts: Date.now(),
      payload: { msg },
    });
  }

  function toArtifactView(art: {
    id: string;
    issue_uuid: string;
    kind: string;
    label: string | null;
    path: string | null;
    content: string | null;
    metadata_json: string | null;
    content_size: number;
    mime_type: string;
    ts: number;
  }): ArtifactView {
    let metadata: unknown = null;
    if (art.metadata_json) {
      try { metadata = JSON.parse(art.metadata_json); } catch { metadata = null; }
    }
    return {
      id: art.id,
      issue_uuid: art.issue_uuid,
      kind: art.kind,
      label: art.label,
      path: art.path,
      content: art.content,
      content_size: art.content_size,
      mime_type: art.mime_type,
      metadata,
      ts: art.ts,
    };
  }

  /** Ensure an issue belongs to this plan run before exposing its artifacts. */
  function assertIssueInRun(issueUuid: string, fn: string): void {
    const issue = input.tracker.getIssue(issueUuid);
    if (!issue || issue.plan_run_id !== input.runId) {
      throw new Error(`${fn}: issue ${issueUuid} is not part of plan run ${input.runId}`);
    }
  }

  function listArtifactsForRun(issueUuid: string): ArtifactView[] {
    assertIssueInRun(issueUuid, "list_artifacts");
    return input.tracker.listArtifacts(issueUuid).map(toArtifactView);
  }

  function getArtifactForRun(artifactId: string): ArtifactView | null {
    const art = input.tracker.getArtifact(artifactId);
    if (!art) return null;
    assertIssueInRun(art.issue_uuid, "get_artifact");
    return toArtifactView(art);
  }

  const sandboxContext = createContext({
    args: input.args ?? null,
    budget: {
      total: input.tokenTotal,
      spent: input.tokenSpent,
      remaining: () => input.tokenTotal > 0 ? Math.max(0, input.tokenTotal - input.tokenSpent()) : Infinity,
    },
    issue: (prompt: string, opts?: IssueOpts) => runIssue(prompt, opts).then(r => r.result),
    parallel: runParallel,
    pipeline: runPipeline,
    dag: runDag,
    phase: setPhase,
    log: logMsg,
    list_artifacts: listArtifactsForRun,
    get_artifact: getArtifactForRun,
    Promise,
  });

  try {
    const wrappedScript = `(async () => { ${input.script} })()`;
    const vmScript = new Script(wrappedScript);
    const promise = vmScript.runInContext(sandboxContext) as Promise<unknown>;
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("wall_time_exceeded")),
          input.wallTimeMs
        )
      ),
    ]);
    return makeResult({ ok: true, result: result ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const terminationReason = message.startsWith("cancelled_by_user:") ? "cancelled_by_user" : undefined;
    return makeResult({ ok: false, error: message, terminationReason });
  }
}
