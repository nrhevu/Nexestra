import { z } from "zod";
import { EntityBaseSchema, IdSchema } from "./common.js";

/** A dependency edge in the task DAG. */
export const PlanEdgeSchema = z.object({
  from: IdSchema,
  to: IdSchema,
});
export type PlanEdge = z.infer<typeof PlanEdgeSchema>;

/** Versioned plan owned by a thread: a set of tasks plus their DAG edges. */
export const PlanSchema = EntityBaseSchema.extend({
  threadId: IdSchema,
  specId: IdSchema,
  version: z.number().int().min(1),
  summary: z.string().default(""),
  taskIds: z.array(IdSchema).default([]),
  edges: z.array(PlanEdgeSchema).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

/** Detect a cycle in a plan's DAG. Returns the offending node ids, if any. */
export function findPlanCycle(taskIds: readonly string[], edges: readonly PlanEdge[]): string[] {
  const outgoing = new Map<string, string[]>();
  for (const id of taskIds) outgoing.set(id, []);
  for (const edge of edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge.to);
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    const current = state.get(node) ?? 0;
    if (current === 1) return [...stack.slice(stack.indexOf(node)), node];
    if (current === 2) return null;
    state.set(node, 1);
    stack.push(node);
    for (const next of outgoing.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };

  for (const id of taskIds) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return [];
}
