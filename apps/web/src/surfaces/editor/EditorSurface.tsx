import { Tag } from "@nexestra/ui-kit";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useFileTree, useThreads } from "../../lib/api.js";
import { useUiStore } from "../../lib/store.js";
import { SurfaceLayout } from "../../shell/SurfaceLayout.js";
import { CodePane } from "./CodePane.js";
import { EditorSidebar } from "./EditorSidebar.js";
import { FileTree } from "./FileTree.js";
import { TerminalPane } from "./TerminalPane.js";

export function EditorSurface({
  workspaceId,
  threadId,
}: {
  workspaceId: string;
  threadId: string;
}) {
  const threads = useThreads(workspaceId);
  const thread = (threads.data ?? []).find((item) => item.id === threadId);
  const tree = useFileTree();
  const openFilePath = useUiStore((state) => state.openFilePath);

  return (
    <SurfaceLayout
      id="editor"
      title={`Editor — ${thread?.title ?? threadId}`}
      headerRight={
        <>
          <Tag tone="info">.nexestra/worktrees/task_opencode</Tag>
          <span className="nx-muted">{openFilePath}</span>
        </>
      }
      main={
        <Group orientation="vertical" id="editor-vertical">
          <Panel id="editor-top" minSize="140px" className="nx-panel">
            <Group orientation="horizontal" id="editor-horizontal">
              <Panel
                id="files"
                defaultSize="220px"
                groupResizeBehavior="preserve-pixel-size"
                minSize="140px"
                maxSize="360px"
                className="nx-panel"
              >
                <div className="nav" style={{ borderRight: "1px solid var(--nx-border)" }}>
                  <div className="nav__head">Files</div>
                  <div className="nx-scroll" style={{ flex: "1 1 auto" }}>
                    <FileTree nodes={tree.data ?? []} />
                  </div>
                </div>
              </Panel>
              <Separator className="nx-sep-v" />
              <Panel id="code" minSize="260px" className="nx-panel">
                <CodePane path={openFilePath} />
              </Panel>
            </Group>
          </Panel>
          <Separator className="nx-sep-h" />
          <Panel
            id="terminal"
            defaultSize="200px"
            groupResizeBehavior="preserve-pixel-size"
            minSize="80px"
            maxSize="480px"
            className="nx-panel"
          >
            <TerminalPane />
          </Panel>
        </Group>
      }
      sidebarTitle="Agent"
      sidebar={<EditorSidebar threadId={threadId} />}
    />
  );
}
