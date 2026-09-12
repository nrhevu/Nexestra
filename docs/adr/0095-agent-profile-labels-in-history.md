# ADR 0095: Label run history by agent profile

Status: Accepted

## Context

Nexestra can compare heterogeneous Codex, OpenCode, and custom-provider runs, but a history row
previously identified an agent only by its user-facing name and handle. Names do not explain which
harness or model produced a result, especially when teams reuse a role name across workspaces.

## Decision

Run-history rows and the bounded per-agent summary expose two optional, read-time labels:

- `agentHarness`: `codex`, `opencode`, or `custom` (Master agents use `custom` as the provider-neutral label).
- `agentModel`: the configured model name, capped at 200 characters.

The labels are derived from the current workspace agent profile when history is read. Models pass
through the existing secret redaction before entering the response. Provider names, base URLs,
credentials, and transcript content are not returned. Unknown or deleted agents keep their
existing `Unknown` name and omit both labels. Because these are read-time projections, changing an
agent profile can relabel older rows; durable historical snapshots remain a future decision.

## Consequences

The monitoring surface can compare harnesses and models beside existing token, cost, and feedback
metrics without changing transcript format, pagination, cost calculations, or workspace isolation.
Consumers must treat both fields as optional for legacy responses and deleted agents.
