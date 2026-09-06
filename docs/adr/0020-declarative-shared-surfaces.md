# ADR 0020: shared declarative surfaces

Status: accepted, implemented. Supersedes the proposed-only level 1 extension path in ADR 0017.

## Problem

Research, design and writing need structured interaction beyond chat. A renderer per use case would
make every useful view a code deployment, while arbitrary harness-generated JavaScript in the app
origin would inherit the host's capabilities. Separate UI/agent state would lose shared understanding.

## Decision

Use a bounded manifest plus typed records, rendered by trusted table, board, canvas and document
components. Human API handlers and custom Master tools call the same store commands. The host supplies
workspace, authors, UUIDs and revisions; persistent writes honor `edit` permission. Whole-surface CAS
is deliberately simple for a single-user application with occasional concurrent agent edits.

Import/export supports reusable definitions and fresh instances. Enable/disable is user-owned.
Archiving preserves records. Incompatible schema edits are rejected before replacing data. Semantic
context includes selections and revisions; it is bounded and marked when truncated. Editing requires
a complete-record read. Custom fields cannot affect task acceptance or execution permissions.

## Consequences and limits

This creates a usable harness-authored extension path without a new execution engine. New view types
still require trusted code. There is no external plugin package runtime, history/undo, automatic
migration, CRDT, canvas edge/freehand engine, or injected Worker CLI tool bridge. Full state is loaded
in bootstrap within fixed surface limits. Whole-surface revision conflicts are conservative and can
occur for independent records; the UI retains the draft for reconciliation. Export includes active
records, not a complete archive/history backup. The single-user store is not an OS sandbox.

See [the extension contract](../SURFACE-EXTENSIONS.md) for executable examples and acceptance checks.
