import { useState } from "react";
import { useApprovals, useResolveApproval, useTasks } from "../lib/api.js";
import { ApprovalQueue } from "./ApprovalQueue.js";

/**
 * The approval queue, wired to the workspace.
 *
 * It reads every approval in the workspace rather than only the open thread's:
 * a merge waiting on thread A is still waiting while the user is reading
 * thread B, and a queue that hides it is worse than no queue.
 */
export function ApprovalQueuePanel({
  workspaceId,
  threadId,
}: {
  workspaceId: string;
  threadId: string;
}) {
  const approvals = useApprovals(workspaceId);
  const tasks = useTasks(threadId);
  const resolve = useResolveApproval(workspaceId);
  const [busyId, setBusyId] = useState<string | null>(null);

  return (
    <>
      <ApprovalQueue
        approvals={approvals.data ?? []}
        tasks={tasks.data ?? []}
        busyId={resolve.isPending ? busyId : null}
        onResolve={(approvalId, status) => {
          setBusyId(approvalId);
          resolve.mutate(
            { approvalId, status, resolvedBy: "user" },
            { onSettled: () => setBusyId(null) },
          );
        }}
      />
      {resolve.isError ? <div className="form-error">{resolve.error.message}</div> : null}
    </>
  );
}

/** How many approvals in this workspace are still pending. */
export function usePendingApprovalCount(workspaceId: string): number {
  const approvals = useApprovals(workspaceId);
  return (approvals.data ?? []).filter((approval) => approval.status === "pending").length;
}
