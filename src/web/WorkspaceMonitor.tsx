import { Activity, ArrowRight, CircleAlert, Clock3, Play } from "lucide-react";
import type { Workspace, WorkspaceActivitySummary } from "../shared/contracts.js";
import "./workspace-monitor.css";

export function formatWorkspaceActivityAge(observedAt?: string, now = Date.now()): string {
  if (!observedAt) return "Age unavailable";
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return "Age unavailable";
  const seconds = Math.max(0, Math.floor((now - observed) / 1_000));
  if (seconds < 60) return "Observed just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Observed ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Observed ${hours}h ago`;
}

export function WorkspaceMonitor({
  activeWorkspaceId,
  workspaces,
  archivedWorkspaces = [],
  summaries = [],
  onWorkspace,
  onAttention,
}: {
  activeWorkspaceId: string;
  workspaces: Workspace[];
  archivedWorkspaces?: Workspace[];
  summaries?: WorkspaceActivitySummary[];
  onWorkspace: (workspaceId: string) => void;
  onAttention: (workspaceId: string) => void;
}) {
  const summaryByWorkspace = new Map(summaries.map((summary) => [summary.workspaceId, summary]));
  const rows = [
    ...workspaces.map((workspace) => ({ workspace, archived: false })),
    ...archivedWorkspaces.map((workspace) => ({ workspace, archived: true })),
  ];
  return (
    <div className="surface-view workspace-monitor">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">WORKSPACE</p>
          <h1>Monitor</h1>
          <p className="subtitle">
            See activity across workspaces without loading transcripts or run details.
          </p>
        </div>
        <span className="attention-total">{rows.length} workspaces</span>
      </header>
      {rows.length === 0 ? (
        <div className="empty-state">
          <span>
            <Activity size={25} />
          </span>
          <h2>No workspaces yet</h2>
          <p>Create a workspace to start monitoring agent activity.</p>
        </div>
      ) : (
        <ul className="workspace-monitor-list" aria-label="Workspace activity monitor">
          {rows.map(({ workspace, archived }) => {
            const summary = summaryByWorkspace.get(workspace.id);
            const attentionCount = summary?.attentionCount ?? 0;
            const activeRunCount = summary?.activeRunCount ?? 0;
            return (
              <li className="workspace-monitor-row" key={workspace.id}>
                <div className="workspace-monitor-identity">
                  <span className="workspace-monitor-icon">
                    {archived ? <Clock3 size={18} /> : <Activity size={18} />}
                  </span>
                  <div>
                    <h2>{workspace.name}</h2>
                    <p>
                      {archived
                        ? "Archived workspace"
                        : formatWorkspaceActivityAge(summary?.observedAt)}
                    </p>
                  </div>
                </div>
                <div className="workspace-monitor-counts">
                  <span>
                    <Play size={14} /> {activeRunCount} active
                  </span>
                  <span>
                    <CircleAlert size={14} /> {attentionCount} attention
                  </span>
                </div>
                <div className="workspace-monitor-actions">
                  {!archived && (
                    <button
                      className={workspace.id === activeWorkspaceId ? "active" : ""}
                      type="button"
                      onClick={() => onWorkspace(workspace.id)}
                    >
                      {workspace.id === activeWorkspaceId ? "Current workspace" : "Open workspace"}
                      {workspace.id !== activeWorkspaceId && <ArrowRight size={15} />}
                    </button>
                  )}
                  {!archived && attentionCount > 0 && (
                    <button type="button" onClick={() => onAttention(workspace.id)}>
                      Needs attention <ArrowRight size={15} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
