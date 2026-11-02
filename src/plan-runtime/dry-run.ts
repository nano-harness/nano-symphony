/**
 * Dry-run engine: symbolically executes the plan script to produce a DryRunSummary.
 *
 * All issue() calls are replaced with a stub that records metadata but does not
 * actually create issues. parallel/pipeline execute normally so branching/looping
 * is captured accurately.
 *
 * Safety limits (5s wall-time, max issues = max_issues×2) are enforced.
 */

import { createContext, Script } from "node:vm";
import type { DagEdge, DagNode, DryRunSummary, IssueOpts, Thunk } from "./sdk.ts";

const DRY_RUN_TIMEOUT_MS = 5_000;

export interface DryRunInput {
  script: string;
  args: unknown;
  maxIssues: number;
}

function synthesizeStub(schema: Record<string, unknown> | undefined, hint?: string): unknown {
  if (hint) return hint;
  if (!schema) return "<DRY_RUN>";
  return synthesizeFromSchema(schema);
}

function synthesizeFromSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return "<dry>";
  const s = schema as Record<string, unknown>;
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];

  if (s.enum && Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];

  const type = types[0];
  switch (type) {
    case "string": return "<dry>";
    case "number":
    case "integer": return 0;
    case "boolean": return false;
    case "null": return null;
    case "array": {
      const items = s.items ? [synthesizeFromSchema(s.items)] : [];
      return items;
    }
    case "object": {
      const result: Record<string, unknown> = {};
      const required = Array.isArray(s.required) ? s.required : [];
      const props = s.properties && typeof s.properties === "object"
        ? s.properties as Record<string, unknown>
        : {};
      for (const key of required) {
        result[key] = synthesizeFromSchema(props[key] ?? {});
      }
      return result;
    }
    default:
      return "<dry>";
  }
}

export async function dryRun(input: DryRunInput): Promise<DryRunSummary> {
  const issuePrompts: DryRunSummary["issue_prompts"] = [];
  const phases: string[] = [];
  let currentPhase = "default";
  let issueCount = 0;
  const maxIssuesCap = input.maxIssues * 2;

  function dryIssue(prompt: string, opts?: IssueOpts): Promise<unknown> {
    issueCount++;
    if (issueCount > maxIssuesCap) {
      throw new Error(
        `unbounded: plan called issue() more than ${maxIssuesCap} times (max_issues=${input.maxIssues}). ` +
        `Reduce the number of sub-issues or increase max_issues.`
      );
    }
    const promptPrefix = prompt.slice(0, 80);
    issuePrompts.push({ phase: currentPhase, prompt_prefix: promptPrefix, has_schema: !!opts?.schema, gated: !!opts?.gate });
    return Promise.resolve(synthesizeStub(opts?.schema));
  }

  async function dryParallel<T>(thunks: Array<Thunk<T>>): Promise<T[]> {
    return Promise.all(thunks.map(t => t()));
  }

  async function dryPipeline<T>(items: T[], ...stages: Array<(input: unknown) => Promise<unknown>>): Promise<unknown[]> {
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

  async function dryDag(nodes: DagNode[], edges: DagEdge[]): Promise<Record<string, unknown>> {
    // Validate DAG structure (same checks as runner)
    const nodeMap = new Map<string, DagNode>();
    const adj = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

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

    let visited = 0;
    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited++;
      for (const to of adj.get(id)!) {
        const newDegree = inDegree.get(to)! - 1;
        inDegree.set(to, newDegree);
        if (newDegree === 0) queue.push(to);
      }
    }

    if (visited !== nodes.length) {
      throw new Error("dag: cycle detected");
    }

    // Symbolic execution: count each node as one issue, return stub results
    const result: Record<string, unknown> = {};
    for (const n of nodes) {
      issueCount++;
      if (issueCount > maxIssuesCap) {
        throw new Error(
          `unbounded: plan called dag() with more than ${maxIssuesCap} total nodes (max_issues=${input.maxIssues})`
        );
      }
      const promptPrefix = n.prompt.slice(0, 80);
      const gated = !!(n.opts?.gate ?? n.gate);
      issuePrompts.push({ phase: currentPhase, prompt_prefix: promptPrefix, has_schema: !!(n.opts?.schema), gated });
      result[n.id] = synthesizeStub(n.opts?.schema);
    }
    return result;
  }

  function dryPhase(title: string): void {
    currentPhase = title;
    if (!phases.includes(title)) phases.push(title);
  }

  function dryLog(_msg: string): void {
    // no-op in dry run
  }

  const sandboxContext = createContext({
    args: input.args ?? null,
    budget: {
      total: 0,
      spent: () => 0,
      remaining: () => Infinity,
    },
    issue: dryIssue,
    parallel: dryParallel,
    pipeline: dryPipeline,
    dag: dryDag,
    phase: dryPhase,
    log: dryLog,
    // Artifact access is meaningless during symbolic dry-run (no real sub-issues
    // exist yet), but the globals must be present so scripts that reference them
    // do not throw ReferenceError.
    list_artifacts: () => [],
    get_artifact: () => null,
    // Promise must be explicitly injected for async scripts to work in vm context
    Promise,
  });

  try {
    const wrappedScript = `(async () => { ${input.script} })()`;
    const vmScript = new Script(wrappedScript);
    const promise = vmScript.runInContext(sandboxContext, { timeout: DRY_RUN_TIMEOUT_MS });
    await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`dry-run timeout (${DRY_RUN_TIMEOUT_MS}ms)`)), DRY_RUN_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
      phases,
      estimated_issues: issueCount,
      issue_prompts: issuePrompts,
      max_issues: input.maxIssues,
    };
  }

  return {
    ok: true,
    phases: phases.length ? phases : ["default"],
    estimated_issues: issueCount,
    issue_prompts: issuePrompts,
    max_issues: input.maxIssues,
  };
}
