# 0026 — Editable agent profiles with safe credential rotation

## Context

Agent profiles could be created, toggled, archived, and permanently deleted, but nothing after
creation could change identity, harness, runtime overrides, or provider settings. A wrong handle,
model, base URL, or reasoning effort forced a delete-and-recreate, which orphaned task references
and history. Custom Master API keys were also all-or-nothing: an existing key could not be replaced
in the same form, and users had no explicit way to remove a stored key without deleting the agent.

Transcripts are append-only and immutable, so editing must never rewrite history. Dispatch and
deletion already protect running, queued, and reserved agents with a tombstone; profile editing
needs the same exclusion so a live run never reads a half-written configuration.

## Decision

Extend `PATCH /api/agents/:id` (already used for enable/archive toggles) to accept profile
configuration with a strict update schema. Kind, workspace, and ID are omitted from the schema and
rejected as unknown fields, keeping every transcript address stable. Worker edits cover name,
handle, description, instructions, harness, model, and reasoning effort; empty model or reasoning
effort values are sent as `null` and clear the fields. Master edits cover the shared identity
fields, access mode, and the full provider configuration.

Custom provider updates follow write-only credential semantics. An omitted or blank API key keeps
any stored key; a new non-blank key rotates it; `removeCredential: true` removes it explicitly and
cannot be combined with a new key in the same request. The store writes the credential file first
and rolls it back if the public state write fails, and never includes key material in `state.json`
or API responses. Profiles are validated with the same provider and field rules as creation.

Configuration edits reuse the deletion tombstone through `beginAgentMutation`. A PATCH that changes
any field other than `enabled` or `archived` is rejected while the agent is busy, queued,
reserved, or already being changed. Enable/archive toggles alone keep their previous lock-free,
best-effort behavior. The Agents surface gets an Edit action and dialog that shows current values,
keeps an existing key masked, and offers explicit removal.

## Consequences

Users can fix profiles and rotate or remove credentials without losing tasks or history. Handle
uniqueness is re-checked per workspace on update, and immutable identifiers cannot be sneaked past
the strict schema. Credential rotation cannot leave a new key without matching metadata or remove
a key while metadata still claims it exists. A configuration change cannot race dispatch or
deletion, and config edits between two concurrent changes serialize with a clear conflict.

Known limits: the API key remains write-only and the UI never reveals the stored value; profiles
cannot change kind or workspace; and atomicity spans two files only through the credential-first
write plus rollback, not a filesystem transaction.

## Status

Accepted for Milestone M9. Extends agent deletion and activity-protection rules from ADRs 0002 and
0011.
