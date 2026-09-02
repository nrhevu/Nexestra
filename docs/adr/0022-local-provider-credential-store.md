# 0022 — Configure provider credentials in the app

## Context

ADR 0020 required users to put a provider key in the server environment and
then enter the environment-variable name in Settings. That kept the key out of
SQLite, but made a local desktop-style application unnecessarily difficult to
configure and forced a restart when the process environment changed.

Provider metadata still belongs in the event-backed settings row. Secret values
must not: a settings event carries full post-state, so putting a key there would
copy it into the append-only event log and every settings API response.

## Decision

Settings accepts provider credentials as write-only values. The server stores
them in `$NEXESTRA_HOME/credentials.json`, separate from SQLite, and atomically
replaces that file with mode `0600`. The REST API returns only a boolean for
credential presence; it never returns the value. A saved credential takes
effect on the next Master request without restarting the process.

Each provider has an explicit `api-key` or `none` authentication mode. `none`
is intended for trusted loopback endpoints. Removing a provider or changing it
to `none` removes its saved credential. The built-in providers require an API
key. Existing `apiKeyEnv` metadata and environment resolution remain a
lower-priority compatibility fallback, but the UI neither asks for nor edits an
environment-variable name.

The credential file is plaintext. Its security boundary is the local OS user,
the same boundary as the unauthenticated loopback Nexestra process. It is not
claimed to protect against the user's own processes, administrators, root, or a
compromised machine.

## Consequences

- A user can configure OpenAI, Anthropic or a custom provider entirely in the
  running application.
- Keys do not appear in SQLite, settings events, browser query state, health
  responses or settings responses.
- Backing up `nexestra.db` alone does not back up credentials. Copying the whole
  Nexestra home does, so that archive must be protected as secret material.
- Native OS keychain integration remains a possible future improvement. The
  current file-permission boundary is portable and does not add a native
  dependency to the Node server.

## Status

Accepted in M8. Amends the credential-storage portion of
[0020](0020-production-master-provider-registry.md).

Implemented by `packages/core/src/domain/settings.ts`,
`packages/core/src/api-http.ts`,
`apps/server/src/master/provider-credentials.ts`,
`apps/server/src/master/llm.ts`, `apps/server/src/routes/settings.ts`, and
`apps/web/src/settings/SettingsSurface.tsx`.
