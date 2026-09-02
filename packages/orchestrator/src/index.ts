/**
 * `@nexestra/orchestrator` — the dispatch / review / verify loop (PLAN.md §6).
 *
 * Filled in at M4–M5: ready-task selection over the DAG, concurrency limits,
 * cross-review with a different harness, verification of acceptance criteria
 * and retry / replan on failure.
 */
import type { Task } from "@nexestra/core";

export const DEFAULT_CONCURRENCY = 2;

/** A task is ready when every dependency is done and it has not started yet. */
export function selectReadyTasks(tasks: readonly Task[]): Task[] {
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  return tasks.filter(
    (task) =>
      (task.status === "todo" || task.status === "ready") &&
      task.dependsOn.every((dependency) => done.has(dependency)),
  );
}

/** Placeholder until the real loop lands in M4. */
export function createOrchestrator(): never {
  throw new Error("@nexestra/orchestrator is not implemented until milestone M4");
}
