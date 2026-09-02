import type { ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { CommandPalette } from "./CommandPalette.js";
import { NavigationPanel } from "./NavigationPanel.js";
import type { SurfaceId } from "./surfaces.js";
import { useShellKeyboard } from "./useShellKeyboard.js";
import { WorkspaceRail } from "./WorkspaceRail.js";

export interface AppShellProps {
  workspaceId: string;
  threadId: string;
  surface: SurfaceId;
  children: ReactNode;
}

/** `WS rail (48px) | Navigation (260px) | Main | Sidebar (280px)` (PLAN.md §7). */
export function AppShell({ workspaceId, threadId, surface, children }: AppShellProps) {
  useShellKeyboard({ workspaceId, threadId });

  return (
    <div className="app">
      <WorkspaceRail activeWorkspaceId={workspaceId} />
      <div className="app__body">
        <Group orientation="horizontal" id="shell">
          <Panel
            id="navigation"
            defaultSize="260px"
            groupResizeBehavior="preserve-pixel-size"
            minSize="180px"
            maxSize="420px"
            className="nx-panel"
          >
            <NavigationPanel workspaceId={workspaceId} threadId={threadId} surface={surface} />
          </Panel>
          <Separator className="nx-sep-v" />
          <Panel id="content" minSize="480px" className="nx-panel">
            {children}
          </Panel>
        </Group>
      </div>
      <CommandPalette workspaceId={workspaceId} threadId={threadId} />
    </div>
  );
}
