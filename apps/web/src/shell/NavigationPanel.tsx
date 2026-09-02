import { Button } from "@nexestra/ui-kit";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useCreateThread, useThreads } from "../lib/api.js";
import { ApprovalQueuePanel, usePendingApprovalCount } from "./ApprovalQueuePanel.js";
import { PromptDialog } from "./PromptDialog.js";
import { SURFACE_ROUTES, SURFACES, type SurfaceId } from "./surfaces.js";

export interface NavigationPanelProps {
  workspaceId: string;
  threadId: string;
  surface: SurfaceId;
}

const SURFACE_ICONS: Record<SurfaceId, string> = {
  chat: "⌁",
  board: "☷",
  editor: "</>",
  memory: "◇",
};

export function NavigationPanel({ workspaceId, threadId, surface }: NavigationPanelProps) {
  const navigate = useNavigate();
  const threads = useThreads(workspaceId);
  const createThread = useCreateThread(workspaceId);
  const pendingApprovals = usePendingApprovalCount(workspaceId);
  const [open, setOpen] = useState(false);

  return (
    <nav className="nav" aria-label="Navigation">
      <div className="nav__head">
        <span>Work streams</span>
        <span className="nav__head-actions">
          <Button
            title="New thread"
            aria-label="New thread"
            onClick={() => {
              createThread.reset();
              setOpen(true);
            }}
          >
            +
          </Button>
        </span>
      </div>

      <div className="nav__threads">
        {(threads.data ?? []).map((thread) => {
          const active = thread.id === threadId;
          return (
            <button
              key={thread.id}
              type="button"
              className={`nav__thread${active ? " nav__thread--active" : ""}`}
              onClick={() =>
                navigate({
                  to: SURFACE_ROUTES[surface],
                  params: { workspaceId, threadId: thread.id },
                })
              }
            >
              <span className="nav__thread-marker" aria-hidden="true">
                #
              </span>
              <span className="nav__thread-title">{thread.title}</span>
              {active ? <span className="nav__thread-phase">{thread.phase}</span> : null}
            </button>
          );
        })}
        {threads.isPending ? <div className="state">loading threads…</div> : null}
      </div>

      <div className="nav__head">
        <span>Project hub</span>
      </div>
      <div className="nav__surfaces">
        {SURFACES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav__surface${item.id === surface ? " nav__surface--active" : ""}`}
            aria-current={item.id === surface ? "page" : undefined}
            onClick={() =>
              navigate({
                to: SURFACE_ROUTES[item.id],
                params: { workspaceId, threadId },
              })
            }
          >
            <span className="nav__surface-icon" aria-hidden="true">
              {SURFACE_ICONS[item.id]}
            </span>
            <span className="nav__surface-label">{item.label}</span>
            <kbd className="nav__surface-shortcut">{item.shortcut}</kbd>
          </button>
        ))}
      </div>

      {/*
        The approval queue is global on purpose: the orchestrator raises gates
        (sandbox escalation, spend, merge, manual verification, a harness asking
        mid-run) while the user is looking at any surface, and each one blocks a
        run until it is resolved.
      */}
      <div className="nav__head" id="approval-queue">
        <span>Approvals</span>
        {pendingApprovals > 0 ? (
          <span className="nav__head-actions">
            <span className="nav__badge">{pendingApprovals}</span>
          </span>
        ) : null}
      </div>
      <div className="nav__approvals nx-scroll">
        <ApprovalQueuePanel workspaceId={workspaceId} threadId={threadId} />
      </div>

      <div className="nav__spacer" />

      <div className="nav__foot">
        <button
          type="button"
          className="nav__surface"
          onClick={() => navigate({ to: "/settings" })}
        >
          <span className="nav__surface-icon" aria-hidden="true">
            ⚙
          </span>
          <span className="nav__surface-label">Settings</span>
          <kbd className="nav__surface-shortcut">⌘,</kbd>
        </button>
      </div>

      <PromptDialog
        open={open}
        title="New thread"
        label="Title"
        hint="A short name for the piece of work you want Master to take on."
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
    </nav>
  );
}
