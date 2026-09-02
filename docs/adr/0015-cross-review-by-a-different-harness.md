# 0015 — Cross-review by a harness other than the executor

## Context

A model reviewing its own output tends to agree with it. The repository already
has two independent harnesses on two different model families
([0009](0009-drive-codex-with-exec-json.md),
[0010](0010-drive-opencode-with-serve-and-sse-over-fetch.md)).

## Decision

After a successful execute run, if a harness *other than* the executor is
registered, dispatch a read-only `kind: "review"` run against the uncommitted
diff in the same worktree. Findings of severity `critical` or `high` are
blocking: the task goes back to execute with them attached to the instructions.

## Consequences

- A review that fails to run is a **warning**, not a task failure. Verification
  ([0016](0016-verification-runs-commands-not-claims.md)) is the gate that
  decides; review is advice.
- With one adapter registered there is no reviewer and nothing is billed to a
  second model — which is what `NEXESTRA_HARNESSES=codex` is for.
- Review findings are normalised into one shape regardless of harness
  (`codex exec review` vs an OpenCode review prompt) and stored as a `review`
  artifact, so the retry instructions read the same either way.

## Status

Accepted. Implemented in `packages/orchestrator/src/review.ts`,
`packages/orchestrator/src/instructions.ts`,
`packages/adapters/codex/src/review.ts`,
`packages/adapters/opencode/src/review.ts`. PLAN.md §6;
`docs/orchestrator.md` §3.7.
