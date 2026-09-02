import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useThreads, useWorkspaces } from "../lib/api.js";
import { useThreadEvents } from "../lib/events.js";
import { useUiStore } from "../lib/store.js";
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

/** Slack-like top bar over `workspace rail | navigation | main | context`. */
export function AppShell({ workspaceId, threadId, surface, children }: AppShellProps) {
  useShellKeyboard({ workspaceId, threadId });
  // One `/ws` subscription per mounted shell; incoming events update the cache.
  useThreadEvents(workspaceId, threadId);
  const workspaces = useWorkspaces();
  const threads = useThreads(workspaceId);
  const workspace = (workspaces.data ?? []).find((item) => item.id === workspaceId);
  const thread = (threads.data ?? []).find((item) => item.id === threadId);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const navigate = useNavigate();

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__brand-mark">N</span>
          <span className="topbar__brand-name">Nexestra</span>
        </div>
        <button
          type="button"
          className="topbar__search"
          onClick={() => setPaletteOpen(true)}
          aria-label="Search and open command palette"
        >
          <span className="topbar__search-icon" aria-hidden="true">
            ⌕
          </span>
          <span className="topbar__search-label">Search {workspace?.name ?? "workspace"}</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="topbar__context" title={thread?.title}>
          {thread?.title ?? "Loading thread…"}
        </div>
        <div className="topbar__actions">
          <button
            type="button"
            className="topbar__action"
            onClick={toggleTheme}
            aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
            title={`Use ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button
            type="button"
            className="topbar__action"
            onClick={() => navigate({ to: "/settings" })}
            aria-label="Open settings"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>
      <div className="app__workspace">
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
      </div>
      <CommandPalette workspaceId={workspaceId} threadId={threadId} />
    </div>
  );
}
