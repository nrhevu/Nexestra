import { Select, Tag } from "@nexestra/ui-kit";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useRunFiles, useThreads } from "../../lib/api.js";
import { useUiStore } from "../../lib/store.js";
import { SurfaceLayout } from "../../shell/SurfaceLayout.js";
import { CodePane } from "./CodePane.js";
import { DiffPane } from "./DiffPane.js";
import { EditorSidebar } from "./EditorSidebar.js";
import { FileTree } from "./FileTree.js";
import { TerminalPane } from "./TerminalPane.js";
import { useActiveRun } from "./useActiveRun.js";

/**
 * Surface 3 — one harness run, from three angles at once.
 *
 * Everything on it is scoped to a single `Run`: the file tree is that run's
 * git worktree, the editor reads files out of it, the diff is it against the
 * branch it was cut from, and the terminal is its event stream. Picking a
 * different run swaps all four, which is why the picker is in the header
 * rather than buried in the sidebar.
 */
export function EditorSurface({
  workspaceId,
  threadId,
}: {
  workspaceId: string;
  threadId: string;
}) {
  const threads = useThreads(workspaceId);
  const thread = (threads.data ?? []).find((item) => item.id === threadId);
  const { run, runs, following } = useActiveRun(threadId);
  const tree = useRunFiles(run?.id);

  const openFilePath = useUiStore((state) => state.openFilePath);
  const selectedRunId = useUiStore((state) => state.selectedRunId);
  const diffMode = useUiStore((state) => state.diffMode);
  const openRun = useUiStore((state) => state.openRun);

  const runOptions = [
    { value: "", label: following ? "latest run (following)" : "latest run" },
    ...runs
      .slice()
      .reverse()
      .map((item) => ({
        value: item.id,
        label: `${item.kind} · ${item.harness} · ${item.status}`,
      })),
  ];

  return (
    <SurfaceLayout
      id="editor"
      title={`Editor — ${thread?.title ?? threadId}`}
      headerRight={
        <>
          <Select
            id="editor-run"
            label="Run"
            value={selectedRunId ?? ""}
            options={runOptions}
            onChange={(event) => openRun(event.target.value === "" ? null : event.target.value)}
          />
          {run?.worktreePath ? (
            <Tag tone="info">{shortenPath(run.worktreePath)}</Tag>
          ) : (
            <Tag>no worktree</Tag>
          )}
          <span className="nx-muted">{diffMode ? "unified diff" : (openFilePath ?? "—")}</span>
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
                  <div className="nav__head">
                    <span>Files</span>
                    {run ? <span className="nav__head-actions nx-muted">{run.kind}</span> : null}
                  </div>
                  <div className="nx-scroll" style={{ flex: "1 1 auto" }}>
                    {run ? (
                      <FileTree nodes={tree.data ?? []} />
                    ) : (
                      <div className="state">nothing has run on this thread yet</div>
                    )}
                    {run && tree.isError ? <div className="state">{tree.error.message}</div> : null}
                  </div>
                </div>
              </Panel>
              <Separator className="nx-sep-v" />
              <Panel id="code" minSize="260px" className="nx-panel">
                {diffMode ? (
                  <DiffPane runId={run?.id} />
                ) : (
                  <CodePane runId={run?.id} path={openFilePath} />
                )}
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
            <TerminalPane run={run} />
          </Panel>
        </Group>
      }
      sidebarTitle="Agent"
      sidebar={<EditorSidebar threadId={threadId} />}
    />
  );
}

/** Worktree paths are long and the interesting half is the tail. */
function shortenPath(value: string): string {
  const parts = value.split("/");
  return parts.length <= 3 ? value : `…/${parts.slice(-3).join("/")}`;
}
