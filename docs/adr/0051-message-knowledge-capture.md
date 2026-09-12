# ADR 0051 — Message-to-Knowledge capture

## Status

Accepted.

## Context

Nexestra's product brief calls for turning agent work into user knowledge rather than leaving
decisions buried in chat. Uploaded Knowledge documents retain revisions, but there was no shared
server path for capturing an existing message with its source identity.

## Decision

Expose `POST /api/knowledge/from-message` with thread/message IDs plus the new document's name,
handle, and description. The server reads the canonical message, checks workspace ownership, rejects
empty content, redacts known credentials, and creates an immutable Markdown document revision.
The document stores source thread and message IDs as provenance. No agent is invoked and the
original transcript remains unchanged.

## Limits

This endpoint is an explicit user/client capture operation, not an automatic summarizer or quality
judgment. The thread UI offers one-click capture with generated metadata; custom names and handles
remain available to API clients. It does not verify claims in the source message or preserve attached
binary files. Provenance identifies the source; it does not certify that the captured conclusion is
correct.
