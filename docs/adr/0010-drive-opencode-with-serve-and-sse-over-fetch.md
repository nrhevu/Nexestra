# 0010 — Drive OpenCode with `opencode serve` + SSE, over plain `fetch`

## Context

PLAN.md §1.9 chose `opencode serve` (HTTP + SSE) driven through
`@opencode-ai/sdk`. When the adapter was written, the published SDK was version
`1.18.26` against a binary at `1.18.25`: the package and the server version
independently, the package publishes no README, and the surface the adapter
needs is about ten endpoints.

## Decision

Keep `opencode serve` — one server per workspace directory, sessions, permission
replies, `GET /event` for the stream — but **not** the SDK. The request surface
is hand-written from the recorded OpenAPI document
(`fixtures/opencode/openapi.json`) using Node 24's global `fetch`, and the SSE
framing is hand-rolled.

## Consequences

- No dependency that can drift from the binary; the adapter's compatibility
  claim is the recorded fixtures, which is the same claim Codex's adapter makes.
- The event stream is long-lived and must survive reconnects and unknown event
  types, both of which had to be hand-written anyway — the SDK would have owned
  the loop and not the tolerance.
- The adapter owns process lifetime: `dispose()` stops the servers it started,
  which is why `apps/server` calls it on `SIGINT` / `SIGTERM`.
- Revisit if the SDK stabilises around a v2 event stream.

## Status

Accepted; amends PLAN.md §1.9. Implemented in
`packages/adapters/opencode/src/client.ts`,
`packages/adapters/opencode/src/sse.ts`,
`packages/adapters/opencode/src/server.ts`,
`packages/adapters/opencode/src/mapper.ts`.
`docs/adapters/opencode.md` §1; `docs/harness-protocols.md` §2.
