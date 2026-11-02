import type { PlanStep } from "./plan-diff.ts";

export interface PlanGraphNode {
  id: string;
  title: string;
  description?: string;
  layer: number;
}

export interface PlanGraphEdge {
  from: string;
  to: string;
}

export interface PlanGraph {
  nodes: PlanGraphNode[];
  edges: PlanGraphEdge[];
  layers: string[][];
  ok: boolean;
  error?: string;
}

function validateId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function computePlanGraph(steps: PlanStep[] = []): PlanGraph {
  if (steps.length === 0) return { nodes: [], edges: [], layers: [], ok: true };

  const nodeMap = new Map<string, PlanStep>();
  for (const step of steps) {
    if (nodeMap.has(step.id)) {
      return { nodes: [], edges: [], layers: [], ok: false, error: `Duplicate step id: ${step.id}` };
    }
    nodeMap.set(step.id, step);
  }

  const edges: PlanGraphEdge[] = [];
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.id, 0);
    adjacency.set(step.id, []);
  }

  for (const step of steps) {
    for (const dep of step.after ?? []) {
      if (!nodeMap.has(dep)) {
        return { nodes: [], edges: [], layers: [], ok: false, error: `Unknown dependency: ${dep}` };
      }
      edges.push({ from: dep, to: step.id });
      adjacency.get(dep)!.push(step.id);
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
    }
  }

  // Kahn's algorithm for topological sort and layer assignment.
  const queue: Array<{ id: string; layer: number }> = [];
  for (const [id, degree] of inDegree.entries()) {
    if (degree === 0) queue.push({ id, layer: 0 });
  }

  const layerMap = new Map<string, number>();
  const processed: string[] = [];

  while (queue.length > 0) {
    const { id, layer } = queue.shift()!;
    layerMap.set(id, Math.max(layer, layerMap.get(id) ?? 0));
    processed.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const nextLayer = Math.max(layer + 1, layerMap.get(next) ?? 0);
      const nextDegree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push({ id: next, layer: nextLayer });
      } else {
        layerMap.set(next, nextLayer);
      }
    }
  }

  if (processed.length !== steps.length) {
    return { nodes: [], edges: [], layers: [], ok: false, error: "Cycle detected in step dependencies" };
  }

  const maxLayer = Math.max(0, ...layerMap.values());
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const [id, layer] of layerMap.entries()) {
    layers[layer].push(id);
  }

  const nodes: PlanGraphNode[] = steps.map((step) => ({
    id: step.id,
    title: step.title,
    description: step.description,
    layer: layerMap.get(step.id) ?? 0,
  }));

  return { nodes, edges, layers, ok: true };
}
