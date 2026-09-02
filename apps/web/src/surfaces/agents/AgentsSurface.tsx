import type { Agent } from "@nexestra/core";
import { Button, StatusDot, Tag } from "@nexestra/ui-kit";
import { useState } from "react";
import { useAgents, useDeleteAgent, useThreads, useUpdateThread } from "../../lib/api.js";
import { SurfaceLayout } from "../../shell/SurfaceLayout.js";
import { AgentDialog } from "./AgentDialog.js";

export function AgentsSurface({
  workspaceId,
  threadId,
}: {
  workspaceId: string;
  threadId: string;
}) {
  const agents = useAgents(workspaceId);
  const threads = useThreads(workspaceId);
  const updateThread = useUpdateThread(workspaceId);
  const deleteAgent = useDeleteAgent(workspaceId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const thread = (threads.data ?? []).find((entry) => entry.id === threadId);
  const rows = agents.data ?? [];
  const selected = rows.find((agent) => agent.id === selectedId) ?? rows[0];

  return (
    <>
      <SurfaceLayout
        id="agents"
        title={`Agents — ${thread?.title ?? threadId}`}
        headerRight={
          <Button tone="primary" boxed onClick={() => setDialogOpen(true)}>
            + New agent
          </Button>
        }
        main={
          <div className="agents nx-scroll">
            <div className="agents__intro">
              <strong>Project agents</strong>
              <span>
                Nexestra agents lead chat and planning. Codex and OpenCode agents execute tasks.
              </span>
            </div>
            {agents.isPending ? <div className="state">loading agents…</div> : null}
            {agents.isError ? <div className="state">{agents.error.message}</div> : null}
            {!agents.isPending && rows.length === 0 ? (
              <div className="agents__empty">
                <span className="agents__empty-mark">@</span>
                <strong>No agents configured</strong>
                <span>Create a Master or worker profile to start assigning work.</span>
                <Button tone="primary" boxed onClick={() => setDialogOpen(true)}>
                  Create your first agent
                </Button>
              </div>
            ) : null}
            <div className="agents__grid">
              {rows.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  selected={selected?.id === agent.id}
                  active={thread?.agentId === agent.id}
                  onSelect={() => setSelectedId(agent.id)}
                  onUse={() => updateThread.mutate({ threadId, patch: { agentId: agent.id } })}
                />
              ))}
            </div>
          </div>
        }
        sidebarTitle="Agent details"
        sidebar={
          selected ? (
            <AgentDetails
              agent={selected}
              active={thread?.agentId === selected.id}
              deleting={deleteAgent.isPending}
              error={deleteAgent.error?.message ?? updateThread.error?.message ?? null}
              onDelete={() => deleteAgent.mutate(selected.id)}
              onUse={() => updateThread.mutate({ threadId, patch: { agentId: selected.id } })}
              onUseDefault={() => updateThread.mutate({ threadId, patch: { agentId: null } })}
            />
          ) : (
            <div className="nx-muted">Select an agent to inspect its assignment.</div>
          )
        }
      />
      <AgentDialog
        open={dialogOpen}
        workspaceId={workspaceId}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}

function AgentCard({
  agent,
  selected,
  active,
  onSelect,
  onUse,
}: {
  agent: Agent;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  onUse: () => void;
}) {
  return (
    <article className={`agent-card${selected ? " agent-card--selected" : ""}`}>
      <button className="agent-card__select" type="button" onClick={onSelect}>
        <span className="agent-card__avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
        <span className="agent-card__identity">
          <strong>{agent.name}</strong>
          <span>{agent.description || "No description"}</span>
        </span>
      </button>
      <div className="agent-card__meta">
        <Tag tone={agent.harness === "nexestra" ? "magenta" : "info"}>{agent.harness}</Tag>
        <span>{agent.model ?? "harness default"}</span>
        <StatusDot tone={agent.enabled ? "done" : "idle"} label={agent.enabled ? "ready" : "off"} />
      </div>
      {agent.harness === "nexestra" ? (
        <Button onClick={onUse} disabled={active}>
          {active ? "Active in chat" : "Use in this chat"}
        </Button>
      ) : (
        <span className="nx-muted">Assign from the Task Board</span>
      )}
    </article>
  );
}

function AgentDetails({
  agent,
  active,
  deleting,
  error,
  onDelete,
  onUse,
  onUseDefault,
}: {
  agent: Agent;
  active: boolean;
  deleting: boolean;
  error: string | null;
  onDelete: () => void;
  onUse: () => void;
  onUseDefault: () => void;
}) {
  return (
    <>
      <div className="kv">
        <span className="kv__k">harness</span>
        <span className="kv__v">{agent.harness}</span>
        <span className="kv__k">provider</span>
        <span className="kv__v">{agent.providerId ?? "—"}</span>
        <span className="kv__k">model</span>
        <span className="kv__v">{agent.model ?? "default"}</span>
        <span className="kv__k">status</span>
        <span className="kv__v">{agent.enabled ? "enabled" : "disabled"}</span>
      </div>
      <section className="sidebar__section">
        <div className="sidebar__section-title">Instructions</div>
        <div className="agent-details__instructions">
          {agent.instructions || "No persistent instructions."}
        </div>
      </section>
      {agent.harness === "nexestra" ? (
        <div className="sidebar__actions">
          <Button tone="primary" onClick={active ? onUseDefault : onUse}>
            {active ? "Use global Master" : "Use in this chat"}
          </Button>
        </div>
      ) : null}
      <div className="sidebar__actions">
        <Button tone="danger" onClick={onDelete} disabled={deleting}>
          Delete agent
        </Button>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </>
  );
}
