# 0008 — Nexestra's own `HarnessAdapter` abstraction

## Context

Codex speaks JSONL on stdout from a one-shot process; OpenCode speaks HTTP plus
a long-lived SSE stream from a server. The orchestrator should not know the
difference, and a third harness should be an addition, not a rewrite.

## Decision

Define `HarnessAdapter` in `@nexestra/core` —
`discover()` / `prepare()` / `run()` / `control()` — over a normalised
`HarnessEvent` union and a `RunSpec` input. Every adapter maps its harness's
protocol onto that union and drops events it does not recognise rather than
crashing.

## Consequences

- `@nexestra/orchestrator` depends on the contract, never on an adapter package;
  the adapters are injected (`adapters: {codex, opencode, fake}`).
- The contract lives in `core`, so the browser can render a `HarnessEvent`
  stream with the same types the adapter produced.
- Unknown-event tolerance is a tested property, not a hope: every recording in
  `fixtures/` is replayed, including deliberately malformed lines.
- `acp` exists as an id with no adapter behind it. Adding one is a package, not
  a change to the contract.

## Status

Accepted. Implemented in `packages/core/src/harness.ts`,
`packages/core/src/domain/common.ts` (`HarnessIdSchema`),
`packages/adapters/codex/src/adapter.ts`,
`packages/adapters/opencode/src/adapter.ts`,
`packages/adapters/fake/src/adapter.ts`. PLAN.md §1.7, §5.
