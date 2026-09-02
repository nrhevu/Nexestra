import { Button, StatusDot, Tag } from "@nexestra/ui-kit";
import {
  useApprovals,
  useArtifacts,
  useMemories,
  useResolveApproval,
  useSpec,
} from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";

export function ChatSidebar({ workspaceId, threadId }: { workspaceId: string; threadId: string }) {
  const spec = useSpec(threadId);
  const memories = useMemories(workspaceId);
  const artifacts = useArtifacts(threadId);
  const approvals = useApprovals(workspaceId);
  const resolveApproval = useResolveApproval(workspaceId);

  const pending = (approvals.data ?? []).filter(
    (approval) => approval.status === "pending" && approval.threadId === threadId,
  );
  const references = (memories.data ?? []).filter((memory) => memory.threadId === threadId);

  return (
    <>
      {pending.length > 0 ? (
        <section className="sidebar__section">
          <div className="sidebar__section-title">Approval queue ({pending.length})</div>
          {pending.map((approval) => (
            <div className="card" key={approval.id} style={{ margin: "0 0 6px" }}>
              <div className="card__head">
                <StatusDot tone={approval.risk === "high" ? "error" : "warn"} />
                <span className="card__title">{approval.title}</span>
              </div>
              <div className="card__body">
                <div style={{ marginBottom: 6 }}>{approval.description}</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Tag tone={approval.risk === "high" ? "danger" : "warn"}>{approval.kind}</Tag>
                  <span className="nx-muted">{formatDateTime(approval.requestedAt)}</span>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <Button
                    tone="primary"
                    disabled={resolveApproval.isPending}
                    onClick={() =>
                      resolveApproval.mutate({ approvalId: approval.id, status: "approved" })
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    tone="danger"
                    disabled={resolveApproval.isPending}
                    onClick={() =>
                      resolveApproval.mutate({ approvalId: approval.id, status: "rejected" })
                    }
                  >
                    Reject
                  </Button>
                </div>
                {resolveApproval.isError ? (
                  <div className="form-error">{resolveApproval.error.message}</div>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="sidebar__section">
        <div className="sidebar__section-title">Requirements</div>
        {spec.data ? (
          <ul className="sidebar__list">
            {spec.data.scope.in.map((item) => (
              <li key={item}>
                <span className="sidebar__bullet">+</span>
                <span>{item}</span>
              </li>
            ))}
            {spec.data.scope.out.map((item) => (
              <li key={item}>
                <span className="sidebar__bullet">−</span>
                <span className="nx-muted">{item}</span>
              </li>
            ))}
            {spec.data.constraints.map((item) => (
              <li key={item}>
                <span className="sidebar__bullet">!</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="nx-muted">No spec yet — Master is still clarifying.</div>
        )}
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">Decisions</div>
        {spec.data && spec.data.decisions.length > 0 ? (
          <ul className="sidebar__list">
            {spec.data.decisions.map((decision) => (
              <li key={decision.id}>
                <span className="sidebar__bullet">·</span>
                <span>
                  {decision.text}
                  <br />
                  <span className="nx-muted">{decision.rationale}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="nx-muted">No decisions recorded.</div>
        )}
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">References</div>
        <ul className="sidebar__list">
          {references.slice(0, 6).map((memory) => (
            <li key={memory.id}>
              <span className="sidebar__bullet">#</span>
              <span>
                {memory.title} <Tag>{memory.type}</Tag>
              </span>
            </li>
          ))}
          {(artifacts.data ?? []).slice(0, 4).map((artifact) => (
            <li key={artifact.id}>
              <span className="sidebar__bullet">@</span>
              <span>
                {artifact.title} <Tag tone="info">{artifact.kind}</Tag>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
