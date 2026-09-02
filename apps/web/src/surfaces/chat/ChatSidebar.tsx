import { Button, StatusDot, Tag } from "@nexestra/ui-kit";
import {
  useAgents,
  useApprovals,
  useArtifacts,
  useExecutionStatus,
  useMasterState,
  useMemories,
  useResolveApproval,
  useSpec,
  useThreads,
} from "../../lib/api.js";
import { formatDateTime, formatUsd } from "../../lib/format.js";
import { SpecCard } from "./SpecCard.js";

/**
 * Surface 1's sidebar: the Master's current picture of the work.
 *
 * Requirements is the live Spec — the same component Chat shows inline when an
 * approval is waiting, so the two can never disagree. Decisions merges the
 * spec's own `decisions` with the memories the Master recorded as
 * `type: "decision"`, because a decision reached mid-conversation lands in the
 * memory graph rather than in the spec.
 */
export function ChatSidebar({ workspaceId, threadId }: { workspaceId: string; threadId: string }) {
  const spec = useSpec(threadId);
  const agents = useAgents(workspaceId);
  const memories = useMemories(workspaceId);
  const artifacts = useArtifacts(threadId);
  const approvals = useApprovals(workspaceId);
  const masterState = useMasterState(threadId);
  const execution = useExecutionStatus(threadId);
  const threads = useThreads(workspaceId);
  const resolveApproval = useResolveApproval(workspaceId);

  const pending = (approvals.data ?? []).filter(
    (approval) => approval.status === "pending" && approval.threadId === threadId,
  );
  const threadMemories = (memories.data ?? []).filter((memory) => memory.threadId === threadId);
  const decisions = threadMemories.filter((memory) => memory.type === "decision");
  const references = threadMemories.filter((memory) => memory.type !== "decision");
  const usage = masterState.data?.usage;

  // Two costs, deliberately: the Master's own tokens and everything the
  // harnesses spent. The budget belongs to the thread and covers both.
  const thread = (threads.data ?? []).find((item) => item.id === threadId);
  const activeAgent = (agents.data ?? []).find((agent) => agent.id === thread?.agentId);
  const budgetUSD = execution.data?.budgetUSD ?? thread?.budgetUSD ?? 0;
  const spentUSD = execution.data?.costUSD ?? thread?.costUSD ?? 0;
  const ratio = budgetUSD > 0 ? Math.min(1, spentUSD / budgetUSD) : 0;

  return (
    <>
      <section className="sidebar__section">
        <div className="sidebar__section-title">
          Budget — {formatUsd(spentUSD)} / {formatUsd(budgetUSD)}
        </div>
        <div className="progress">
          <div
            className={`progress__fill${ratio >= 1 ? " progress__fill--over" : ratio >= 0.8 ? " progress__fill--warn" : ""}`}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
        <div className="nx-muted" style={{ marginTop: 4 }}>
          {ratio >= 1
            ? "budget exhausted — execution pauses itself"
            : ratio >= 0.8
              ? "past 80% — a spend approval has been raised"
              : `${Math.round(ratio * 100)}% of the thread budget`}
        </div>
      </section>

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
          <SpecCard spec={spec.data} bare />
        ) : (
          <div className="nx-muted">No spec yet — Master is still clarifying.</div>
        )}
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">Decisions</div>
        {(spec.data?.decisions.length ?? 0) === 0 && decisions.length === 0 ? (
          <div className="nx-muted">No decisions recorded.</div>
        ) : (
          <ul className="sidebar__list">
            {(spec.data?.decisions ?? []).map((decision) => (
              <li key={decision.id}>
                <span className="sidebar__bullet">·</span>
                <span>
                  {decision.text}
                  {decision.rationale ? (
                    <>
                      <br />
                      <span className="nx-muted">{decision.rationale}</span>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
            {decisions.map((memory) => (
              <li key={memory.id}>
                <span className="sidebar__bullet">·</span>
                <span>
                  {memory.title}
                  <br />
                  <span className="nx-muted">{memory.content}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">References</div>
        {references.length === 0 && (artifacts.data ?? []).length === 0 ? (
          <div className="nx-muted">Nothing recorded yet.</div>
        ) : (
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
        )}
      </section>

      {usage ? (
        <section className="sidebar__section">
          <div className="sidebar__section-title">Master</div>
          <div className="kv">
            <span className="kv__k">agent</span>
            <span className="kv__v">{activeAgent?.name ?? "Global Master"}</span>
            <span className="kv__k">provider</span>
            <span className="kv__v">
              {masterState.data?.runtime.providerName ?? masterState.data?.runtime.client}
            </span>
            <span className="kv__k">model</span>
            <span className="kv__v">{masterState.data?.runtime.model || "—"}</span>
            <span className="kv__k">client</span>
            <span className="kv__v">{masterState.data?.runtime.client}</span>
            <span className="kv__k">questions</span>
            <span className="kv__v">
              {masterState.data?.questionsAsked} / {masterState.data?.maxQuestions}
            </span>
            <span className="kv__k">tokens</span>
            <span className="kv__v">
              {usage.inputTokens + usage.cacheReadTokens} in · {usage.outputTokens} out
            </span>
            <span className="kv__k">cost</span>
            <span className="kv__v">{formatUsd(usage.costUSD)}</span>
          </div>
        </section>
      ) : null}
    </>
  );
}
