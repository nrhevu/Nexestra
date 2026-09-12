# Whiteboard workspace export research — 2026-09-12

The Whiteboard is workspace state rather than browser-only scratch text, so the existing export
workflow should preserve it. The export pipeline already snapshots files under a write barrier,
validates identities before and after streaming, and redacts text using the captured credential
set. Reusing those guarantees avoids a second backup path.

Whiteboard notes are a distinct `whiteboard` manifest kind because they are UTF-8 text that must be
redacted, unlike original document and upload binaries that are preserved byte-for-byte or rejected
when they contain a known credential. Missing whiteboards are omitted; saved notes are capped by
the same 64 KiB limit enforced by the surface API.

This is an implementation decision. Import and restore remain separate product work.
