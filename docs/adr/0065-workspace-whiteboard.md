# ADR 0065 — Workspace whiteboard

## Status

Accepted

## Context

The harness needs a lightweight surface for decisions, sketches, and short plans that should stay
close to the workspace without becoming a second conversation or an executable custom surface.
Keeping this content in browser state would make it hard to recover across devices or browser
profiles, while storing arbitrary files would weaken the local-first data boundary.

## Decision

Add a built-in Whiteboard surface backed by one Markdown file per workspace at
`<data-root>/workspaces/<workspace-id>/whiteboard.md`. The API exposes only workspace-scoped GET
and PUT operations. PUT redacts configured credentials before writing; GET redacts again before
returning content. Input and stored UTF-8 bytes are bounded to 64 KiB, writes are atomic and mode
`0600`, and non-regular or oversized files fail closed. The browser offers a plain textarea and an
explicit Save action. The surface has no agent dispatch, URL, HTML, or configured-code hooks.

## Consequences

The whiteboard survives reloads and workspace switching while remaining small and auditable. Its
Markdown is intentionally treated as notes: the current UI does not render it as rich HTML or
include it automatically in agent prompts. Workspace ZIP inclusion is defined separately by
[ADR 0066](0066-whiteboard-workspace-export.md).
