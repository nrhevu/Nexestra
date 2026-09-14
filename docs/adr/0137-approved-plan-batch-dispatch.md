# ADR 0137: Dispatch eligible approved plan tasks sequentially

- Status: Accepted
- Date: 2026-09-14

## Context

ADR 0136 creates a durable approval checkpoint for plan-mode work, but approval leaves each task to
be opened and delegated separately. A plan can contain several independent tasks that are safe to
start after review. A new bulk endpoint would duplicate the existing assignment path, including its
canonical user message, current plan state, dependency, Worker, and repository checks.

## Decision

An approved Taskboard plan may expose **Dispatch ready tasks** when it has eligible work. Before
queuing anything, the user chooses one enabled Worker and one ready repository and reviews the
current task list. Eligible tasks belong to the plan, are `todo`, have no assignment history, and
have every persisted prerequisite already `done`.

The browser calls the existing `POST /api/tasks/:taskId/delegate` endpoint once per displayed task,
in order. It stops on the first refusal, refreshes the Taskboard, and retains a partial-result error
in the dialog. The endpoint remains authoritative and creates the canonical user message for each
successful delegation. This action neither resumes the Master run that created the plan nor queues
work whose dependencies have not completed.

## Consequences

Approved independent work can start with one explicit confirmation while retaining the existing
durable audit trail and dispatcher validation. A stale browser projection can produce a partial
batch, which is shown immediately and reconciled by refresh. The batch uses one Worker and
repository, has no retry control, and does not automatically dispatch newly unblocked dependencies.
