# ADR 0066 — Include whiteboard notes in workspace exports

## Status

Accepted

## Context

The Whiteboard is durable workspace planning state. Leaving it out of the existing workspace ZIP
export would make an export silently incomplete and weaken the user's ability to retain decisions
alongside conversations and Knowledge.

## Decision

When a workspace has a saved `whiteboard.md`, include it at the archive root as a `whiteboard`
entry. Capture happens under the existing export write barrier and source identity checks. The
entry is bounded to the Whiteboard's 64 KiB limit and its text is redacted with the credential set
captured at export preparation. The archive manifest and public entry schema identify the new
`whiteboard` kind. A workspace without saved notes has no empty placeholder entry.

## Consequences

Exports retain the user's planning notes with the same redaction and cancellation guarantees as
other text content. The source size budget includes the entry, and edits or replacement during
export fail as a source conflict. Import and restore remain unsupported.
