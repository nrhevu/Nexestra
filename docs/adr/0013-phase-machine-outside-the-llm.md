# 0013 — The Master's phase machine lives outside the LLM

## Context

A long conversation makes a model forget process. Instructing it to "clarify,
then freeze the spec, then plan, then supervise" in a system prompt means the
whole loop depends on it remembering the instruction fifty turns later.

## Decision

The phase is a state machine **in code**. `nextPhase(current, trigger, context)`
is pure, exported and tested; every transition is guarded and an illegal one
comes back as `{ok: false, reason}` rather than being ignored. Only the current
phase's tools are sent to the model, and a tool name it has not been given comes
back as a `tool_result` error naming the phase.

## Consequences

- The gates are enforced where they matter: `propose_plan` is unavailable
  outside `planning` **and** rejected inside it while a question is open, the
  spec is unapproved, or there are no acceptance criteria. `mark_criterion`
  refuses to pass a criterion with no `evidenceArtifactId`. `ask_user` refuses
  once the six-question budget is spent.
- The orchestrator can push a transition without talking to the model:
  `applyTrigger("plan_accepted" | "all_tasks_done" | "all_criteria_verified" |
  "blocked" | …)`. The loop **never** writes `Thread.phase` itself; it reports,
  and the bridge translates.
- The prompts get shorter, because enforcement is not their job.
- Two spec copies exist by design: the draft wording in `master_state` (the
  Master's) and the published, validated copy in `specs` with the evidence the
  loop wrote (the orchestrator's). `loadState` folds the evidence back on every
  load, or a thread that proved everything could never reach `done`.

## Status

Accepted. Implemented in `packages/master/src/phase.ts`,
`packages/master/src/session.ts`, `packages/master/src/tools/definitions.ts`,
`apps/server/src/execution/runtime.ts` (the trigger bridge). Proved by
`packages/master/src/phase.test.ts`. PLAN.md §4, §9; `docs/master.md` §3.
