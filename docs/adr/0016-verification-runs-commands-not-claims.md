# 0016 — Verification runs commands; the harness's final message is never evidence

## Context

A harness's closing message reliably says the work is done. That statement is
generated text, not a fact, and the whole product promise is "until the result
has been **verified**".

## Decision

Every acceptance criterion carries a `verification`: a `command`, a `test`, or
`manual_review`. The orchestrator runs the command itself, in the task's
worktree, through `execa` with a shell, a timeout and captured output. The exit
code decides. A `manual_review` criterion raises an approval and waits for a
human — it is never auto-passed.

Every criterion produces an **evidence artifact** (criterion, command, exit
code, duration, stdout, stderr), and the outcomes are written back onto the
published spec in a single version bump.

## Consequences

- A task reaches `done` only when its criteria ran and passed; the phase guard
  for `all_criteria_verified` requires every criterion to carry an
  `evidenceArtifactId`, and `mark_criterion` refuses to satisfy one without it.
- The harness's `final` message still becomes a `log` artifact — as a record of
  what it said, not as proof.
- A failing criterion feeds its actual stdout/stderr back into the retry
  instructions, which is far more useful to the next attempt than "it failed".
- `runVerification` through the Master's `ExecutionHost` does **not** wait on a
  `manual_review` approval — it raises it and reports the criterion as not yet
  passed, so a model turn cannot hang on a human. The pipeline does wait.

## Status

Accepted. Implemented in `packages/orchestrator/src/verification.ts`,
`packages/orchestrator/src/artifacts.ts`,
`packages/master/src/phase.ts` (the `all_criteria_verified` guard). PLAN.md §9;
`docs/orchestrator.md` §3.8.
