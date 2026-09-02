# 0023 — Reusable agent profiles select Master providers and worker harnesses

## Context

Milestone M8 made Master providers configurable, but the selected provider was
still machine-wide. Tasks stored raw harness configuration independently, and
the web shell had no real agent directory. This made a displayed agent name an
affordance rather than a reusable, callable configuration.

Users need two different kinds of agent. A Nexestra agent owns research,
design, planning and project memory through the in-process Master. A Codex or
OpenCode agent owns implementation work delegated as a task. The two kinds
must not be interchangeable because only the Master speaks to provider APIs,
while worker harnesses own their own authentication and process protocol.

## Decision

Add `Agent` as an event-backed workspace entity. Every profile has a name,
description, persistent instructions, harness, optional model and enabled
state. The harness is a closed product choice:

- `nexestra` requires an enabled Master provider and an explicit model;
- `codex` and `opencode` may select a discovered harness model or leave it to
  the harness default, and cannot carry a Master provider id.

Threads and tasks contain nullable `agentId` references. Route validation
allows only a Nexestra agent on a thread and only a Codex/OpenCode agent on a
task. Assigned profiles cannot be deleted. The Master resolves a thread's
profile at the start of every request, overriding the global provider model
and appending its persistent instructions. The orchestrator resolves a task's
profile immediately before dispatch, overriding the task's harness, model and
instructions. Profile changes therefore affect future work without rewriting
historical messages, tasks or runs.

Provider setup exposes model discovery before creation and for saved
providers. Discovery uses the protocol's model-list endpoint and a write-only
credential; the secret is forwarded only to the provider and is never added to
persisted provider metadata or returned by the settings API. The configured
model remains a manual fallback when a compatible provider does not expose a
model catalogue.

## Consequences

- The Agents surface is the source of truth for reusable Master and worker
  profiles. Chat selects a Master profile; the Task Board assigns worker
  profiles.
- The Chat context shows the resolved agent, provider and model, so selection
  is observable before sending a paid request.
- Provider/model selection is durable and replayable. Credentials remain in
  the separate local credential store defined by ADR 0022.
- Model discovery assumes OpenAI-compatible `GET /models` or Anthropic
  `GET /v1/models`. Providers with a different catalogue can still use an
  exact manually configured model, but their full catalogue is not available.
- Profile editing has an API but the first Agents UI supports creation,
  assignment and deletion only.

## Status

Accepted in M8. Extends [0020](0020-production-master-provider-registry.md),
[0021](0021-slack-inspired-project-workspace.md) and
[0022](0022-local-provider-credential-store.md).

Implemented by `packages/core/src/domain/agent.ts`, migration `0003`,
`packages/storage/src/store.ts`, `apps/server/src/routes/agents.ts`,
`apps/server/src/master/llm.ts`, `apps/server/src/execution/runtime.ts`, and
`apps/web/src/surfaces/agents/`.
