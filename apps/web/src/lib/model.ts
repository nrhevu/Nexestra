/**
 * Which model a task will actually run on.
 *
 * `Task.harnessConfig.model` is usually **unset**, and that is not a gap in the
 * data: an unset model is what tells the adapter to leave `-m` off the command
 * line, so the harness uses whatever it is configured for. A card that showed
 * nothing there was therefore hiding the most interesting half of the answer,
 * and the cost column priced those runs at `$0.00` for the same reason.
 *
 * So the resolution is the same one the server prices against: the task's own
 * model if it has one, otherwise the model `discover()` reported for the
 * harness that will run it.
 */
import type { HarnessId, HarnessInfo, Task } from "@nexestra/core";
import { useHarnesses } from "./api.js";

export interface ResolvedModel {
  /** Model name to show, or `undefined` when nothing knows one yet. */
  readonly name: string | undefined;
  /** `task` when the plan pinned it, `harness` when `discover()` supplied it. */
  readonly source: "task" | "harness" | "unknown";
}

export function resolveModel(
  task: Pick<Task, "harnessConfig" | "assignedHarness">,
  harnesses: readonly HarnessInfo[],
  fallbackHarness?: HarnessId,
): ResolvedModel {
  const pinned = task.harnessConfig.model;
  if (pinned) return { name: pinned, source: "task" };

  const id = task.assignedHarness ?? fallbackHarness;
  const info = id ? harnesses.find((harness) => harness.id === id) : undefined;
  if (info?.defaultModel) return { name: info.defaultModel, source: "harness" };

  return { name: undefined, source: "unknown" };
}

/** `resolveModel` bound to the harnesses this server has discovered. */
export function useModelResolver(): (
  task: Pick<Task, "harnessConfig" | "assignedHarness">,
) => ResolvedModel {
  const harnesses = useHarnesses();
  const known = harnesses.data ?? [];
  return (task) => resolveModel(task, known);
}

/** What a resolved model's tooltip says, so the source is never a guess. */
export function modelTitle(resolved: ResolvedModel): string {
  switch (resolved.source) {
    case "task":
      return `Model pinned by the plan: ${resolved.name}`;
    case "harness":
      return `No model was pinned, so the harness uses its own default (${resolved.name})`;
    default:
      return "No model pinned, and the harness has not reported a default yet";
  }
}
