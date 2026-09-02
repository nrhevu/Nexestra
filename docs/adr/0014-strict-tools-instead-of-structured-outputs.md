# 0014 — Strict tool schemas instead of structured outputs

## Context

PLAN.md §2 planned structured outputs for the Spec and the Plan. In practice a
structured output cannot be combined with a tool call in the same turn, and the
planning turn needs both: the model reads the workspace, records memory, *and*
proposes the plan.

## Decision

Every tool is declared with `strict: true` and `additionalProperties: false`,
and the JSON Schema is derived from the zod schema by `toStrictJsonSchema()` —
not by the SDK's `transformJSONSchema`, which demotes `enum` and `const` into
prose and would drop exactly the constraints worth enforcing.

`output_config.format` remains plumbed through `LlmRequest` but unused.

## Consequences

- `propose_plan` input arrives schema-valid, and the same zod schema validates
  it again on the way in — the model cannot invent a task field or a status.
- The schema map is built in a fixed order so the cached prompt prefix stays
  byte-identical across turns ([0007](0007-master-on-claude-opus-5-messages-api.md)).
- Schema strictness and stability are asserted in tests, so a zod change that
  loosens a tool fails the build rather than the run.

## Status

Accepted; amends PLAN.md §2. Implemented in
`packages/master/src/tools/json-schema.ts`,
`packages/master/src/tools/schemas.ts`,
`packages/master/src/tools/definitions.ts`. Proved by
`packages/master/src/tools/tools.test.ts`. `docs/master.md` §6, §10.
