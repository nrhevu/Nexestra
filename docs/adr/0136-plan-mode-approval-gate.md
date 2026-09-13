# ADR 0136: Gate plan-mode dispatch on durable approval

- Status: Accepted
- Date: 2026-09-13

## Context

Plan mode previously changed prompt guidance only. A custom-provider Master could create Taskboard
tasks and immediately delegate them in the same invocation, leaving no durable review point between
planning and execution. Pausing and resuming an exact provider invocation is not yet safe because
provider context and pending callbacks are process-local.

## Decision

Plans created by a custom-provider Master while thread plan mode is active persist
`planApproval: pending` on every plan task. Pending or rejected plan tasks are excluded from ready
dispatch and rejected by both automatic and manual delegation. Taskboard shows the plan approval
state and workspace-scoped Approve/Reject actions backed by `PATCH /api/plans/:planId/approval`.
Approval updates every task in the plan atomically and is refused while that plan has a queued or
running assignment. Rejected plans may later be approved. Legacy plans, manual tasks, and plans
created with plan mode off retain the existing autonomous behavior.

The provider tool loop treats pending approval as a terminal review outcome instead of issuing the
undelegated-task corrective prompt. After approval, the user dispatches tasks from the existing
Taskboard process dialog.

## Consequences

Plan mode now provides a durable human checkpoint without keeping a provider connection or callback
alive. Approval metadata survives restart and workspace export/import, and plan summary exports carry
the review state. Automatic resumption of the original Master invocation and automatic post-approval
dispatch remain future work.
