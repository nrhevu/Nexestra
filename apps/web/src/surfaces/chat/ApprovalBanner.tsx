import type { Approval } from "@nexestra/core";
import { Button, StatusDot, Tag } from "@nexestra/ui-kit";

export interface ApprovalBannerProps {
  readonly approval: Approval;
  readonly busy?: boolean;
  readonly onResolve: (status: "approved" | "rejected") => void;
}

/**
 * The gate between clarifying and planning.
 *
 * It sits above the composer rather than in the sidebar because the Master's
 * turn is *suspended* on it: until the user decides, typing achieves nothing.
 * Resolving it both records the decision and resumes the turn — one gesture,
 * not two.
 */
export function ApprovalBanner({ approval, busy = false, onResolve }: ApprovalBannerProps) {
  return (
    <section className="approval" aria-label="Approval required">
      <div className="approval__head">
        <StatusDot tone={approval.risk === "high" ? "error" : "warn"} />
        <span className="approval__title">{approval.title}</span>
        <Tag tone={approval.risk === "high" ? "danger" : "warn"}>{approval.kind}</Tag>
      </div>
      {approval.description ? <div className="approval__body">{approval.description}</div> : null}
      <div className="approval__actions">
        <Button tone="primary" boxed disabled={busy} onClick={() => onResolve("approved")}>
          Approve
        </Button>
        <Button tone="danger" boxed disabled={busy} onClick={() => onResolve("rejected")}>
          Reject
        </Button>
      </div>
    </section>
  );
}
