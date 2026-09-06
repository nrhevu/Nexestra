import type { Task } from "./contracts.js";

export function formatTaskCriteria(
  task: Pick<Task, "revision" | "kind" | "acceptanceCriteria">,
): string {
  return [
    `Task contract revision ${task.revision}; work type: ${task.kind}.`,
    "Acceptance criteria (report evidence; a reviewer decides whether the task passes):",
    ...task.acceptanceCriteria.map(
      (item, index) => `${index + 1}. ${item.behavior}\n   Verification: ${item.verification}`,
    ),
    task.acceptanceCriteria.length === 0
      ? "No criteria were recorded. Explain this gap; do not claim independent acceptance."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
