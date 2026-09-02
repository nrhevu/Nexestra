# 0020 — Production Master provider registry with no simulation fallback

## Context

Milestone M8 hardening changes Nexestra from a demonstrator into a control
center for real project work. The previous startup policy selected a scripted
`DemoLlmClient` when no Anthropic key existed, and production could replace
coding harnesses with `@nexestra/adapter-fake`. That made an unconfigured
installation look successful while producing work that no real model or
harness had performed.

The Master also needs to support OpenAI and compatible private endpoints, not
only one hard-coded Anthropic model. OpenAI's public API authenticates with API
keys or workload identity tokens; it does not document a third-party "Sign in
with ChatGPT" OAuth grant. Nexestra therefore cannot honestly exchange a
ChatGPT subscription login for API access.

## Decision

Persist a registry of Master provider metadata in `AppSettings`:

- provider id and display name;
- `openai-responses` or `anthropic-messages` protocol;
- base URL and model;
- the *name* of an optional server environment variable containing the secret;
- enabled state and the active provider id.

The server resolves this registry at the start of every Master turn, so a saved
provider change applies without a restart. Secrets stay in the process
environment and are never returned by the API or stored in SQLite. Remote base
URLs must use HTTPS; plain HTTP is accepted only for loopback-compatible local
providers. Provider URLs cannot embed credentials, query parameters or
fragments. The unauthenticated app server likewise rejects non-loopback bind
addresses.

The OpenAI client uses the Responses API with `store: false`, strict function
tools and request-id-aware errors. The built-in OpenAI provider defaults to
`chat-latest`; the model is editable, including `gpt-5.6`.

There is no production simulation fallback. Missing credentials produce an
explicit `configuration required` state and a failed Master turn. Production
registers only Codex and OpenCode adapters; fake adapters and deterministic
model clients remain test dependencies injected through existing seams.

## Consequences

- A fresh database is empty and an unconfigured Master never fabricates
  questions, specs, plans, costs or task results.
- OpenAI, Anthropic and protocol-compatible custom providers share one settings
  and runtime path.
- Changing a provider can change model semantics for an existing durable
  conversation. The canonical internal history is translated at the provider
  boundary, so no provider-specific transcript is persisted.
- `chat-latest` tracks the model used by ChatGPT's latest chat experience, but
  billing and authentication are OpenAI API concerns, independent of a ChatGPT
  subscription.
- The fake harness id remains in the additive core schema for old rows and test
  fixtures, but it is absent from production discovery and settings choices.

## Status

Accepted in M8. Supersedes [0007](0007-master-on-claude-opus-5-messages-api.md),
the production parts of [0018](0018-fake-harness-for-dev-and-tests.md), and
[0019](0019-demo-llm-client-without-an-api-key.md).

Implemented by `packages/core/src/domain/settings.ts`,
`packages/master/src/llm/openai.ts`, `packages/master/src/llm/anthropic.ts`,
`apps/server/src/master/llm.ts`, `apps/server/src/execution/harnesses.ts` and
`apps/web/src/settings/SettingsSurface.tsx`.

OpenAI references: [API authentication](https://developers.openai.com/api/reference/overview),
[`chat-latest`](https://developers.openai.com/api/docs/models/chat-latest), and
[latest-model guidance](https://developers.openai.com/api/docs/guides/latest-model).
