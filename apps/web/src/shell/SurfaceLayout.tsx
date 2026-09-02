import type { ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

export interface SurfaceLayoutProps {
  id: string;
  /** Header line above the main pane. */
  title: ReactNode;
  headerRight?: ReactNode;
  main: ReactNode;
  sidebarTitle: ReactNode;
  sidebar: ReactNode;
}

/** `Main | Sidebar (280px)` — the right half of the shell (PLAN.md §7). */
export function SurfaceLayout({
  id,
  title,
  headerRight,
  main,
  sidebarTitle,
  sidebar,
}: SurfaceLayoutProps) {
  return (
    <Group orientation="horizontal" id={`surface-${id}`}>
      <Panel id="main" minSize="360px" className="nx-panel">
        <div className="surface">
          <header className="surface__head">
            <span className="surface__title">{title}</span>
            {headerRight ? <span className="surface__head-right">{headerRight}</span> : null}
          </header>
          <div className="surface__main">{main}</div>
        </div>
      </Panel>
      <Separator className="nx-sep-v" />
      <Panel
        id="sidebar"
        defaultSize="280px"
        minSize="200px"
        maxSize="460px"
        groupResizeBehavior="preserve-pixel-size"
        className="nx-panel"
      >
        <aside className="sidebar">
          <div className="sidebar__head">{sidebarTitle}</div>
          <div className="sidebar__body">{sidebar}</div>
        </aside>
      </Panel>
    </Group>
  );
}
