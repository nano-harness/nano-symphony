/**
 * Plan SDK types and the injected API available inside plan scripts.
 *
 * Scripts receive these globals via vm.createContext injection:
 *   args, budget, issue(), parallel(), pipeline(), dag(), phase(), log(),
 *   list_artifacts(), get_artifact()
 */

export interface IssueOpts {
  /** JSON Schema for validating emit_result.data. If provided, issue() returns validated data. */
  schema?: Record<string, unknown>;
  /** Agent kind override */
  agent_kind?: "nano" | "claude-code";
  /** Agent binary override */
  binary?: string;
  /** Agent role override (selects a profile from workflow.agent.roles) */
  role?: string;
  /** Override prompt (default: first arg to issue()) */
  prompt?: string;
  /**
   * Stable identity for crash-resume. If omitted, a deterministic key is derived
   * from the current phase and call index.
   */
  key?: string;
  /**
   * Human approval gate: the sub-issue is created in plan_review state and the
   * plan run pauses until an operator transitions it out of plan_review.
   */
  gate?: boolean;
}

/** A read-only view of a stored artifact exposed to plan scripts. */
export interface ArtifactView {
  id: string;
  issue_uuid: string;
  kind: string;
  label: string | null;
  path: string | null;
  content: string | null;
  content_size: number;
  mime_type: string;
  metadata: unknown;
  ts: number;
}

export interface BudgetHandle {
  /** Total soft token budget hint (0 = unlimited) */
  total: number;
  /** Tokens spent so far */
  spent(): number;
  /** Remaining tokens (Infinity if total=0) */
  remaining(): number;
}

/** A callable that returns a promise of a result */
export type Thunk<T = unknown> = () => Promise<T>;

/** A node in a DAG declared via dag(). */
export interface DagNode {
  /** Unique identifier for this node within the DAG */
  id: string;
  /** Prompt passed to the sub-issue (supports {{nodeId}} interpolation) */
  prompt: string;
  /** Optional overrides (schema, agent_kind, binary, role, gate) */
  opts?: IssueOpts;
  /** @deprecated Use opts.role instead. */
  role?: string;
  /** @deprecated Use opts.gate instead. */
  gate?: boolean;
}

/** A directed edge in a DAG declared via dag(). */
export interface DagEdge {
  /** Source node id */
  from: string;
  /** Target node id */
  to: string;
}

/** Result of a dag() execution: map from node id to sub-issue result */
export type DagResult = Record<string, unknown>;

/**
 * The SDK object injected into plan scripts.
 * All functions are async to allow real execution to await sub-issues.
 */
export interface PlanSDK {
  /** Parsed args passed when spawning the plan run */
  args: unknown;
  /** Budget tracking handle */
  budget: BudgetHandle;
  /**
   * Run a sub-issue with the given prompt.
   * Returns validated emit_result.data if opts.schema is set, else a string summary.
   */
  issue(prompt: string, opts?: IssueOpts): Promise<unknown>;
  /**
   * Run multiple thunks concurrently (up to system semaphore limit).
   * Returns array of results in input order.
   */
  parallel<T>(thunks: Array<Thunk<T>>): Promise<T[]>;
  /**
   * Pipeline: run items through a sequence of stages, each stage receiving the
   * output of the previous. stages[0] receives the raw item.
   */
  pipeline<T, R>(items: T[], ...stages: Array<(input: unknown) => Promise<unknown>>): Promise<R[]>;
  /**
   * DAG: run a dependency graph of sub-issues layer-by-layer.
   * Nodes in the same topological layer execute in parallel.
   * Prompts may reference predecessor results via {{nodeId}}.
   * Returns a map from node id to sub-issue result.
   */
  dag(nodes: DagNode[], edges: DagEdge[]): Promise<DagResult>;
  /** Log a message to the plan journal */
  phase(title: string): void;
  /** Log a message to the plan journal */
  log(msg: string): void;
  /** List artifacts produced by a completed sub-issue of this plan run. */
  list_artifacts(issue_uuid: string): ArtifactView[];
  /** Fetch a single artifact produced within this plan run. */
  get_artifact(artifact_id: string): ArtifactView | null;
}

/** Entry written to the plan journal during dry-run and execution */
export interface JournalEntry {
  type: "phase" | "issue_start" | "issue_done" | "issue_error" | "log" | "parallel_start" | "parallel_done" | "dag_start" | "dag_done" | "dag_error";
  ts: number;
  payload: Record<string, unknown>;
}

/** Dry-run output: symbolic execution summary of the plan script */
export interface DryRunSummary {
  ok: boolean;
  error?: string;
  phases: string[];
  estimated_issues: number;
  issue_prompts: Array<{ phase: string; prompt_prefix: string; has_schema: boolean; gated?: boolean }>;
  max_issues: number;
}
