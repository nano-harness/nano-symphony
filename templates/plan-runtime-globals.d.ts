/**
 * Type declarations for nano-symphony plan scripts.
 *
 * Plan scripts run inside a node:vm sandbox where these globals are injected.
 * They are not real modules — `import`/`require` are unavailable — but adding
 * this triple-slash reference at the top of a plan script gives VS Code / tsc
 * autocomplete and inline docs.
 *
 * Example:
 *   /// <reference path="./plan-runtime-globals.d.ts" />
 *   // @ts-check
 *
 *   phase("Research");
 *   const analysis = await issue("...", {
 *     schema: { type: "object", properties: { points: { type: "array", items: { type: "string" } } }, required: ["points"] }
 *   });
 */

interface IssueOpts {
  /** JSON Schema for validating emit_result.data. */
  schema?: Record<string, unknown>;
  /** Agent kind override. */
  agent_kind?: "nano" | "claude-code";
  /** Agent binary override. */
  binary?: string;
  /** Agent role override (selects a profile from workflow.agent.roles). */
  role?: string;
  /** Stable identity for crash-resume. */
  key?: string;
  /** Human approval gate. */
  gate?: boolean;
}

interface BudgetHandle {
  total: number;
  spent(): number;
  remaining(): number;
}

interface ArtifactView {
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

interface DagNode {
  id: string;
  prompt: string;
  opts?: IssueOpts;
  /** @deprecated Use opts.role instead. */
  role?: string;
  /** @deprecated Use opts.gate instead. */
  gate?: boolean;
}

interface DagEdge {
  from: string;
  to: string;
}

type Thunk<T = unknown> = () => Promise<T>;
type DagResult = Record<string, unknown>;

declare const args: unknown;
declare const budget: BudgetHandle;

declare function issue(prompt: string, opts?: IssueOpts): Promise<unknown>;
declare function parallel<T>(thunks: Array<Thunk<T>>): Promise<T[]>;
declare function pipeline<T, R>(items: T[], ...stages: Array<(input: unknown) => Promise<unknown>>): Promise<R[]>;
declare function dag(nodes: DagNode[], edges: DagEdge[]): Promise<DagResult>;
declare function phase(title: string): void;
declare function log(msg: string): void;
declare function list_artifacts(issue_uuid: string): ArtifactView[];
declare function get_artifact(artifact_id: string): ArtifactView | null;
