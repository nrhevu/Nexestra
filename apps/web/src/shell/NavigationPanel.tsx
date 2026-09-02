import { Button, Checkbox, Divider, Kbd } from "@nexestra/ui-kit";
import { useNavigate } from "@tanstack/react-router";
import { useThreads } from "../lib/api.js";
import { SURFACE_ROUTES, SURFACES, type SurfaceId } from "./surfaces.js";

export interface NavigationPanelProps {
  workspaceId: string;
  threadId: string;
  surface: SurfaceId;
}

export function NavigationPanel({ workspaceId, threadId, surface }: NavigationPanelProps) {
  const navigate = useNavigate();
  const threads = useThreads(workspaceId);

  return (
    <nav className="nav" aria-label="Navigation">
      <div className="nav__head">
        <span>Threads</span>
        <span className="nav__head-actions">
          <Button title="New thread (not wired up in M0)" aria-label="New thread">
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
              <span className="nav__thread-marker">{active ? ">" : ""}</span>
              <span className="nav__thread-title">{thread.title}</span>
              <span className="nav__thread-phase">{thread.phase}</span>
            </button>
          );
        })}
        {threads.isPending ? <div className="state">loading threads…</div> : null}
      </div>

      <Divider />

      <div className="nav__head">
        <span>Surfaces</span>
      </div>
      <div className="nav__surfaces">
        {SURFACES.map((item) => (
          <Checkbox
            key={item.id}
            checked={item.id === surface}
            label={item.label}
            hint={<Kbd>{item.shortcut}</Kbd>}
            onChange={() =>
              navigate({
                to: SURFACE_ROUTES[item.id],
                params: { workspaceId, threadId },
              })
            }
          />
        ))}
      </div>

      <div className="nav__spacer" />

      <div className="nav__foot">
        <Checkbox
          checked={false}
          label="Settings"
          hint={<Kbd>⌘,</Kbd>}
          onChange={() => navigate({ to: "/settings" })}
        />
      </div>
    </nav>
  );
}
