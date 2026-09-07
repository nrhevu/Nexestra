# Durable goals

Goals turn a set of tasks into an explicit, bounded sequence. They work for research, documents,
design and code. A goal does not grade its own outputs: matching human task reviews decide whether
to continue, revise or stop. The current implementation is a review-driven loop, not an autonomous
verifier or a general graph scheduler.

## Use the complete workflow

1. Create tasks in one conversation. Each needs at least one observable success criterion and a
   concrete verification method. Prepare an enabled Worker and, for code, a ready repository.
2. Open **Surfaces → Goals → New goal**. State the desired outcome and select up to ten tasks in
   execution order. Each task may use a different Worker/repository. Set attempt and time limits.
3. Create a draft and inspect its scope. The server freezes task contracts and the current Work Brief
   if one exists. Later edits to the conversation's brief do not silently change this goal's context.
4. Click **Start goal**. The host persists an explicit user mention before every admitted assignment.
   One task runs at a time. Its output is captured and the goal waits for your review.
5. **Accept result** advances to the next task. **Request changes** sends the review feedback into
   another attempt on the same contract, if budget remains. A failed/interrupted run stops the goal
   for explicit repair/resumption; there is no automatic failure storm.

The Worker may report completed execution while its task is still In review. Only reviews against
the frozen task revision, with observations for every criterion, can count as acceptance. Captured
output hashes are checked by the task review gate. Goal completion records the accepted assignment
and review IDs for every scoped task. Manual task completion is not enough.

Tasks drafted from a saved Work Brief retain their own source snapshot; it supplies their brief
context while the goal's overall objective remains explicit. Other tasks use the goal's pinned
brief. New assignments also retain their configured Worker profile for later inspection, including
after profile deletion; runtime-resolved model identity is not inferred from that record.

## Limits and control

- At most one active/review-waiting goal per workspace; WIP=1 inside a goal. Different unrelated
  manual tasks can still run on different Workers, as in the existing dispatcher.
- Attempts are admitted assignments, including setup/provider failures and revisions. An attempt
  is charged atomically with assignment creation, never reset by pause/resume. Limits are 1–30,
  with at least one attempt allowed per selected task.
- Time limits are 1–240 minutes of elapsed wall time from the first start, **including pauses and
  human review time**. The original deadline is persisted; resuming does not grant fresh time.
  A server timer stops a running assignment at the deadline. A paused goal is checked on resume.
- These limits do not measure provider tokens, API billable spend or global account usage. Runtime
  process/output limits still apply independently. A richer cost ledger is future work.
- Pause stops active execution and retains outputs/reviews. Reviews can still update a paused
  checkpoint without starting new tasks. If the final matching review completes the whole scope
  before the deadline, the goal completes without needing an extra run.
- Cancel and exhaustion are terminal. Create a new goal to authorize new work; prior evidence stays.
  Accepted task/goal snapshots remain historical facts when later tasks are revised.
- Authorized goals own their tasks. Cancel the goal before changing/deleting its task contracts or
  assigning them manually. A Master cannot directly execute tasks reserved in a draft goal; the user
  must start the goal or explicitly start an individual task from Taskboard.

The goal's objective is displayed in the task process dialog so reviewers can check whether the
output still serves the intended outcome. This is a human checkpoint, not an automated assessment
of whether the overall objective was wise or complete.

## Recovery and fresh sessions

Goal scope, the brief snapshot, budgets, status, accepted review references and the latest 200
checkpoint events live in `state.json`. Run/tool/message history remains in the thread's canonical
JSONL. On startup, queued/running assignments become interrupted and active/review-waiting goals
become paused. Nothing is automatically replayed. Inspect the previous workspace and checkpoint,
then resume explicitly if appropriate. This includes ambiguous crashes after output production.

One Node server owns each data directory. Atomic file replacement and in-process serialized writes
do not implement a distributed transaction, OS process sandbox or exactly-once external side effect.
The server must remain running for ongoing execution/deadline timers. There is no separate daemon,
recurring scheduler or automatic restart/resumption service.

Custom-provider Masters use `read_goals` for compact checkpoints and `draft_goal` to propose a goal
from tasks already discovered/planned in the current thread. Draft authors and scope are host-bound.
Drafting removes those tasks from any execute-mode plan's immediate-delegation obligation, so the model
can finish explaining the draft without being forced into execution. No model tool can start, resume,
cancel, extend a budget or certify a goal. User HTTP controls share the loopback Origin guard.

## Implementation map and acceptance

- `src/shared/goals.ts`: contracts and deterministic continuation inspection.
- `src/server/store.ts`: atomic admission, budget/checkpoint state, ownership and recovery.
- `src/server/goal-controller.ts`: event-driven continuation, deadline timers and cancellation.
- `src/server/goal-tools.ts`: scoped proposal/discovery, without execution-control authority.
- `src/web/surfaces/Goals.tsx`: scope, budgets, checkpoints and review navigation.

Offline tests exercise duplicate starts, sequential review gates, feedback retries, failures,
pause/resume, deadline abort, restart without replay, changed/foreign scope, draft authorization,
brief pinning and HTTP review continuation. The UI has independent draft/control/conflict tests.
Provider quality, arbitrary external effects, executable verifier independence, token accounting,
cross-thread goals, branch/rollback graphs and full event-history pagination remain outside this slice.
