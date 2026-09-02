export type SurfaceId = "chat" | "board" | "agents" | "editor" | "memory";

export interface SurfaceDescriptor {
  id: SurfaceId;
  label: string;
  /** Title rendered in the surface header. */
  heading: string;
  shortcut: string;
}

export const SURFACES: readonly SurfaceDescriptor[] = [
  { id: "chat", label: "Workspace / Chat", heading: "Chat", shortcut: "⌘1" },
  { id: "board", label: "Task Board", heading: "Task Board", shortcut: "⌘2" },
  { id: "agents", label: "Agents", heading: "Agents", shortcut: "⌘3" },
  { id: "editor", label: "Editor / Runs", heading: "Editor", shortcut: "⌘4" },
  { id: "memory", label: "Memory Graph", heading: "Memory Graph", shortcut: "⌘5" },
];

export const SURFACE_IDS: readonly SurfaceId[] = SURFACES.map((surface) => surface.id);

/** One concrete route per surface, as required by the URL contract. */
export const SURFACE_ROUTES = {
  chat: "/w/$workspaceId/t/$threadId/chat",
  board: "/w/$workspaceId/t/$threadId/board",
  agents: "/w/$workspaceId/t/$threadId/agents",
  editor: "/w/$workspaceId/t/$threadId/editor",
  memory: "/w/$workspaceId/t/$threadId/memory",
} as const satisfies Record<SurfaceId, string>;

export function isSurfaceId(value: string): value is SurfaceId {
  return (SURFACE_IDS as readonly string[]).includes(value);
}
