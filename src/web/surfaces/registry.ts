import { BookOpen, Columns3, Target, UsersRound } from "lucide-react";
import type { BootstrapData } from "../../shared/contracts.js";

// Trusted built-ins only. External extension loading has a separate, proposed boundary.
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
