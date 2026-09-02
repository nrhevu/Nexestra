# 0001 — Fresh local-first agent chat with shared thread logs

## Context

The pre-M9 repository spread the initial product across many domain, event-store, orchestration,
adapter and UI packages before the core agent-creation and mention-driven chat workflow felt
coherent. The M9 request explicitly replaces that codebase and prioritizes those two workflows.

## Decision

Rebuild around one Hono server, one React SPA and one shared contract module. Keep durable metadata
in an atomically replaced JSON file and keep each thread's messages and agent-run states in exactly
one append-only JSONL log. Persist a user message before dispatch, dispatch only resolved explicit
mentions, serialize work per agent, and never parse agent-authored messages for new triggers.

Represent agents as a discriminated union: Worker selects Codex/OpenCode; Master selects ChatGPT
OAuth through Codex CLI or a custom OpenAI-compatible provider. Store custom credentials separately
and never own ChatGPT OAuth tokens.

The implementation is in `src/server/store.ts`, `src/server/dispatcher.ts`,
`src/server/runtime.ts`, `src/server/auth.ts` and `src/web/App.tsx`.

## Consequences

The primary workflow has few moving parts, can be tested without paid services, and gives every
participant identical thread context. JSONL replay and per-agent in-process queues are enough for
a single local server, but multi-process coordination, streaming, autonomous task execution and
stronger sandboxing remain future work.

## Status

Accepted for Milestone M9.
