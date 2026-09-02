import type { MemoryType, TaskStatus, ThreadPhase } from "@nexestra/core";
import type { StatusTone, TagTone } from "@nexestra/ui-kit";

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day} ${formatTime(iso)}`;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function statusTone(status: TaskStatus): StatusTone {
  switch (status) {
    case "running":
    case "verifying":
      return "running";
    case "done":
      return "done";
    case "review":
      return "warn";
    case "failed":
    case "blocked":
      return "error";
    default:
      return "idle";
  }
}

export function phaseTone(phase: ThreadPhase): TagTone {
  switch (phase) {
    case "executing":
    case "verifying":
      return "info";
    case "done":
      return "accent";
    case "blocked":
      return "danger";
    case "cancelled":
      return "default";
    default:
      return "warn";
  }
}

/** Node accent per memory type, used by the graph and its legend. */
export const MEMORY_TYPE_COLOR: Record<MemoryType, string> = {
  goal: "var(--nx-accent)",
  requirement: "var(--nx-info)",
  decision: "var(--nx-magenta)",
  research: "var(--nx-cyan)",
  architecture: "var(--nx-warn)",
  task: "var(--nx-fg-dim)",
  artifact: "var(--nx-fg-faint)",
  lesson: "var(--nx-danger)",
};

export const MEMORY_TYPES: readonly MemoryType[] = [
  "goal",
  "requirement",
  "decision",
  "research",
  "architecture",
  "task",
  "artifact",
  "lesson",
];
