# 0002 — Single user, no auth, bound to loopback

## Context

v1 is one developer driving their own machine
([0001](0001-local-first-node-server-and-spa.md)). Adding accounts, sessions and
authorisation would be scope with no user.

## Decision

No authentication. The server binds `127.0.0.1` by default and every entity
carries a `workspaceId` but no owner.

## Consequences

- `NEXESTRA_HOST` exists so the bind address is a deliberate choice, not a
  hardcoded assumption — but the default never leaves the loopback interface.
- The `ANTHROPIC_API_KEY` stays in the server process; the browser learns only
  *whether* one is set, through `GET /api/health` and `GET /api/settings`.
- Adding auth later means adding an owner column and a middleware, not
  restructuring the domain model.

## Status

Accepted. Implemented in `apps/server/src/config.ts` (`HOST`, `PORT`),
`apps/server/src/master/llm.ts`. PLAN.md §1.2.
