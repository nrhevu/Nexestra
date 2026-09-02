import { Rail } from "@nexestra/ui-kit";
import { useWorkspaces } from "../lib/api.js";

export function WorkspaceRail({ activeWorkspaceId }: { activeWorkspaceId: string }) {
  const workspaces = useWorkspaces();

  const items = (workspaces.data ?? []).map((workspace) => ({
    id: workspace.id,
    label: workspace.shortLabel,
    title: `${workspace.name} — ${workspace.rootPath}`,
  }));

  return (
    <Rail items={items} activeId={activeWorkspaceId}>
      <button
        type="button"
        className="nx-rail__item"
        title="Add workspace (not wired up in M0)"
        aria-label="Add workspace"
      >
        +
      </button>
    </Rail>
  );
}
