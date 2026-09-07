# ADR 0021: durable, review-driven goals

Status: accepted, implemented.

## Problem

Task execution had durable outputs and human acceptance, but the user still needed to prompt each
step. Model-only continuation could lose scope, reset budgets after a crash, or mistake a final
answer for success. Research/design/writing checks often require human judgment today.

## Decision

Add a persisted goal with a frozen ordered task scope, current brief snapshot, Worker/repository
references, attempt limit, original elapsed-time deadline and bounded checkpoint history. Drafting
is distinct from user-owned Start/Resume. The store atomically charges each attempt together with
assignment admission and enforces task ownership. One active goal per workspace runs WIP=1.

The controller advances on assignment and review events. Completed execution waits for independent
human review; acceptance advances, changes requested retries within budget, and process failure
blocks for explicit repair. Only matching immutable reviews can complete the goal. Paused reviews
can update evidence/completion without starting work. A deadline interrupts an active assignment.

Startup marks interrupted assignments and pauses goals rather than guessing whether effects are
safe to repeat. Resume retains all attempt usage and the original deadline. Master tools may read
and draft goals but cannot activate them or grant new budgets. Draft-goal handoff removes the old
immediate-delegation obligation; direct Master delegation cannot bypass that draft's user gate.

## Consequences and limits

This supports continuous general work while keeping the evaluator outside the generator. It is
not fully autonomous verification. Time includes pauses and review; budgets are attempts/time,
not tokens/currency. Existing provider/run limits remain separate. Cross-thread goals, graphs,
resource lock scheduling, automatic external-effect reconciliation and a durable cost ledger are
future work. Agent profiles/repository readiness are resolved at dispatch; the selected profile IDs
are fixed. Update: [ADR 0025](0025-assignment-execution-profiles.md) adds per-assignment configured
profile snapshots; resolved runtime/model identity and an exact execution ledger remain unimplemented.

The single-user file store and serialized writes protect app-level invariants, not arbitrary
full-access processes or multiple server owners. Checkpoint history retains the latest 200 entries;
thread run/tool transcripts remain append-only. No restart replay or exactly-once external effect
guarantee is claimed. See [Goals](../GOALS.md) for the user flow and acceptance scenarios.
