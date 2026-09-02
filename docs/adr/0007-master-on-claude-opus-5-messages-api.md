# 0007 — The Master is Claude Opus 5 over the Messages API

## Context

The Master has to hold a long conversation, ask good clarifying questions, and
plan a DAG of work. The alternative considered in PLAN.md §10.1 was the Claude
Agent SDK, which arrives with its own file tools.

## Decision

`claude-opus-5` through `@anthropic-ai/sdk`'s Messages API, with a hand-written
tool surface. Adaptive thinking, streaming, `output_config.effort` (`high` while
planning, `medium` otherwise), prompt caching, `fallbacks: "default"` and
server-side compaction.

## Consequences

- The tool surface is exactly what the current phase allows
  ([0013](0013-phase-machine-outside-the-llm.md)) — an Agent SDK's built-in file
  tools would have let the Master edit code directly, which is precisely what
  the harnesses are for.
- Prompt caching needs a byte-identical prefix, so the volatile per-turn context
  (phase, spec digest, budget) goes into a *second* system block after the cache
  breakpoint and the tool list is built in a fixed order.
- Deliberately unused: assistant prefill and `budget_tokens` (both rejected on
  Opus 5), and forced `tool_choice` — the phase machine already constrains the
  model, and forcing a call would fight it.
- The client is one seam (`LlmClient`), which is what makes
  [0019](0019-demo-llm-client-without-an-api-key.md) and the key-free test suite
  possible.

## Status

Accepted. Implemented in `packages/master/src/llm/anthropic.ts`,
`packages/master/src/llm/types.ts`, `apps/server/src/master/llm.ts`.
PLAN.md §1.6, §4; `docs/master.md` §6.
