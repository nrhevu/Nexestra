# 0018 — A fake harness adapter, and a `fake` harness id

## Context

The orchestrator's loop is the hardest part of the system to test and the most
expensive to run: it needs two coding CLIs, two logged-in accounts and real
tokens. CI has none of those, and neither does someone evaluating Nexestra for
the first time.

## Decision

Ship `@nexestra/adapter-fake`, a complete `HarnessAdapter` with nothing behind
it, and add `fake` to `HarnessIdSchema` so it can be registered like any other
harness. A run's behaviour is a **scenario** (`success`,
`retryable_failure_then_success`, `fatal_failure`, `permission_request`, `slow`,
`review_with_findings`, `review_clean`), resolvable from the task description
itself via a `[scenario: …]` marker.

`NEXESTRA_FAKE_HARNESS=1` (or `AppSettings.enableFakeHarness`) makes it stand in
for `codex` **and** `opencode` as well, so an existing plan runs unchanged.

## Consequences

- It writes **real files** into the real worktree, so `git diff`, the Editor
  surface and the acceptance-criteria commands all see a tree that genuinely
  changed. A fake that only emitted events would have tested the parser and
  nothing else.
- Nothing is hidden: `discover()` reports version `0.0.0-fake` and says in its
  warnings that it is a stand-in, and the Settings surface renders that.
- It is what makes `pnpm test` green with no harness installed, what the
  Playwright suite runs against, and what makes a no-quota demo mode possible at
  all.
- Deterministic ids, token counts and costs — the same `(taskId, kind, attempt)`
  always produces the same `sessionRef` and the same `usage`.
- `packages/orchestrator/src/fake-adapter.ts` is now only a re-export of
  `@nexestra/adapter-fake`, kept as the orchestrator's import path for the
  older, lower-level scripted API (`createFakeHarnessAdapter`) its own unit
  tests and the server's registry use. New code should import the package and
  prefer the scenario-driven `createFakeAdapter()`.

## Status

Accepted; amends PLAN.md §1.7 (`HarnessId` gains a fourth member). Implemented
in `packages/adapters/fake/src/adapter.ts`,
`packages/adapters/fake/src/scenarios.ts`,
`packages/orchestrator/src/fake-adapter.ts`,
`apps/server/src/execution/harnesses.ts`,
`apps/server/src/execution/fake-script.ts`. `docs/testing.md` §3.
