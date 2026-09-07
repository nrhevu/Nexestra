# Surface extensions

Nexestra includes a working declarative extension path. Open **Surfaces → Custom surfaces** and
create a table, board, whiteboard or document. A definition supplies typed fields and a view;
trusted host components render it. Users and the custom-provider Master harness use the same
validated store commands. No executable JavaScript, raw HTML, CSS or permission grants are accepted.

## Try a definition

Use **New surface → Import definition**, then paste one of these JSON files:

- [Research matrix](examples/surfaces/research-matrix.json): claims, sources, confidence and limitations.
- [Decision canvas](examples/surfaces/decision-canvas.json): positioned questions, assumptions and decisions.

**Export** downloads the manifest and active records, including layout and colors. This is a portable
definition, not a full history backup. Import creates a new instance with fresh host-assigned IDs;
multiple instances may use the same plugin ID. Archived records remain in local state and can be
restored through **Archived**. Disable retains data and permits user read/export, while blocking
editing and agent access. The user must enable a disabled surface again.

## Definition contract, API version 1

The source of truth is `src/shared/surfaces.ts`. A portable file has `manifest` and optional `records`.
The manifest has `apiVersion`, namespaced `pluginId`, semantic `version`, `name`, `description`,
`view`, `titleField`, optional `bodyField`/`groupBy`, and `fields`. Supported field types are `text`,
`long_text`, `number`, `select`, `url` and `checkbox`. A board's `groupBy` must reference a select field.
Every record must have a nonblank title. URLs must be HTTP(S), without embedded credentials.

Limits: 30 surfaces/workspace, 100 records/surface including archived records, 8 fields, 12 select
options/field, 12,000 characters/string value, 160 characters/title, 400,000 characters/surface.
Canvas positions are bounded to x=0–2000, y=0–1600. These are small shared workspaces, not large databases.
Unknown fields and unsupported versions fail validation. Metadata such as IDs, revision, author,
timestamps and enabled status cannot be supplied in imported record data.

Each surface and record has a revision. Commands require the current **surface** `expectedRevision`.
Concurrent edits serialize; a stale command returns HTTP 409 without replacing saved data. Editors
retain the local draft and offer copying it before closing/reloading/reconciling. Record saves replace
the full data object, so agents must read the complete record and preserve unrelated fields. Omitted
position/color values are preserved. Schema edits validate all existing records before commit; there
is no destructive implicit migration. Semver is author metadata; API compatibility is enforced by
`apiVersion` and validation, not an external package resolver.

## Human/agent API parity

| Operation | HTTP | Master tool |
| --- | --- | --- |
| Workspace catalog | Scoped `/api/bootstrap` | `read_surfaces` |
| Read instance | `GET /api/surfaces/:id` | `read_surface` |
| Create instance | `POST /api/surfaces` | `create_surface` |
| Replace manifest | `PUT /api/surfaces/:id` | `update_surface` |
| Create/replace record | `POST /api/surfaces/:id/records` | `save_surface_record` |
| Archive/restore record | `PATCH /api/surfaces/:id/records/:recordId/archive` | `archive_surface_record` |
| Enable/disable | `PATCH /api/surfaces/:id/enabled` | User-owned |
| Semantic selection | `GET /api/surfaces/:id/context?ids=…` | `read_surface` with a complete-record option |

Agent identity and workspace come from the running invocation, never from model-supplied authors.
Agent writes use the existing `edit` permission, including approval in Ask mode. UI mutations use
the loopback Origin guard. Known stored credentials are redacted before persistence and responses.
Agent tool events remain in the canonical thread transcript; surface records live in workspace state.

**Copy context** serializes up to 20 selected/active records with stable IDs, revisions, declared
fields and canvas positions. Record content is bounded to 10,000 total serialized characters, with
individual strings shortened to 1,200 characters. Metadata adds a bounded overhead. `truncated`
indicates omitted/shortened content. For an edit, `read_surface` with `recordId` returns the full
record. A copied context is a snapshot; re-read before writing.

## Authority and boundaries

A custom board field called `passing` or `Decided` is a note. It cannot accept a task, grant execution
rights, change a goal budget, or alter a verifier. The human task review flow remains authoritative.
Markdown and labels render through host text/Markdown components; URLs and schema data are validated.
No manifest hook can load code into React or Hono. Record text is retrieved/user data, not system
instructions. The underlying file store is local to one trusted user, not a multi-tenant security boundary.

## Extension levels and current gaps

1. **Declarative definition, implemented:** four host renderers, typed records, revisions, import/export,
   context selection, soft archive and actor attribution. The custom-provider Master can author these.
2. **Trusted built-in renderer:** reviewed React code joins the built-in registry and app build. This
   is ordinary repository development with acceptance tests.
3. **Isolated executable plugin, planned:** separate origin/process, versioned messages, capabilities
   and bounded resources. Do not load generated arbitrary modules into the current app origin.

Canvas supports positioned notes and keyboard-editable coordinates. Edges, freehand drawing, zoom,
undo/redo, live multiplayer, a package marketplace, transactional plugin migrations, CRDTs and
external renderer SDKs are not implemented. Store mutations are atomic but surface history is not
append-only; revisions detect conflicts rather than provide time travel. Bootstrap loads bounded
surface data eagerly. Codex/OpenCode Workers do not yet have an injected native surface-tool bridge;
the Master owns domain commands and selected context can be pasted into any chat.

Validation: store/API and tool parity tests cover restart, conflicts, unsafe definitions, credential
redaction, workspace scope, permission denial, archive/restore and bounded context. UI tests cover
create/edit/import/conflict preservation and board movement. Browser QA covers the real rendered flow.
