import { Button } from "@nexestra/ui-kit";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCreateThread, useThreads, useWorkspaces } from "../lib/api.js";
import { PromptDialog } from "./PromptDialog.js";
import { SURFACE_ROUTES } from "./surfaces.js";
import { WorkspaceRail } from "./WorkspaceRail.js";

/**
 * `/w/:workspaceId` — jump to the workspace's first thread, or offer to create
 * one. A workspace added from the rail lands here with nothing in it yet.
 */
export function EmptyWorkspace({ workspaceId }: { workspaceId: string }) {
  const workspaces = useWorkspaces();
  const threads = useThreads(workspaceId);
  const createThread = useCreateThread(workspaceId);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const workspace = (workspaces.data ?? []).find((item) => item.id === workspaceId);
  const firstThreadId = threads.data?.[0]?.id;

  useEffect(() => {
    if (firstThreadId) {
      void navigate({
        to: SURFACE_ROUTES.chat,
        params: { workspaceId, threadId: firstThreadId },
        replace: true,
      });
    }
  }, [firstThreadId, workspaceId, navigate]);

  return (
    <div className="app">
      <WorkspaceRail activeWorkspaceId={workspaceId} />
      <div className="app__body">
        <div className="empty-workspace">
          {workspaceId === "" ? (
            <>
              <span style={{ color: "var(--nx-fg-strong)" }}>No workspace yet.</span>
              <span>
                Add one with <b>+</b> in the rail on the left — point it at a git repository on this
                machine.
              </span>
            </>
          ) : threads.isPending ? (
            <span>loading threads…</span>
          ) : (
            <>
              <span style={{ color: "var(--nx-fg-strong)" }}>
                {workspace?.name ?? workspaceId} has no threads yet.
              </span>
              <span>{workspace?.rootPath}</span>
              <Button
                tone="primary"
                onClick={() => {
                  createThread.reset();
                  setOpen(true);
                }}
              >
                New thread
              </Button>
            </>
          )}
        </div>
      </div>

      <PromptDialog
        open={open}
        title="New thread"
        label="Title"
        placeholder="Add a CLI to the todo app"
        submitLabel="Create thread"
        error={createThread.error?.message ?? null}
        busy={createThread.isPending}
        onClose={() => setOpen(false)}
        onSubmit={(title) => {
          createThread.mutate(
            { title },
            {
              onSuccess: (thread) => {
                setOpen(false);
                void navigate({
                  to: SURFACE_ROUTES.chat,
                  params: { workspaceId, threadId: thread.id },
                });
              },
            },
          );
        }}
      />
    </div>
  );
}
