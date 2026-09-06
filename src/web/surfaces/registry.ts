import { BookOpen, Columns3, Flag, LayoutGrid, Target, UsersRound } from "lucide-react";
import type { BootstrapData } from "../../shared/contracts.js";

// Host renderers only. Custom surfaces use validated declarative definitions.
export const surfaces = [
  {
    id: "briefs",
    label: "Work briefs",
    description: "Outcomes, scope and success criteria",
    icon: Target,
    count: (data: BootstrapData) => data.workBriefs.length,
  },
  {
    id: "taskboard",
    label: "Taskboard",
    description: "Plan and inspect work",
    icon: Columns3,
    count: (data: BootstrapData) => data.tasks.length,
  },
  {
    id: "goals",
    label: "Goals",
    description: "Scope, budgets and durable checkpoints",
    icon: Flag,
    count: (data: BootstrapData) =>
      data.goals.filter((goal) => !["completed", "cancelled", "exhausted"].includes(goal.status))
        .length,
  },
  {
    id: "custom",
    label: "Custom surfaces",
    description: "Shared tables, boards, canvases and documents",
    icon: LayoutGrid,
    count: (data: BootstrapData) => data.surfaces.length,
  },
  {
    id: "knowledge",
    label: "Knowledge",
    description: "Documents and repositories",
    icon: BookOpen,
    count: (data: BootstrapData) => data.knowledge.length,
  },
  {
    id: "agents",
    label: "Agent management",
    description: "Manage your agents",
    icon: UsersRound,
    count: (data: BootstrapData) => data.agents.filter((agent) => !agent.archived).length,
  },
] as const;

export type Surface = (typeof surfaces)[number]["id"];

export function findSurface(id?: string) {
  return surfaces.find((surface) => surface.id === id);
}
