import type { Approval, Task } from "@nexestra/core";
import { Button, StatusDot, Tag } from "@nexestra/ui-kit";
import { formatDateTime } from "../lib/format.js";

/** Short, plain-English gloss per approval kind — the queue has no room for prose. */
const KIND_HINT: Record<Approval["kind"], string> = {
  spec: "Freezes this version of the spec and lets planning start.",
  sandbox_escalation: "A run asked for full filesystem and network access.",
  spend: "The thread passed 80% of its budget.",
  merge: "A verified task branch is ready to land on the base branch.",
  manual_verification: "An acceptance criterion has to be checked by a human.",
  permission: "A harness is asking permission mid-run.",
  destructive: "A destructive operation is waiting for a decision.",
};

export interface ApprovalQueueProps {
  readonly approvals: readonly Approval[];
  /** Used to name the task an approval belongs to instead of showing its id. */
  readonly tasks?: readonly Task[];
  readonly busyId?: string | null;
  readonly onResolve: (approvalId: string, status: "approved" | "rejected") => void;
  /** Rendered when nothing is pending. */
  readonly emptyLabel?: string;
}

/**
 * Every pending approval in the workspace, of every kind, in one place.
 *
 * The Chat surface still shows the *suspending* approval above the composer —
 * the one the Master's turn is blocked on — but the orchestrator raises gates
 * from four other places (sandbox escalation, spend, merge, manual
 * verification, and a harness asking mid-run), and a user who is looking at the
 * Task Board or the Editor must not have to go hunting for them. So this panel
 * lives in the navigation column, where it is visible from every surface.
 *
 * Resolving is one gesture: `POST /api/approvals/:id/resolve` records the
 * decision, resumes a Master turn suspended on it, and releases the
 * orchestrator's gate — which is waiting on the store's own `approval.resolved`
 * event, so it does not matter who resolved the row.
 */
export function ApprovalQueue({
  approvals,
  tasks = [],
  busyId = null,
  onResolve,
  emptyLabel = "nothing waiting on you",
}: ApprovalQueueProps) {
  const pending = approvals.filter((approval) => approval.status === "pending");
  const titleOf = (taskId: string | undefined) =>
    taskId ? (tasks.find((task) => task.id === taskId)?.title ?? taskId) : undefined;

  if (pending.length === 0) {
    return (
      <section className="approval-queue" aria-label="Approval queue">
        <div className="nx-muted">{emptyLabel}</div>
      </section>
    );
  }

  return (
    <ul className="approval-queue" aria-label="Approval queue">
      {pending.map((approval) => {
        const task = titleOf(approval.taskId);
        return (
          <li key={approval.id} className="approval-queue__item">
            <div className="approval-queue__head">
              <StatusDot tone={approval.risk === "high" ? "error" : "warn"} />
              <span className="approval-queue__title">{approval.title}</span>
            </div>
            <div className="approval-queue__meta">
              <Tag tone={approval.risk === "high" ? "danger" : "warn"}>{approval.kind}</Tag>
              {task ? <Tag tone="info">{task}</Tag> : null}
              {approval.runId ? <Tag>{approval.runId}</Tag> : null}
              <span className="nx-muted">{formatDateTime(approval.requestedAt)}</span>
            </div>
            <div className="approval-queue__body">
              {approval.description || KIND_HINT[approval.kind]}
            </div>
            <div className="approval-queue__actions">
              <Button
                tone="primary"
                boxed
                disabled={busyId === approval.id}
                onClick={() => onResolve(approval.id, "approved")}
              >
                Approve
              </Button>
              <Button
                tone="danger"
                boxed
                disabled={busyId === approval.id}
                onClick={() => onResolve(approval.id, "rejected")}
              >
                Reject
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
