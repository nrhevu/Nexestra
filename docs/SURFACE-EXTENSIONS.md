# Surface extension contract

## What exists today

Built-in navigation metadata is registered in `src/web/surfaces/registry.ts`: stable ID, label,
description, icon and scoped count. The router, sidebar and command palette consume that catalog.
Built-in React renderers are composed explicitly in `App.tsx`. Work Briefs is a separate component
using the shared HTTP contract. A route alone does not load or execute external code.

This is a first extension seam, not a complete plugin SDK. External manifests, declarative views,
plugin installation and sandboxed custom renderers remain subsequent work. The contract below
defines the intended direction and acceptance requirements.

## Responsibilities

A surface presents domain data and user decisions. It must not create an independent task database,
directly mutate `state.json`, invoke a CLI itself, or decide that a task passed. Chat and tools
operate through the same commands as the surface, with actor identity supplied by the host.

The surface host provides:

- Scoped queries and subscriptions, with bounded results and pagination.
- Typed domain commands with actor capabilities, expected revision and idempotency key.
- Artifact previews, links, selections and host-managed navigation.
- A bounded semantic context export: selected objects, relationships and pending edits. The agent
  receives meaning and stable IDs, not only a screenshot.
- Standard error, loading, empty, conflict, offline and permission states.
- Cleanup when a surface is closed or disabled.

Layout and selection are view-local. Moving a whiteboard card changes layout; resolving its
decision changes a domain object. Preserve the distinction.

## Proposed manifest

This example is illustrative, not an installable manifest in the current release.

```json
{
  "apiVersion": 1,
  "id": "local.research-matrix",
  "version": "0.1.0",
  "name": "Research matrix",
  "description": "Compare claims, sources and open questions",
  "view": { "kind": "table", "schema": "claim-matrix-v1" },
  "capabilities": ["knowledge.read", "artifacts.read", "surface.records.write"],
  "context": { "selection": true, "maxItems": 40, "maxCharacters": 12000 }
}
```

Stable IDs must be namespaced. Manifest and record schema versions are separate. Reject unknown
required capabilities, duplicate IDs, unsupported versions and invalid references with actionable
errors. Bound manifest size, nesting, records and exported context. Migrate on a copy, preserve prior
versions and report failures without breaking unrelated surfaces.

## Three extension levels

1. **Declarative surface.** Tables, boards, documents, forms and a constrained canvas use trusted
   host components. A model drafts manifests and records. Text renders safely, edits use revisions,
   actions come from host commands. No JavaScript evaluation, raw HTML, arbitrary CSS, remote script
   or generated SQL is necessary.
2. **Trusted built-in renderer.** A reviewed React module adds a richer view through the app build,
   receiving the scoped API rather than store internals. This is repository development with tests.
3. **Isolated executable plugin.** A future renderer runs in a separate origin/sandboxed frame with
   a versioned message protocol, CSP and validated capabilities. Backend code runs out of process
   with bounded resources. Do not import unreviewed generated modules into Hono or grant access to
   the credential store.

Prove human/agent parity with level 1 before building level 3. Existing custom/MCP tools have a
separate trusted-code model; they are not automatically safe UI plugins.

## Generated surface workflow

The coordinator identifies a concrete need and reuses a known surface when possible. Otherwise it
drafts a manifest, schema, sample records and context export. Validation checks compatibility,
bounds, references and capabilities; a preview allows actual interaction. Activation follows the
workspace's existing authorization. If additional rights are required, ask for those exact rights
with the preview ready. Plugins cannot approve their own capabilities or change verifier ownership.
Disabling removes dispatch rights immediately; data remains exportable.

## Acceptance scenarios

- A human edit and the next agent read share record ID, content and revision.
- Late agent updates conflict and retain the user's version.
- Invalid plugins are rejected while existing surfaces and chat still work.
- Useful agent context can be exported without browser automation.
- `artifacts.read` cannot grant shell execution or other unrelated capabilities.
- XSS in labels, Markdown, links and records displays safely or is rejected.
- Disabled extensions stop receiving events and executing commands.
- App reload restores data and supported layout without rerunning creation.
- A board edit or custom field named `passing` cannot accept a work unit.
- Keyboard focus and small-window layouts remain usable.
