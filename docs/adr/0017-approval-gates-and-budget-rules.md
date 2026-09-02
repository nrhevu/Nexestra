# 0017 — Approval gates and budget rules

## Context

The loop spawns processes that edit a real repository and spend real money.
Everything it does is something the user could do themselves
([0001](0001-local-first-node-server-and-spa.md)), so the question is not
privilege but *intent*: which steps must the user actually mean.

## Decision

Five gates, all of them ordinary `Approval` rows so the same queue, the same
route and the same WebSocket carry them:

| `kind` | Raised when |
|--------|-------------|
| `sandbox_escalation` | A run asks for `danger-full-access` |
| `permission` | An MCP server or tool outside the allow-list, or a mid-run `permission_request` |
| `spend` | The thread passed 80% of its budget (once per engine) |
| `merge` | A verified task is ready to land, or an automatic merge conflicted |
| `manual_verification` | A criterion whose verification is `manual_review` |

Budget: 80% raises a `spend` approval and the loop keeps going; **100% pauses**.
The Master follows the same rule for its own token spend.

Merging is gated by default — `AppSettings.autoMerge` is `false`, which is the
answer PLAN.md §10.2 proposed. The orchestrator raises the `merge` approval and
stops; `apps/server` is what actually runs `mergeTaskBranch()` when the row is
approved, behind a single queue, and refuses rather than forces on a dirty tree
or a different checked-out branch.

## Consequences

- The loop waits by subscribing to the store's own `approval.resolved` event, so
  anything that resolves the row — the REST route, the UI, a test — releases it.
  It also means one process must own the store (`docs/orchestrator.md` §9).
- A rejection is a real outcome: the task goes to `blocked` and nothing is
  spawned.
- The queue is visible from every surface with a count badge on the rail,
  because a gate blocks a run wherever the user happens to be looking.
- An unknown model is priced at **zero** rather than guessed — a wrong number
  would pause a thread over money it never spent, and a visible `$0.00` is
  honest about not knowing.

## Status

Accepted. Implemented in `packages/orchestrator/src/approvals.ts`,
`packages/orchestrator/src/budget.ts`,
`packages/orchestrator/src/config.ts`,
`apps/server/src/execution/runtime.ts` (landing an approved merge),
`apps/web/src/shell/ApprovalQueue.tsx`,
`packages/core/src/domain/settings.ts`, `packages/core/src/pricing.ts`.
PLAN.md §4.2, §6, §10.2.
