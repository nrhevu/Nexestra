# ADR 0138: Review pending plan steps before approval or rejection

- Status: Accepted
- Date: 2026-09-14

## Context

ADR 0136 added a durable approval gate, but a compact plan summary exposed Approve and Reject
directly. The user could not inspect the plan's task descriptions, verification commands, or
prerequisites at the decision point. Opening every Taskboard process dialog makes a review slow and
does not present the plan as one coherent proposal.

## Decision

Pending and rejected plan cards expose **Review plan**. The read-only dialog projects only tasks in
the loaded selected workspace that belong to the plan. It shows each step's title, status,
description, optional verification command, prerequisite title/status when available, and an
explicit source-thread link. Missing prerequisites are marked unavailable rather than fetched from
another scope.

Approve and Reject controls move into that dialog and call the existing workspace-scoped approval
callbacks. The dialog creates no task, Knowledge document, assignment, provider call, or Master
resume state. Approved plans retain their existing explicit batch-dispatch action.

## Consequences

Plan approval becomes a reviewable decision without adding persistence or another API. The view can
only describe the browser's loaded snapshot, so a concurrent change can still be refused by the
existing approval endpoint. The dialog intentionally does not edit plan steps, compare plan
versions, or recover the original Master invocation.
