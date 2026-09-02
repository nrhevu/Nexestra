import { Rail } from "@nexestra/ui-kit";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ApiRequestError, useCreateWorkspace, useWorkspaces } from "../lib/api.js";
import { usePendingApprovalCount } from "./ApprovalQueuePanel.js";
import { PromptDialog } from "./PromptDialog.js";

export function WorkspaceRail({ activeWorkspaceId }: { activeWorkspaceId: string }) {
  const workspaces = useWorkspaces();
  const createWorkspace = useCreateWorkspace();
  const navigate = useNavigate();
  const pendingApprovals = usePendingApprovalCount(activeWorkspaceId);
  const [open, setOpen] = useState(false);

  const items = (workspaces.data ?? []).map((workspace) => ({
    id: workspace.id,
    label: workspace.shortLabel,
    title: `${workspace.name} — ${workspace.rootPath}`,
  }));

  const error =
    createWorkspace.error instanceof ApiRequestError ? createWorkspace.error.message : null;

  return (
    <>
      <Rail
        items={items}
        activeId={activeWorkspaceId}
        onSelect={(workspaceId) =>
          void navigate({ to: "/w/$workspaceId", params: { workspaceId } })
        }
        footer={
          pendingApprovals > 0 ? (
            <a
              className="nx-rail__item rail__approvals"
              href="#approval-queue"
              title={`${pendingApprovals} approval(s) waiting on you`}
              aria-label={`${pendingApprovals} approvals pending`}
            >
              {pendingApprovals}
            </a>
          ) : null
        }
      >
        <button
          type="button"
          className="nx-rail__item"
          title="Add a workspace"
          aria-label="Add workspace"
          onClick={() => {
            createWorkspace.reset();
            setOpen(true);
          }}
        >
          +
        </button>
      </Rail>

      <PromptDialog
        open={open}
        title="New workspace"
        label="Repository path"
        hint="An absolute path to a git repository on this machine, e.g. /Users/you/Works/my-app."
        placeholder="/Users/you/Works/my-app"
        submitLabel="Add workspace"
        error={error}
        busy={createWorkspace.isPending}
        onClose={() => setOpen(false)}
        onSubmit={(path) => {
          createWorkspace.mutate(
            { path },
            {
              onSuccess: (workspace) => {
                setOpen(false);
                void navigate({
                  to: "/w/$workspaceId",
                  params: { workspaceId: workspace.id },
                });
              },
            },
          );
        }}
      />
    </>
  );
}
